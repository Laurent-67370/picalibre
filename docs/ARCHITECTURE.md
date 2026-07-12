# PicaLibre — Clone Picasa desktop
## Architecture technique & schéma de base de données (v1.0)

---

## 1. Choix du framework : Electron vs Tauri

**Recommandation : Electron.** Justification :

| Critère | Electron | Tauri |
|---|---|---|
| better-sqlite3 | Natif Node, trivial | Réécriture Rust (rusqlite) |
| sharp/libvips | Natif Node, très performant | Sidecar ou crate Rust (image-rs, plus lent que libvips) |
| exiftool-vendored | Natif Node | Sidecar externe |
| TensorFlow.js / Human (visages) | tfjs-node ou WebGL dans le renderer | WebView uniquement, pas de backend natif |
| ffmpeg (vidéos, movies) | fluent-ffmpeg + binaire embarqué | Sidecar possible |
| Poids installeur | ~90–120 Mo | ~10 Mo |
| RAM | ~250–400 Mo | ~80–150 Mo |
| Compétences requises | 100 % JS/TS | Rust obligatoire pour le backend |

Tout l'écosystème critique du projet (sharp, better-sqlite3, exiftool-vendored, chokidar, fluent-ffmpeg) est **Node-natif**. Avec Tauri, chaque brique devient soit une réécriture Rust, soit un sidecar à orchestrer. Le gain de légèreté ne justifie pas ce coût pour un gestionnaire de photos qui, de toute façon, consommera de la RAM pour les miniatures et le décodage d'images. Electron + processus utilitaires bien isolés donne des performances largement suffisantes (c'est l'architecture de Figma, VS Code, Obsidian).

**Plan B** : si à terme la légèreté devient prioritaire, l'architecture proposée (moteur d'édition = DSL JSON indépendant de l'implémentation) permet de porter le backend en Rust sans toucher à l'UI.

## 2. Stack retenue

- **Shell** : Electron 33+, electron-vite, electron-builder (AppImage + .deb pour Linux/SteamOS, NSIS Windows, DMG macOS)
- **UI** : React 18 + TypeScript, Zustand (état global), TanStack Virtual (virtualisation des grilles de milliers de miniatures — indispensable)
- **Base de données** : better-sqlite3 (synchrone, WAL mode, transactions rapides) — exécutée dans le processus main uniquement
- **Images** : sharp (libvips) pour thumbnails + export ; décodage RAW via libvips (dcraw) en option phase 2
- **EXIF/GPS/XMP** : exiftool-vendored (processus exiftool persistant, lecture ET écriture)
- **Surveillance disque** : chokidar (watchers sur les dossiers scannés)
- **Hash** : xxhash-wasm (xxh3, ~10× plus rapide que SHA pour la détection de doublons ; SHA-256 optionnel pour vérification forte)
- **Visages** : @vladmandic/human (successeur maintenu de face-api.js, 100 % offline, backend WebGL ou WASM) — détection + embeddings 512-d + clustering maison
- **Carte** : MapLibre GL JS + tuiles OSM (avec cache disque des tuiles pour usage semi-offline)
- **Vidéo** : ffmpeg-static + fluent-ffmpeg (ffprobe métadonnées, extraction de frame pour miniature, encodage des "movies")
- **PDF/impression** : API d'impression Electron (webContents.print) + mise en page HTML/CSS

## 3. Architecture des processus

```
┌─────────────────────────────────────────────────────────┐
│ MAIN PROCESS (Node)                                     │
│  • Cycle de vie app, fenêtres, menus natifs             │
│  • DBService (better-sqlite3, seul accès à la DB)       │
│  • IPC router typé (contrat partagé TS)                 │
│  • FileWatcher (chokidar) → événements scan             │
│  • ExifService (exiftool-vendored, process persistant)  │
│  • ExportService (sharp : rendu final des éditions)     │
│  • FfmpegService (miniatures vidéo, movies)             │
└────────────┬───────────────────────────┬────────────────┘
             │ IPC (contextBridge)       │ MessagePort
┌────────────▼────────────┐   ┌──────────▼───────────────┐
│ RENDERER (React)        │   │ WORKER POOL              │
│  • Library / Albums     │   │ (utilityProcess Node ×N) │
│  • Éditeur (Canvas/WebGL│   │  • ScanWorker (récursif) │
│    preview temps réel)  │   │  • HashWorker (xxh3)     │
│  • Tray, carte, visages │   │  • ThumbWorker (sharp)   │
│  • Fenêtre cachée Human │   │  • FaceWorker (Human)    │
│    (détection visages)  │   │    ou fenêtre offscreen  │
└─────────────────────────┘   └──────────────────────────┘
```

