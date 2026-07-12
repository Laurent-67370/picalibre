# PicaLibre 📸

Gestionnaire de photos desktop open-source inspiré de **Picasa** (Google, 2002–2016).
Electron + React + TypeScript + SQLite — 100 % local, aucun cloud.

## Principes

- **Non destructif** : les fichiers originaux ne sont jamais modifiés. Les éditions
  sont des piles d'opérations JSON (voir `docs/ARCHITECTURE.md` §4).
- **Base locale** : SQLite (better-sqlite3, mode WAL) indexe les métadonnées sans
  dupliquer les fichiers.
- **Offline first** : reconnaissance faciale locale (@vladmandic/human), carte
  MapLibre avec cache de tuiles.

## Démarrage

```bash
npm install
npm run dev          # développement
npm run build:linux  # AppImage + .deb
npx tsx scripts/test-engine.ts  # tests du moteur d'édition
```

### Test headless du pipeline (CI)

```bash
npm run build
PICALIBRE_TEST_SCAN=/chemin/vers/photos npx electron out/main/index.js
# → [test] PIPELINE OK : scan + hash + EXIF + miniatures vérifiés en DB
```

## Architecture

Voir [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) : choix Electron vs Tauri,
schéma des processus, DSL d'édition, schéma SQL complet, plan par phases.

## État d'avancement

- [x] Phase 0 — Socle : electron-vite, DB + migrations, contrat IPC typé
- [x] Phase 1 — Scanner récursif + hash xxh3 incrémental
- [x] Phase 1 — Miniatures sharp (cache par hash, protocole thumb://), extraction EXIF/GPS, grille + notation étoiles
- [x] Phase 1 — Grille virtualisée (TanStack Virtual), tray Picasa, albums virtuels, tags, recherche
- [x] Phase 1 — Watcher chokidar temps réel (ajout/modif → rescan incrémental du dossier, suppression → statut 'missing' réversible), import SD/appareil (copie vers AAAA-MM, doublons ignorés par hash), UI Doublons avec fusion (albums/tags/visages/notes re-pointés vers la photo gardée)
- [x] Phase 2 — Moteur d'édition : DSL JSON, math couleur partagée preview/export (parité testée), undo/redo illimité, éditeur (redressement, fill light, hautes lumières, contraste, saturation, température, avant/après, export JPEG pleine résolution)
- [x] Phase 2 — Crop interactif (poignées, ratios, règle des tiers), contraste auto + couleur auto (analyse figée dans le DSL → déterministe preview/export), histogramme temps réel
- [x] Phase 2 — Yeux rouges (zones cliquables), tampon 2 clics (défaut → source, bord adouci), pipette de blanc, 5 filtres créatifs avec intensité — le tout dans le DSL, parité preview/export testée
- [ ] Optimisation ultérieure — preview WebGL (le DSL ne change pas)
- [x] Phase 3 — Reconnaissance faciale : détection @vladmandic/human (fenêtre cachée, 100 % offline, modèles servis via faceres://), embeddings faceres, clustering incrémental par cosinus (seuil 0,55), vue Personnes avec avatars recadrés et nommage
- [x] Phase 3 — Carte MapLibre/OSM : marqueurs-miniatures des photos géotaguées (EXIF GPS), géotag manuel des photos du bac par clic sur la carte
- [x] Phase 3 — Gestion manuelle des clusters : fusion (avec transfert de nom), scission, confirmation/rejet des rattachements, recalcul exact des centroïdes sur embeddings réels, tri des visages par confiance croissante
- [x] Phase 4 — Collages (4 layouts : grille, mosaïque, bandes H/V — cellules calculées sans chevauchement, remplissage cover avec recadrage attentionnel, éditions appliquées), diaporama plein écran (fondu, lecture auto, clavier), movie maker ffmpeg embarqué (photos éditées → MP4 H.264 1280x720 letterbox, piste audio optionnelle -shortest, durée exacte)
- [ ] Phase 4+ — Vidéos dans les movies, transitions animées, multi-pistes audio
- [ ] Phase 5 — Partage, impression, migration de bibliothèque

## Changelog

### v1.1.0

**Démarrage**
- Démarrage propre confirmé : le watcher lit la base de données sans erreur de module
- Le postinstall gère désormais automatiquement les soucis d'ABI liés à l'environnement local

**Phase 3 — Atelier de tri des visages (Vue Personne)**
- **Fusionner dans…** : liste déroulante + bouton dans la barre d'action
  - Tous les visages sont re-rattachés à la personne cible
  - Le nom est transféré automatiquement si la cible est anonyme
  - Le centroïde est recalculé sur les embeddings réels (pas une approximation)
  - La personne source est supprimée après fusion
- **👥 Gérer les visages** : grille d'avatars recadrés (même technique CSS que la sidebar), triés par confiance croissante pour prioriser la vérification manuelle des cas douteux
- **Sélection multiple** avec trois actions :
  - ✔ Confirmer (liseré vert persistant)
  - ✖ Pas cette personne (détaché + marqué `rejected`)
  - ✂ Détacher vers une nouvelle personne anonyme
- Une personne vidée de tous ses visages disparaît automatiquement de la liste
- Cœur logique isolé dans `manage-core.ts`, testé 8/8 sur base de données en mémoire avec les migrations réelles

## Licence

MIT
