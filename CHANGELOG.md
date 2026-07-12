# Changelog

Toutes les évolutions notables de PicaLibre sont documentées ici.
Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/) — versionnage sémantique.

## [1.2.0] — 2026-07-12

### Ajouté
- **Vidéos dans les movies** : photos et vidéos mixées dans un même film. Chaque
  élément devient un segment normalisé (H.264/AAC, 30 fps, letterbox), l'assemblage
  final se fait en copie de flux — pas de double ré-encodage.
- **Transitions en fondu** (vidéo + audio), cuites dans chaque segment.
- **Multi-pistes audio** : sélection multiple → playlist concaténée qui remplace
  l'audio des segments, bornée à la durée exacte du film. Sans bande-son, les
  vidéos conservent leur propre audio.
- **Miniatures vidéo** dans le pipeline d'indexation : frame extraite à 10 % de la
  durée (ffmpeg) → cache sharp 256/1024 ; durée et dimensions stockées en DB.
- Badge 🎬 + durée sur les vignettes vidéo dans la grille.
- **timeline-core** : fondation du futur éditeur de montage non destructif —
  pistes vidéo/audio, clips avec trim in/out, transitions crossfade/wipe/slide,
  déplacement inter-pistes (migration 003, 8 tests).
- Dialogue de sélection multiple de fichiers (`dialog:pickFiles`).

### Modifié
- `timeline-core` déplacé dans `src/main/services/timeline/`, sa suite de tests
  convertie à la convention du projet (tsx + assert) et branchée sur la vraie
  migration SQL.

### Tests
- Movie maker v2 : 5/5 (mix photos+vidéo, fondus, playlist, régression photos
  seules, compat API v1). Pipeline vidéo validé de bout en bout sous Xvfb.

## [1.1.0] — 2026-07-12

### Ajouté
- **Gestion manuelle des clusters de visages** (reliquat Phase 3) :
  - fusion de personnes avec transfert de nom vers une cible anonyme et centroïde
    recalculé sur les embeddings réels ;
  - scission de visages vers une nouvelle personne ;
  - confirmation / rejet des rattachements automatiques ;
  - suppression automatique des personnes vidées.
- Panneau « Gérer les visages » dans la vue Personne : avatars recadrés triés par
  confiance croissante (les douteux en premier), sélection multiple.

### Tests
- `manage-core` pur (DB injectée) : 8/8 sur base en mémoire avec les vraies migrations.

## [1.0.0] — 2026-07-12

Les 5 phases du plan initial sont couvertes.

### Ajouté — Phase 4 (créations)
- Collages 4 layouts (grille, mosaïque, bandes H/V) : cellules calculées sans
  chevauchement, remplissage cover avec recadrage attentionnel, éditions appliquées.
- Diaporama plein écran (fondu, lecture auto, navigation clavier).
- Movie maker ffmpeg embarqué : photos éditées → MP4 H.264 1280×720, piste audio
  optionnelle, durée exacte vérifiée.

### Ajouté — Phase 5 (gestion avancée & partage)
- Migration de bibliothèque par hash : chemins re-mappés après déplacement du
  disque sans perdre albums, tags, visages ni éditions.
- Masquage protégé par mot de passe (scrypt).
- Export batch avec presets de taille et filigrane SVG.
- Export CSV des métadonnées (ISO-8859-1, séparateur `;`, fins de ligne CRLF).
- Impression 1/2/4 par page, partage email avec pièces jointes redimensionnées.
- Gestionnaire de racines de scan avec modes (surveillé / ponctuel / exclu).

### Ajouté — Phase 3 (visages & carte)
- Reconnaissance faciale 100 % offline : @vladmandic/human en fenêtre cachée,
  détection sur miniatures 1024, clustering incrémental par similarité cosinus
  (seuil 0,55), vue Personnes avec avatars recadrés et nommage.
- Carte MapLibre/OSM : marqueurs-miniatures des photos géotaguées, géotag manuel
  des photos du bac par clic sur la carte.

### Ajouté — Fin de Phase 1
- Watcher chokidar temps réel : ajout/modification → rescan incrémental ;
  suppression → statut `missing` réversible.
- Import SD/appareil photo : copie vers dossiers AAAA-MM, doublons ignorés par
  hash, collisions suffixées, destination auto-indexée.
- UI Doublons avec fusion complète des références (albums, tags, visages, notes).

## [0.5.0] — 2026-07-12 *(Phase 2 terminée)*

### Ajouté
- Crop interactif : poignées, déplacement, ratios 1:1/4:3/3:2/16:9, règle des tiers.
- Contraste auto (points noir/blanc aux centiles 0,5/99,5 %) et couleur auto
  (gray world) — analyses **figées dans le DSL** pour un rendu déterministe.
- Correction des yeux rouges par zones cliquables, tampon 2 clics avec bord adouci,
  pipette de blanc, 5 filtres créatifs avec intensité réglable.
- Histogramme de luminance temps réel.

## [0.4.0] — 2026-07-12

### Ajouté
- **Moteur d'édition non destructive** : DSL JSON à coordonnées normalisées 0–1,
  math couleur partagée entre la preview Canvas et l'export sharp — parité
  garantie par construction et testée au pixel près.
- Undo/redo illimité (historique en DB avec pointeur, branche redo coupée à la
  nouvelle action).
- Éditeur : redressement ±15°, lumière de remplissage, hautes lumières, contraste,
  saturation, température ; avant/après maintenu ; export JPEG pleine résolution.
- Mode test headless `PICALIBRE_TEST_SCAN` (CI).

### Corrigé
- Parité preview/export : `Uint8ClampedArray` arrondit, `Uint8Array` tronque —
  arrondi explicite commun.
- Migrations SQL embarquées dans le bundle (`?raw`) : crash au premier lancement
  packagé évité.
- Typage du preload, `app.setName` pour un chemin userData déterministe.

## [0.3.0] — 2026-07-12

### Ajouté
- Grille virtualisée (TanStack Virtual) — fluide au-delà de 10 000 photos.
- **Tray Picasa** : bac de sélection multi-dossiers avec actions groupées
  (créer un album, ajouter à un album, taguer en masse).
- Albums virtuels (aucune copie de fichier) et tags.
- Recherche par nom de fichier, légende et tag.

## [0.2.0] — 2026-07-12

### Ajouté
- Miniatures sharp 256/1024 en cache **adressé par hash de contenu**
  (`cache/thumbs/{h2}/{hash}_{taille}.webp`) — déplacer un fichier ne régénère rien.
- Extraction EXIF/GPS par lots (exiftool-vendored).
- Pipeline post-scan : Scan → EXIF → Miniatures avec progression en direct.
- Protocole `thumb://` pour servir les miniatures en dev comme en prod.
- Notation ★ dans la grille.

## [0.1.0] — 2026-07-12

### Ajouté
- Socle Electron + electron-vite + React + TypeScript strict.
- Schéma SQLite complet (21 tables, mode WAL) avec système de migrations.
- Contrat IPC typé partagé main/renderer.
- Scanner récursif avec hash xxh3 par chunks et **rescan incrémental**
  (fichier inchangé size+mtime = jamais re-hashé).
- Configuration de build Linux (AppImage/deb), Windows (NSIS), macOS (DMG).

[1.2.0]: https://github.com/Laurent-67370/picalibre/releases/tag/v1.2.0
[1.1.0]: https://github.com/Laurent-67370/picalibre/releases/tag/v1.1
[1.0.0]: https://github.com/Laurent-67370/picalibre/releases/tag/v1.0.0
