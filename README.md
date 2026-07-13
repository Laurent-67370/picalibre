# PicaLibre 📸

[![CI](https://github.com/Laurent-67370/picalibre/actions/workflows/ci.yml/badge.svg)](https://github.com/Laurent-67370/picalibre/actions)
[![Version](https://img.shields.io/badge/version-1.8.1-f97316)](CHANGELOG.md)
[![Licence](https://img.shields.io/badge/licence-MIT-334155)](LICENSE)
![Plateformes](https://img.shields.io/badge/Linux%20%7C%20SteamOS%20%7C%20Windows%20%7C%20macOS-1e293b)

Gestionnaire de photos **et vidéos** desktop open-source inspiré de **Picasa**
(Google, 2002–2016). Electron + React + TypeScript + SQLite — 100 % local, aucun cloud.

## 🆕 Quoi de neuf en 1.6.0

- 📅 **Grille groupée par mois** avec en-têtes et mois épinglé au défilement
- 🕒 **Vue Chronologie** : toute la bibliothèque, du plus récent au plus ancien
- 🔍 **Curseur de taille des vignettes** (100–320 px), mémorisé
- ℹ️ **Panneau d'infos** : EXIF lisible, GPS, tags, albums, visages — au clic
  sur une photo

## Quoi de neuf en 1.5.0

- 🔍 **Visionneuse plein écran** : double-clic → navigation ←/→, zoom molette,
  100 % pixels réels au double-clic, glisser pour explorer
- 🖱 **Sélection naturelle** : clic, Ctrl+clic, Shift+clic, Ctrl+A — comme dans
  l'explorateur de fichiers
- 📋 **Clic droit** sur une photo : ouvrir, éditer, noter, taguer, masquer,
  afficher dans le dossier

## Quoi de neuf en 1.4.0

- 🔄 **Mises à jour automatiques** : PicaLibre se tient à jour tout seul depuis
  les releases GitHub (Windows, macOS, Linux AppImage) — bandeau discret,
  installation au redémarrage

## Quoi de neuf en 1.3.0

- ⚡ **Preview GPU (WebGL)** : les réglages couleur de l'éditeur sont rendus par
  un shader généré depuis la pile d'éditions — sliders fluides même en 4K,
  zéro `getImageData` sur le chemin rapide
- 🎯 **Parité garantie** : même math que l'export sharp (13 cas testés dans
  Electron, écart max 1/255), fallback CPU automatique si WebGL indisponible
- 🧪 Mode CI `PICALIBRE_TEST_WEBGL=1` : la suite de parité tourne dans le vrai
  renderer

Détail complet des versions : [CHANGELOG.md](CHANGELOG.md)

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
- [x] Preview WebGL : shader généré depuis le stack (même math 0–255, luminance recalculée par op, clamp unique en sortie), cache de programmes par signature, fallback CPU auto — parité GPU↔CPU testée dans Electron (13/13, écart max 1/255)
- [x] Phase 3 — Reconnaissance faciale : détection @vladmandic/human (fenêtre cachée, 100 % offline, modèles servis via faceres://), embeddings faceres, clustering incrémental par cosinus (seuil 0,55), vue Personnes avec avatars recadrés et nommage
- [x] Phase 3 — Carte MapLibre/OSM : marqueurs-miniatures des photos géotaguées (EXIF GPS), géotag manuel des photos du bac par clic sur la carte
- [x] Phase 3 — Gestion manuelle des clusters : fusion (avec transfert de nom), scission, confirmation/rejet des rattachements, recalcul exact des centroïdes sur embeddings réels, tri des visages par confiance croissante
- [x] Phase 4 — Collages (4 layouts : grille, mosaïque, bandes H/V — cellules calculées sans chevauchement, remplissage cover avec recadrage attentionnel, éditions appliquées), diaporama plein écran (fondu, lecture auto, clavier), movie maker ffmpeg embarqué (photos éditées → MP4 H.264 1280x720 letterbox, piste audio optionnelle -shortest, durée exacte)
- [x] Phase 4+ — Vidéos dans les movies (segments normalisés H.264/AAC, concat en copie), transitions en fondu (vidéo+audio, cuites par segment), multi-pistes audio (playlist concaténée bornée au film), miniatures vidéo (frame ffmpeg à 10 % → cache sharp), badge 🎬+durée dans la grille
- [x] Phase 4+ — timeline-core : fondation de montage non destructif (pistes vidéo/audio, clips avec trim in/out, transitions crossfade/wipe/slide, drag cross-track) — moteur de rendu et UI de montage à venir
- [x] Phase 5 — Export batch avec presets/filigrane, export CSV des métadonnées (ISO-8859-1 ; \r\n), impression avec mise en page, partage email (pièces jointes redimensionnées), migration de bibliothèque par hash (chemins re-mappés sans perdre albums/tags/visages/éditions), masquage protégé par mot de passe (scrypt)

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
