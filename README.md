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
```

## Architecture

Voir [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) : choix Electron vs Tauri,
schéma des processus, DSL d'édition, schéma SQL complet, plan par phases.

## État d'avancement

- [x] Phase 0 — Socle : electron-vite, DB + migrations, contrat IPC typé
- [x] Phase 1 (en cours) — Scanner récursif + hash xxh3 incrémental
- [ ] Phase 1 — Miniatures (sharp), EXIF, grille virtualisée, albums, tags, tray
- [ ] Phase 2 — Moteur d'édition non destructive (preview WebGL / export sharp)
- [ ] Phase 3 — Visages & géolocalisation
- [ ] Phase 4 — Collages, diaporamas, movies
- [ ] Phase 5 — Partage, impression, migration de bibliothèque

## Licence

MIT