Principes :
1. **La DB n'est touchée que par le main process** (better-sqlite3 est synchrone : jamais dans le renderer). Les workers renvoient leurs résultats au main qui écrit par lots (transactions de 500 lignes).
2. **Contrat IPC typé** : un fichier `shared/ipc-contract.ts` définit chaque canal (nom, payload, réponse). `contextIsolation: true`, `nodeIntegration: false`, preload minimal.
3. **Pipeline d'import en file** : Scan → Hash → EXIF → Thumbnail → (Faces en tâche de fond basse priorité). Chaque étape est une queue persistée en DB (table `jobs`) → reprise après crash/fermeture.

## 4. Moteur d'édition non destructive (cœur du projet)

### Principe
Le fichier original n'est **jamais** modifié. Chaque photo possède une pile d'opérations (edit stack) stockée en JSON dans la table `edits`, façon `.picasa.ini`/XMP.

### DSL d'opérations (extrait)
```json
{
  "version": 1,
  "ops": [
    { "id": "op-1", "type": "crop",       "params": { "x": 0.12, "y": 0.05, "w": 0.8, "h": 0.6, "ratio": "16:9" } },
    { "id": "op-2", "type": "straighten", "params": { "angle": -1.8 } },
    { "id": "op-3", "type": "fill_light", "params": { "value": 0.35 } },
    { "id": "op-4", "type": "temperature","params": { "kelvinShift": 300, "neutralPick": [0.52, 0.31] } },
    { "id": "op-5", "type": "filter",     "params": { "name": "lomo", "intensity": 0.7 } }
  ]
}
```
Coordonnées **normalisées 0–1** (indépendantes de la résolution : le même stack s'applique à la preview 1600 px et à l'export pleine résolution).

### Double implémentation du rendu
| | Preview (renderer) | Export (main) |
|---|---|---|
| Moteur | Canvas 2D + WebGL (shaders pour temp. couleur, fill light, filtres) | sharp/libvips |
| Objectif | Temps réel < 16 ms sur image réduite | Fidélité pleine résolution |
| Garantie de parité | Suite de tests : images de référence rendues par les deux moteurs, comparaison ΔE < seuil | idem |

C'est LE point dur du projet : chaque opération du DSL doit avoir deux backends équivalents. D'où l'importance de définir le DSL **avant** d'écrire le moindre outil d'édition.

### Undo/redo illimité
- Chaque modification crée une ligne dans `edit_history` (op ajoutée/modifiée/supprimée + stack résultant).
- Undo = pointeur `current_history_id` dans `edits`. Historique jamais purgé (option de compactage).
- "Revenir à l'original" = stack vide, l'historique reste.

### Cache de rendus
Preview éditée mise en cache disque (`cache/renders/{photo_hash}/{stack_hash}.webp`) → réouverture instantanée, invalidation automatique quand le stack change.

## 5. Miniatures et caches

```
{userData}/
├── library.db              (SQLite, mode WAL)
├── cache/
│   ├── thumbs/{h2}/{hash}_256.webp    (grille)
│   ├── thumbs/{h2}/{hash}_1024.webp   (loupe/preview)
│   ├── renders/                        (previews éditées)
│   └── tiles/                          (tuiles carte OSM)
└── models/                             (modèles Human téléchargés/embarqués)
```
- Adressage **par hash de contenu** (pas par chemin) : déplacer un fichier ne régénère rien.
- `{h2}` = 2 premiers caractères du hash (évite les dossiers à 100 000 fichiers).
- WebP qualité 82, génération par lots dans ThumbWorker (sharp, concurrence = nb cœurs − 1).
- Miniatures vidéo : frame à 10 % de la durée via ffmpeg.

