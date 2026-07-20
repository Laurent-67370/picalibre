# PicaLibre 📸

[![CI](https://github.com/Laurent-67370/picalibre/actions/workflows/ci.yml/badge.svg)](https://github.com/Laurent-67370/picalibre/actions)
[![Version](https://img.shields.io/badge/version-2.24.12-f97316)](CHANGELOG.md)
[![Licence](https://img.shields.io/badge/licence-MIT-334155)](LICENSE)
![Plateformes](https://img.shields.io/badge/Linux%20%7C%20SteamOS%20%7C%20Windows%20%7C%20macOS-1e293b)

Gestionnaire de photos **et vidéos** desktop open-source inspiré de **Picasa**
(Google, 2002–2016). Electron + React + TypeScript + SQLite — 100 % local, aucun cloud.

📄 [Politique de signature de code](CODE_SIGNING.md) — comment les installeurs sont signés et comment vérifier leur intégrité.

## 📊 Comparatif avec Picasa 3 (dernière version, 3.9)

Vérifié fonctionnalité par fonctionnalité en relisant le code, pas une
estimation — y compris les 3 écarts encore ouverts, listés honnêtement
plutôt que masqués. ✅ = équivalent · ➕ = PicaLibre va plus loin ·
❌ = pas encore fait.

### Organisation de la bibliothèque

| Fonctionnalité | Picasa 3.9 | PicaLibre |
|---|:---:|:---:|
| Scan de dossiers + surveillance continue | ✅ | ✅ |
| Albums virtuels | ✅ | ✅ |
| Notation | ★ simple (on/off) | ➕ 0 à 5 étoiles |
| Tags / mots-clés | ✅ | ✅ (cherchables) |
| Reconnaissance des visages | ✅ | ✅ + fusion/scission manuelle |
| Géolocalisation + carte | ✅ (via Google Earth/Maps) | ➕ clustering au barycentre, zoom intelligent sur les groupes, géotag par clic, fond hors-ligne |
| Recherche (nom, tag, légende) | ✅ | ✅ + FTS5 plein texte |
| Détection de doublons | ✅ (expérimental) | ➕ fusion complète (albums/tags/visages transférés) + annulable |
| Photos masquées | ✅ (exclusion simple) | ➕ verrouillage par mot de passe de bout en bout (vue, Corbeille et vignettes comprises) |
| Corbeille | Corbeille système uniquement | ➕ corbeille intégrée : vue dédiée, restauration, mise à la corbeille annulable, suppression définitive avec confirmation |
| Regroupement voyages / événements | ❌ | ➕ détection automatique (rupture temporelle ou géographique), nommage par ville via géocodage, création d'albums en un clic |
| Renommage en lot | ✅ | ✅ ({n}/{name}/{date}, aperçu live, annulable) |

### Édition photo

| Fonctionnalité | Picasa 3.9 | PicaLibre |
|---|:---:|:---:|
| Recadrage (ratios, règle des tiers) | ✅ | ✅ |
| Redressement | ✅ | ✅ |
| Contraste / couleur auto | ✅ | ✅ |
| Pipette de blanc | ✅ | ✅ |
| Yeux rouges | ✅ | ✅ |
| Tampon / retouche locale | ✅ | ✅ |
| Réglages manuels | 6 (dont Ombres, Vibrance) | ✅ 8 (+ Teinte) |
| Définition / Clarté | ✅ | ✅ |
| Filtres créatifs | ~12 de base + 24 en 3.9 | 9 (N&B, Sépia, Réchauffer, Refroidir, Négatif, Postériser, Duoton, Cross-process, Grain) |
| Flou gaussien, Netteté | ✅ | ✅ |
| Vignette, Doucette, Glow, Orton | ✅ | ✅ |
| Tilt-shift (flou radial/linéaire) | ✅ | ✅ |
| Pseudo-HDR | ✅ | ✅ |
| Cadres / bordures | Polaroid, Vignette-Matte, Musée, décoratifs | Solid, Polaroid, Musée *(moins de variété décorative)* |
| Texte sur photo | ✅ | ✅ |
| Comparaison côte à côte | ✅ (3.9) | ✅ |
| Undo | 1 niveau (dernière action) | ✅ 1 niveau (lot) + **illimité** dans l'éditeur |
| Édition en lot (plusieurs photos) | ✅ (retouches auto) | ➕ + copier/coller de réglages complets entre photos |

### Vidéo

| Fonctionnalité | Picasa 3.9 | PicaLibre |
|---|:---:|:---:|
| Import et lecture | ✅ | ✅ (H.264 natif, HEVC/H.265 via proxy auto générés en arrière-plan) |
| Miniatures vidéo | ✅ | ✅ |
| Découpe (trim) d'un clip | ✅ | ✅ non destructive (points de repère, fichier original jamais modifié) |
| Extraire une image fixe d'une vidéo | ✅ | ✅ |
| Inclure des clips dans un montage | ✅ | ➕ mélange natif photos+vidéos, transitions, playlist audio multi-pistes |

### Créations et partage

| Fonctionnalité | Picasa 3.9 | PicaLibre |
|---|:---:|:---:|
| Diaporama plein écran (Ken Burns) | ✅ | ✅ |
| Écran de veille photo | ✅ | ✅ |
| Collage | ✅ (plusieurs mises en page) | ✅ |
| Créateur de film | ✅ | ➕ (voir Vidéo ci-dessus) |
| Export simple / groupé | ✅ | ✅ + choix taille/format/qualité |
| Impression | ✅ | ✅ |
| Envoi par email | ✅ | ✅ |
| Fond d'écran | ✅ | ✅ |
| Export CSV des métadonnées | ❌ | ➕ |
| Publication sur blog | Blogger uniquement | ➕ export générique vers n'importe quel blog |
| Partage cloud (Web Albums) | ✅ (service arrêté en 2016) | *(délibérément absent — voir ci-dessous)* |

### Formats de fichiers

| Format | Picasa 3.9 | PicaLibre |
|---|:---:|:---:|
| JPEG / PNG / GIF / BMP / TIFF | ✅ | ✅ |
| WebP / AVIF | ❌ | ✅ |
| HEIC / HEIF (photos iPhone) | Limité | ✅ décodage plein résolution, vérifié avec un vrai fichier |
| RAW (CR2, NEF, ARW, RAF, ORF, DNG) | ✅ | ✅ |
| PSD (Photoshop) | ✅ (aperçu) | ✅ (aperçu) |

### Ce que Picasa avait et que PicaLibre n'a délibérément pas

| Fonctionnalité Picasa | Pourquoi PicaLibre ne l'a pas |
|---|---|
| Upload vers Web Albums / Google+ | Service arrêté par Google en 2016 ; à l'opposé du principe « 100 % local, aucun cloud » de PicaLibre |
| Gravure CD/DVD | Technologie obsolète |
| Commande de tirages photo en ligne | Service commercial tiers disparu |

### Ce que PicaLibre a et que Picasa n'avait pas

- 🔓 **Open source** (licence MIT) — Picasa était propriétaire et fermé
- 🖥️ **Windows, macOS *et* Linux** — Picasa : Windows et Mac uniquement
- 🔄 **Toujours maintenu** — Picasa est arrêté depuis 2016, plus aucune mise à jour
- 📱 **Galerie mobile auto-hébergée** — accès depuis son téléphone via un serveur qu'on héberge soi-même (miniatures + métadonnées seulement, jamais les originaux)
- 🎨 **Thème clair (inspiré de Picasa) et sombre**, au choix
- ❓ **Aide interactive** : visite guidée au premier lancement + centre d'aide cherchable
- 🛡️ **Sécurité d'aujourd'hui, pas de 2016** : audit complet (bac à sable Chromium, verrou de confidentialité appliqué jusqu'au serveur interne de vignettes, navigation verrouillée, https obligatoire pour la galerie mobile), moteur Electron/Chromium à jour, zéro vulnérabilité connue dans les dépendances — Picasa n'a plus reçu un seul correctif depuis 2016
- 🧩 **DSL d'édition non destructive en JSON**, entièrement inspectable et versionnable

### Bilan honnête

PicaLibre couvre désormais l'intégralité des fonctionnalités de Picasa 3.9
identifiées lors de cette comparaison, et va plus loin sur plusieurs axes
réels (formats modernes, doublons, undo illimité en édition, galerie
mobile, open source, découpe non destructive). Les 3 écarts qui restaient
ouverts (Définition/Clarté, découpe vidéo, extraction d'image fixe) ont
été comblés et vérifiés avec de vraies vidéos, pas des simulations.
Depuis, PicaLibre a dépassé le cadre de la parité : Corbeille intégrée
avec restauration, regroupement automatique en voyages/événements (que
Picasa n'a jamais eu), verrou de confidentialité étendu de bout en bout,
et un audit de sécurité complet mené jusqu'à zéro vulnérabilité — chaque
point vérifié par des tests automatisés sur les trois systèmes.

## 🆕 Quoi de neuf en 2.24.12

- 🔧 **Correctif d'affichage** : le centre d'aide en thème sombre était
  difficile à lire (champ de recherche invisible, contrastes trop
  faibles) — corrigé et vérifié par capture d'écran réelle.

## 📜 Historique des versions

L'historique complet, version par version depuis la 1.0, est dans le
[CHANGELOG](CHANGELOG.md) — chaque entrée détaille ce qui a été ajouté,
corrigé et surtout **comment ça a été vérifié**.

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
- [x] Auto-update (electron-updater + releases GitHub), menu applicatif complet (Aide fonctionnelle), refonte de la barre d'actions du bac (groupes étiquetés, style navy/orange)
- [x] Convivialité — lightbox (zoom 5×, 100 % pixels réels, navigation clavier), sélection façon explorateur (Ctrl/Shift/Ctrl+A), menu contextuel clic droit, grille groupée par mois avec mois épinglé, vue Chronologie, curseur de taille des vignettes, panneau d'infos EXIF/GPS/tags/albums
- [x] Glisser-déposer (vignettes → albums, dossiers/fichiers OS → scan/import), barre de critères d'affichage (tri, filtre ★/type, ratio des vignettes) — mémorisés
- [x] Performance : cache navigateur permanent des miniatures, colonnes IPC ciblées (−45 %), index SQL partiels, pragmas SQLite, mesuré sur 50 000 photos
- [x] Taille des installeurs réduite de 50 à 65 % (résolveur ffmpeg à la demande, modèles de visages allégés, dépendances nettoyées) ; CI multi-OS (Linux/Windows/macOS) avec release automatique sur tag
- [x] Galerie mobile (`web-server/`) : miroir léger miniatures+métadonnées, synchronisation incrémentale desktop→VPS, déploiement Coolify documenté
- [x] Corbeille intégrée (mise à la corbeille annulable, vue dédiée, restauration, suppression définitive fichier+base) et regroupement automatique en voyages/événements (rupture temporelle >2 j ou géographique >60 km, nommage par géocodage, écran de review, création d'albums)
- [x] Audit sécurité complet : verrou de confidentialité de bout en bout (Corbeille et protocole de vignettes compris), sandbox Chromium, blocage de navigation, https obligatoire pour la galerie mobile, montée Electron 33 → 42 + outillage — zéro vulnérabilité npm, chaque correctif prouvé par test E2E
- [x] Carte : clustering au barycentre réel, zoom-clic cadrant les photos du groupe (fitBounds), test E2E dédié sur la vraie vue Leaflet

## Licence

MIT