## 6. Visages : pipeline

1. **Détection** (FaceWorker, basse priorité, après l'import) : Human détecte les visages → bounding box + embedding 512-d + score.
2. **Clustering incrémental** : chaque nouvel embedding est comparé aux centroïdes des personnes existantes (similarité cosinus). Seuil ~0,55 : au-dessus → rattachement automatique en "suggestion" ; en dessous → nouveau cluster anonyme.
3. **UI de nommage** : vue "Personnes" avec clusters, nommage en masse (comme Picasa), fusion/scission manuelle de clusters, confirmation des suggestions.
4. **Album virtuel auto** par personne (vue SQL, pas de duplication).
5. Les embeddings restent **100 % locaux** (BLOB en DB), aucun cloud.

## 7. Schéma SQL complet

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ============ RACINES DE SCAN & DOSSIERS ============
CREATE TABLE scan_roots (
  id            INTEGER PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,
  mode          TEXT NOT NULL DEFAULT 'watch'  -- watch | once | excluded
                CHECK (mode IN ('watch','once','excluded')),
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE folders (
  id            INTEGER PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,
  parent_id     INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  scan_root_id  INTEGER REFERENCES scan_roots(id) ON DELETE CASCADE,
  is_hidden     INTEGER NOT NULL DEFAULT 0,
  last_scanned  INTEGER
);
CREATE INDEX idx_folders_parent ON folders(parent_id);

-- ============ PHOTOS / VIDÉOS ============
CREATE TABLE photos (
  id             INTEGER PRIMARY KEY,
  folder_id      INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  filename       TEXT NOT NULL,
  filepath       TEXT NOT NULL UNIQUE,       -- chemin absolu courant
  media_type     TEXT NOT NULL DEFAULT 'image'
                 CHECK (media_type IN ('image','video')),
  hash_xxh3      TEXT NOT NULL,              -- doublons / adressage cache
  hash_sha256    TEXT,                       -- vérification forte (optionnel)
  file_size      INTEGER NOT NULL,
  file_mtime     INTEGER NOT NULL,
  width          INTEGER,
  height         INTEGER,
  duration_ms    INTEGER,                    -- vidéos
  taken_at       INTEGER,                    -- EXIF DateTimeOriginal (unixepoch)
  camera_make    TEXT,
  camera_model   TEXT,
  lens           TEXT,
  iso            INTEGER,
  f_number       REAL,
  exposure_time  TEXT,
  focal_length   REAL,
  gps_lat        REAL,
  gps_lon        REAL,
  gps_alt        REAL,
  gps_manual     INTEGER NOT NULL DEFAULT 0, -- 1 si placé à la main sur la carte
  orientation    INTEGER DEFAULT 1,          -- EXIF orientation
  rating         INTEGER NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 5),
  is_favorite    INTEGER NOT NULL DEFAULT 0, -- l'"étoile" Picasa
  is_hidden      INTEGER NOT NULL DEFAULT 0,
  caption        TEXT,                       -- légende
  color_label    TEXT,                       -- red|yellow|green|blue|purple|NULL
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','missing','trashed')),
  imported_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_photos_folder   ON photos(folder_id);
CREATE INDEX idx_photos_hash     ON photos(hash_xxh3);
CREATE INDEX idx_photos_taken    ON photos(taken_at);
CREATE INDEX idx_photos_gps      ON photos(gps_lat, gps_lon) WHERE gps_lat IS NOT NULL;
CREATE INDEX idx_photos_rating   ON photos(rating) WHERE rating > 0;

-- Recherche plein texte (légendes, noms de fichiers, tags dénormalisés)
CREATE VIRTUAL TABLE photos_fts USING fts5(
  caption, filename, tags, persons,
  content='', tokenize='unicode61 remove_diacritics 2'
);

-- ============ ALBUMS VIRTUELS ============
CREATE TABLE albums (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  cover_photo_id INTEGER REFERENCES photos(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL DEFAULT 'manual'  -- manual | person | smart
              CHECK (kind IN ('manual','person','smart')),
  smart_query TEXT,                            -- JSON de critères si smart
  person_id   INTEGER,                         -- si kind='person'
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE album_items (
  album_id   INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  photo_id   INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL DEFAULT 0,
  added_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (album_id, photo_id)
);
CREATE INDEX idx_album_items_photo ON album_items(photo_id);

-- ============ TAGS ============
CREATE TABLE tags (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color  TEXT
);
CREATE TABLE photo_tags (
  photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  tag_id   INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (photo_id, tag_id)
);
CREATE INDEX idx_photo_tags_tag ON photo_tags(tag_id);

-- ============ VISAGES / PERSONNES ============
CREATE TABLE persons (
  id         INTEGER PRIMARY KEY,
  name       TEXT,                    -- NULL = cluster anonyme "Personne 12"
  centroid   BLOB,                    -- embedding moyen Float32Array
  face_count INTEGER NOT NULL DEFAULT 0,
  is_ignored INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE faces (
  id          INTEGER PRIMARY KEY,
  photo_id    INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  person_id   INTEGER REFERENCES persons(id) ON DELETE SET NULL,
  bbox_x REAL NOT NULL, bbox_y REAL NOT NULL,   -- normalisés 0–1
  bbox_w REAL NOT NULL, bbox_h REAL NOT NULL,
  embedding   BLOB NOT NULL,          -- Float32Array 512-d
  confidence  REAL NOT NULL,
  assignment  TEXT NOT NULL DEFAULT 'auto'      -- auto | suggested | confirmed | rejected
              CHECK (assignment IN ('auto','suggested','confirmed','rejected'))
);
CREATE INDEX idx_faces_photo  ON faces(photo_id);
CREATE INDEX idx_faces_person ON faces(person_id);

-- ============ ÉDITION NON DESTRUCTIVE ============
CREATE TABLE edits (
  photo_id           INTEGER PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
  current_stack      TEXT NOT NULL DEFAULT '{"version":1,"ops":[]}', -- JSON DSL
  current_history_id INTEGER,                                        -- pointeur undo/redo
  stack_hash         TEXT,            -- pour invalider le cache de rendus
  updated_at         INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE edit_history (
  id         INTEGER PRIMARY KEY,
  photo_id   INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  stack      TEXT NOT NULL,           -- snapshot JSON complet après l'action
  action     TEXT NOT NULL,           -- ex: "add:crop", "modify:fill_light", "undo"
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_edit_history_photo ON edit_history(photo_id, id);

-- ============ MINIATURES / CACHES ============
CREATE TABLE thumbnails (
  photo_id   INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  size       INTEGER NOT NULL,        -- 256 | 1024
  cache_path TEXT NOT NULL,
  generated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (photo_id, size)
);

-- ============ DOUBLONS ============
CREATE TABLE duplicate_groups (
  id         INTEGER PRIMARY KEY,
  hash_xxh3  TEXT NOT NULL,
  resolved   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE duplicate_members (
  group_id INTEGER NOT NULL REFERENCES duplicate_groups(id) ON DELETE CASCADE,
  photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  is_kept  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, photo_id)
);

-- ============ FILE DE TRAVAUX (reprise après crash) ============
CREATE TABLE jobs (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL,           -- scan | hash | exif | thumb | face | export
  payload    TEXT NOT NULL,           -- JSON
  status     TEXT NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','running','done','failed')),
  priority   INTEGER NOT NULL DEFAULT 5,
  attempts   INTEGER NOT NULL DEFAULT 0,
  error      TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_jobs_status ON jobs(status, priority, id);

-- ============ RÉGLAGES & SÉCURITÉ ============
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Masquage protégé : settings('hidden_password_hash') = scrypt(password)

CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch())
);
```

### Notes de conception DB
- **Portabilité de la bibliothèque** : `photos.filepath` est absolu, mais la logique de "réhydratation" compare `hash_xxh3 + file_size` — au déplacement vers un autre disque, un rescan remappe les chemins **sans perdre albums, tags, visages ni éditions** (tout est lié par `photo_id`, retrouvé par hash). Exigence "migration sans tout rescanner" couverte.
- **FTS5** pour la recherche instantanée (légende, fichier, tags, personnes) avec dénormalisation entretenue par triggers ou par le DBService.
- **Fichiers manquants** : `status='missing'` (disque externe débranché) au lieu de suppression — comportement Picasa.
- Sauvegarde DB : `VACUUM INTO` planifié vers un fichier de backup.

## 8. Plan de développement par phases

**Phase 0 — Socle (1–2 sem.)** : squelette electron-vite + React + TS, contrat IPC typé, DBService + migrations, CI de build 3 OS (electron-builder), AppImage testée sur SteamOS.

**Phase 1 — MVP Bibliothèque (4–6 sem.)** : ScanWorker + chokidar, pipeline hash/EXIF/thumbs, vue Library (arbre dossiers + grille virtualisée), tray, albums manuels, tags, étoiles/notes, recherche FTS, import SD/appareil photo, détection doublons à l'import.

**Phase 2 — Éditeur (4–6 sem.)** : DSL d'opérations + moteur preview WebGL + moteur export sharp + tests de parité ; outils de base (crop, straighten, yeux rouges, auto-contraste/couleur, tampon) puis avancés (fill light, ombres/hautes lumières, température + pipette, histogramme temps réel) ; onglets de filtres ; A|B et A|A ; loupe 100 % ; undo/redo ; export presets + watermark.

**Phase 3 — Visages & carte (3–4 sem.)** : FaceWorker Human, clustering, UI Personnes, albums auto par personne ; carte MapLibre, lecture GPS EXIF, géotag manuel drag & drop.

**Phase 4 — Créations (3–4 sem.)** : collages (layouts type Picasa), diaporama plein écran, movie maker ffmpeg (photos + vidéos + pistes audio multiples), export vidéo.

**Phase 5 — Gestion avancée & partage (2–3 sem.)** : gestionnaire de dossiers, fusion de doublons, migration de bibliothèque, masquage protégé par mot de passe (scrypt), impression avec mise en page, email (mailto + pièces jointes redimensionnées), export légendes/métadonnées txt, connecteur S3/Immich optionnel.

## 9. Recommandations UI/UX (fidèles à Picasa)

- **Layout 3 zones** : arbre Dossiers/Albums/Personnes à gauche (sections repliables), grille de miniatures au centre groupée par dossier avec en-têtes collants, panneau contextuel à droite (infos EXIF, tags, visages détectés).
- **Photo Tray en bas à gauche** (signature Picasa) : bac persistant multi-dossiers + boutons d'action groupée (Album, Export, Email, Collage, Impression) + bouton "épingle" pour verrouiller la sélection.
- **Éditeur** : double-clic → vue édition avec onglets verticaux à gauche (Retouches simples / Réglages fins / Effets 1 / Effets 2), film-strip en bas, flèches ← → pour naviguer sans quitter l'édition, bouton "Revenir à l'original" toujours visible.
- **Curseur de zoom** de la grille en bas à droite (taille de miniatures continue), molette + Ctrl.
- **Raccourcis Picasa** : Ctrl+1/2/3 tailles de vue, touche `*` favori, Ctrl+R rotation, Échap retour bibliothèque.
- Thème sombre par défaut (Picasa 3), densité d'information élevée, animations discrètes 0.2 s.
- SteamOS : prévoir navigation clavier complète + cibles cliquables ≥ 32 px (mode Big Picture/tactile).

## 10. Risques identifiés

1. **Parité preview/export** du moteur d'édition → mitigé par le DSL + tests de référence dès la phase 2, avant d'ajouter des outils.
2. **Performance sur 100 000+ photos** → virtualisation UI, index SQL ci-dessus, écriture par transactions, thumbnails lazy.
3. **RAW** (CR2/NEF/ARW) → hors MVP ; libvips lit certains RAW, sinon ajout de LibRaw en phase 2+.
4. **face-api.js obsolète** (mentionné dans le brief) → remplacé par @vladmandic/human, activement maintenu, API similaire.
5. **Chemins Linux/Windows** → toujours `path.normalize`, tests des chemins réseau (NAS SMB/NFS) et des permissions flatpak/sandbox sur SteamOS (préférer AppImage).
