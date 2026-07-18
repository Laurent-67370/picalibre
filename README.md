# PicaLibre 📸

[![CI](https://github.com/Laurent-67370/picalibre/actions/workflows/ci.yml/badge.svg)](https://github.com/Laurent-67370/picalibre/actions)
[![Version](https://img.shields.io/badge/version-2.19.5-f97316)](CHANGELOG.md)
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
| Géolocalisation + carte | ✅ | ✅ (clustering) |
| Recherche (nom, tag, légende) | ✅ | ✅ + FTS5 plein texte |
| Détection de doublons | ✅ (expérimental) | ➕ fusion complète (albums/tags/visages transférés) + annulable |
| Photos masquées | ✅ (exclusion simple) | ➕ + verrouillage par mot de passe |
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
- 🧩 **DSL d'édition non destructive en JSON**, entièrement inspectable et versionnable

### Bilan honnête

PicaLibre couvre désormais l'intégralité des fonctionnalités de Picasa 3.9
identifiées lors de cette comparaison, et va plus loin sur plusieurs axes
réels (formats modernes, doublons, undo illimité en édition, galerie
mobile, open source, découpe non destructive). Les 3 écarts qui restaient
ouverts (Définition/Clarté, découpe vidéo, extraction d'image fixe) ont
été comblés et vérifiés avec de vraies vidéos, pas des simulations.

## 🆕 Quoi de neuf en 2.19.0

- 🗂️ **Panneau de l'éditeur réorganisé** : de vrais onglets (Réglages/
  Filtres/Effets/Texte/Cadre) au lieu de simples liens de défilement —
  un seul groupe de contrôles visible à la fois. Les 8 effets avancés
  (Flou, Netteté, Vignette, Doucette, Glow, Orton, Tilt-shift, HDR,
  Définition) deviennent une grille de boutons compacte : le curseur
  n'apparaît qu'à l'activation.

## 🆕 Quoi de neuf en 2.18.0

- 🎚️ **Définition/Clarté**, ✂ **Découpe vidéo non destructive**, 📷
  **Extraction d'image fixe depuis une vidéo** — les 3 derniers écarts
  du [comparatif avec Picasa 3.9](#-comparatif-avec-picasa-3-dernière-version-39)
  sont fermés.

## 🆕 Quoi de neuf en 2.17.0

- ❓ **Aide interactive** : visite guidée au premier lancement (repère les
  vrais éléments de l'interface), et un centre d'aide cherchable (bouton
  ❓ ou touche F1) avec 24 sujets — certains naviguent directement vers
  la fonctionnalité concernée.

## 🆕 Quoi de neuf en 2.16.0

- 🎬 **Correctif majeur : la lecture vidéo était cassée pour toutes les
  vidéos**, pas juste HEVC — une directive de sécurité manquante
  bloquait le protocole vidéo interne. Corrigé.
- 📹 **Vrai support HEVC/H.265** (vidéos iPhone) : proxy H.264 généré
  automatiquement en arrière-plan pour la lecture, fichier original
  jamais modifié. Vérifié avec une vraie vidéo HEVC : lecture parfaite.

## 🆕 Quoi de neuf en 2.15.0

- 📷 **Vrai support HEIC** (photos iPhone) : sharp/libvips ne décodait pas
  ce format malgré l'extension reconnue — import silencieusement cassé
  jusqu'ici. Décodage plein résolution via `heic-convert` (WASM, aucune
  dépendance système). Vérifié avec un vrai fichier iPhone : miniatures,
  édition et export tous confirmés fonctionnels.

## 🆕 Quoi de neuf en 2.14.2

- 🔧 **Contraste du texte dans l'éditeur** : le panneau de l'éditeur (fond
  `#111418`) force maintenant la couleur du texte en `#e2e8f0` (gris clair).
  Les titres de sections sont en `#cbd5e1` avec opacity 1 (au lieu de 0.85),
  les textes d'aide en `#94a3b8` avec opacity 0.9. Fini le gris sur bleu
  illisible — tout est nettement contrasté quel que soit le thème.

## 🆕 Quoi de neuf en 2.14.1

- 🔧 **Lisibilité de l'éditeur** : les titres de sections passent de
  fontSize 11 / opacity 0.5 à fontSize 13 / opacity 0.85 / gras. Les labels
  des curseurs passent de fontSize 12 à 14. Le panneau est élargi de 300 à
  330px.
- 🧭 **Navigation rapide** : 5 boutons (Réglages, Filtres, Effets, Texte,
  Cadre) en haut du panneau pour sauter directement à chaque section.
- 🎯 **Section « Effets avancés »** : les 7 effets (Flou, Netteté, Doucette,
  Glow, Orton, Tilt-shift, Pseudo-HDR) sont regroupés sous un en-tête avec
  séparateur visuel, facilement accessibles via le bouton « Effets ».

## 🆕 Quoi de neuf en 2.14.0

- 🎯 **Tilt-shift** : flou radial (cercle net centré) ou linéaire (bande
  horizontale nette). Sliders focusX/Y, focusRadius, blurRadius. Aperçu
  visuel de la zone nette (cercle/bande pointillée). Transition douce entre
  zone nette et zone floue.
- 🌈 **Pseudo-HDR** : local tone mapping — flou léger → extraction des
  détails (haute fréquence) → boost → compression de dynamique (Reinhard).
  Slider intensité 0..1.

## 🆕 Quoi de neuf en 2.13.0

- 🌫️ **Flou (blur)** : brique fondamentale — opération spatiale avec rayon
  0..20px. Foundation pour tous les effets qui en dépendent.
- 🔪 **Netteté (sharpen)** : unsharp mask = image + amount × (image - blur).
  Slider intensité.
- 🌸 **Doucette (soft focus)** : blend(image, blur(6px), intensity) —
  mélange l'image originale avec une version floue pour un rendu doux.
- ✨ **Glow** : image + screen-blend(brightness×1.3, blur 10px) — halo
  lumineux autour des zones claires.
- 📸 **Orton** : blend(brightness×1.4, blur 15px, 0.5) — effet Orton
  (sur-exposition + flou + blend).

## 🆕 Quoi de neuf en 2.12.0

- 🎚️ **3 nouveaux réglages** : Ombres (relève/assombrit sélectivement les
  tons foncés), Vibrance (saturation intelligente qui protège les teintes
  déjà vives), Teinte (rotation ±180°).

## 🆕 Quoi de neuf en 2.11.0

- ✏️ **Renommage en lot** : modèle personnalisable ({n}/{name}/{date}),
  aperçu en direct, annulable.
- 🪄 **Correction auto en lot** : contraste/balance des blancs calculés
  individuellement pour chaque photo sélectionnée.
- 📋 **Copier/coller les réglages** entre l'éditeur et une sélection de
  photos (tuning, filtre, vignette, cadre).

## 🆕 Quoi de neuf en 2.10.0

- 🎨 **4 nouveaux filtres** : Postériser, Duoton, Cross-process, Grain de
  film (en plus de N&B, Sépia, Réchauffer, Refroidir, Négatif).
- 🔘 **Vignette** : assombrissement radial des bords, curseur dédié.
- 🖼️ **Cadre « Musée »** : bordure épaisse uniforme.

## 🆕 Quoi de neuf en 2.9.0

- ⇔ **Comparaison côte à côte** dans l'éditeur (raccourci `C`) : original
  et édité affichés simultanément, l'un à côté de l'autre — la
  fonctionnalité phare de Picasa 3.9, maintenant dans PicaLibre.

## 🆕 Quoi de neuf en 2.8.0

- 🎯 **La vraie cause de la vignette manquante, enfin trouvée** : une
  requête ne vérifiait que la taille 256px pour décider si une
  miniature restait à générer — un échec partiel sur la taille 1024px
  laissait l'item exclu pour toujours, même après un rescan. Corrigé :
  le pipeline est désormais auto-réparant. Reproduit ~10 % du temps et
  vérifié disparu (30/30) après correctif.

## 🆕 Quoi de neuf en 2.7.2

- 🔧 Correctif interne : timeout de téléchargement du binaire ffmpeg
  ramené à sa valeur normale (60 s au lieu de 15 s par erreur).

## 🆕 Quoi de neuf en 2.7.1

- ↩️ **Annuler (Ctrl/⌘+Z) étendu à la fusion de doublons** : la seule
  action vraiment destructive de PicaLibre a maintenant son filet — un
  instantané complet (notes, favoris, albums, tags, visages) est capturé
  avant la fusion et restauré fidèlement en cas d'annulation.

## 🆕 Quoi de neuf en 2.7.0

- ↩️ **Annuler façon Picasa (Ctrl/⌘+Z)** : après avoir masqué ou démasqué
  des photos, un bandeau "Annuler" apparaît quelques secondes — un seul
  niveau d'annulation pour la dernière action, comme dans Picasa.

## 🆕 Quoi de neuf en 2.6.0

- 🧾 **Logs persistants** (Aide → Ouvrir le dossier des logs) : fini les
  lancements depuis un terminal pour diagnostiquer un souci.
- 🔄 **Rescan automatique au démarrage** : un échec ponctuel du pipeline
  (miniature vidéo par ex.) ou des fichiers ajoutés app fermée sont
  désormais retraités tout seuls, sans avoir à rajouter le dossier.
- 🛡️ **Résilience ffmpeg** : timeout de sécurité si un process reste
  bloqué, retry automatique (3 tentatives) si le téléchargement du
  binaire échoue.

## 🆕 Quoi de neuf en 2.5.1

- 🔄 **Correction de la mise à jour macOS** : le bouton « Redémarrer et
  installer » ne faisait rien (Squirrel.Mac exige un certificat Apple
  payant pour remplacer l'app en place, absent ici). Il ouvre désormais
  la page de téléchargement pour un remplacement manuel, avec un message
  clair. *Cette mise à jour-ci devra encore être installée manuellement
  une dernière fois — les suivantes s'ouvriront automatiquement.*

## 🆕 Quoi de neuf en 2.5.0

- 🎨 **Thème clair inspiré de Picasa 3, par défaut** : palette gris
  argenté/blanc, accent orange PicaLibre conservé, sélection bleue façon
  Picasa. Le thème sombre navy/orange historique reste disponible dans
  **Réglages → Apparence**. La visionneuse, l'éditeur et les autres modes
  immersifs restent volontairement sombres dans les deux thèmes (comme
  Picasa, Lightroom ou Photos), pour ne pas fausser le jugement des
  couleurs des photos.

## 🆕 Quoi de neuf en 2.4.0

- 📋 **Refonte de la barre de menus — tout devient trouvable** : nouveaux
  menus **Bibliothèque** (Chronologie, Carte, Doublons, Photos masquées,
  Analyser les visages) et **Outils** (Diaporama, Collage, Film,
  Impression, Export, Email, CSV) ; menu **Édition** enrichi (éditer,
  noter, taguer, créer un album, masquer) ; nouvelle entrée **Rescanner
  la bibliothèque** (Ctrl/⌘+Maj+R) ; **Aide → Raccourcis clavier** avec
  la liste complète des gestes (clic, glisser-déposer, molette, flèches…).
  Plus aucune fonctionnalité cachée derrière une sélection préalable.

## 🆕 Quoi de neuf en 2.3.4

- 🎬 **Lecture vidéo enfin fonctionnelle** : le lecteur ajouté en 2.3.3 ne
  se déclenchait jamais — il manquait le privilège `stream: true` sur le
  schéma `thumb://`, sans lequel Electron/Chromium refuse silencieusement
  de traiter une source vidéo personnalisée. Le seek (barre de
  progression) est également corrigé au passage.

## 🆕 Quoi de neuf en 2.3.3

- ▶️ **Lecture vidéo dans la visionneuse plein écran** : le double-clic sur
  une vidéo ouvrait jusqu'ici une visionneuse image-only, incapable
  d'afficher un flux `.mp4`. Ajout d'un lecteur natif avec contrôles
  (lecture, pause, volume, plein écran), navigation ← → conservée entre
  vidéos et photos d'une même sélection.

## 🆕 Quoi de neuf en 2.3.2

- 🍎 **macOS : correction du message Gatekeeper « L'app est endommagée »
  sur Apple Silicon** : le bundle `.app` n'était pas signé (pas de
  certificat Apple Developer), ce qui déclenche ce message trompeur sur
  arm64 au lieu du simple avertissement « développeur non identifié ».
  L'app est désormais signée en ad-hoc pendant le build — plus besoin de
  passer par `xattr -cr` après le téléchargement.

## 🆕 Quoi de neuf en 2.3.1

- 🐛 **Bug critique corrigé : scan bloqué sur machines à 1-2 cœurs** : le
  partitionnement multi-worker du scanner (`partitionRoots`) provoquait une
  division par zéro (`partitions.length - 1 === 0`) lors de la répartition
  round-robin sur les machines mono/bi-cœur, bloquant tout scan
  (`TypeError`, aucune photo jamais indexée). Corrigé : un seul worker
  pleinement récursif scanne désormais tout sur ces machines, sans
  partitionnement inutile.
- 📷 **Fallback RAW/PSD réparé** : `sharp(...).metadata()` levait une
  exception sur les formats non supportés par libvips (RAW propriétaire,
  PSD sans plugin) au lieu de déclencher le fallback
  `exiftool.extractPreview()`. Corrigé avec un try/catch dédié — le
  fallback fonctionne dès que le fichier a une preview JPEG intégrée
  (quasi systématique pour les RAW d'appareils photo).
- ✅ **Vérification approfondie des fonctionnalités 2.0.0→2.3.0** : tests
  réels (pas de simulation) sur les bordures/cadres (export sharp
  pixel-parfait) et la géolocalisation (3 photos avec vraies coordonnées
  EXIF GPS, carte Leaflet rendue avec ses marqueurs et tuiles OSM).

## 🆕 Quoi de neuf en 2.3.0

- 🗺️ **Géolocalisation et carte interactive** : les photos avec coordonnées
  GPS EXIF sont affichées sur une carte Leaflet + OpenStreetMap. Marqueurs
  clusterisés pour éviter la surcharge, clic sur un marqueur → ouverture dans
  la lightbox. Filtrage par bounding box (photos dans la zone visible de la
  carte uniquement). Géocoding inverse via Nominatim pour afficher le nom du
  lieu. Bouton « Carte » dans la barre d'outils. Fallback offline si pas de
  connexion. Index spatial optimisé en base de données.

## 🆕 Quoi de neuf en 2.2.0

- 🎬 **Face Movies** : diaporama spécial centré sur un visage. La caméra
  zoome sur la bounding box du visage détecté au lieu de la photo entière,
  avec un effet Ken Burns adapté. Lancé depuis la vue d'une personne.
- 🖨️ **Impression** : layouts d'impression prédéfinis (planche contact,
  plein page, grille 2×3, grille 3×3), choix du format papier (A4, A3,
  Letter, Legal), marges configurables. Prévisualisation avant impression
  avec CSS print dédié (`@media print`).
- 📷 **RAW natif** : support des fichiers `.CR2`, `.NEF`, `.ARW`, `.RAF`,
  `.ORF`, `.DNG`. Miniatures via sharp (libvips) avec fallback exiftool pour
  extraire la preview JPEG embarquée. Métadonnées EXIF via exiftool-vendored.
- 🎨 **PSD** : support des fichiers Photoshop `.psd`. Sharp/libvips extrait
  le calque fusionné, fallback exiftool si besoin.

## 🆕 Quoi de neuf en 2.1.0

- 🖼️ **Cadres et bordures** : ajoute des cadres à tes photos directement dans
  l'éditeur. Style solid (bordure uniforme) ou polaroid (bord bas plus large).
  Épaisseur et couleur configurables. Opération non-destructive du DSL EditStack
  avec parité preview/export.
- 🛌 **Écran de veille photo** : diaporama plein écran qui se lance
  automatiquement après N minutes d'inactivité. Réutilise le moteur Ken Burns.
  Activable et configurable dans les Réglages (1-30 min).
- 🖥️ **Fond d'écran** : « Définir comme fond d'écran » dans le menu contextuel
  d'une photo. Adaptation automatique selon l'OS (gsettings sur Linux,
  SystemParametersInfo sur Windows, osascript sur macOS).
- ✉️ **Envoi par email** : exporte la photo (éditions appliquées) en JPEG 1600px
  et ouvre le client email par défaut.
- 📝 **Export vers blog** : redimensionne à 1024px, copie le chemin dans le
  presse-papiers, ouvre le navigateur vers ton blog.
- 📤 **Export groupé** : sélectionne plusieurs photos et exporte-les en lot.
  Choix de la taille (original/1920/1024/800), du format (JPEG/WebP/PNG) et de
  la qualité. Barre de progression en temps réel.

## 🆕 Quoi de neuf en 2.0.0

- 🎬 **Diaporama avec transitions Ken Burns** : mode plein écran qui enchaîne
  les photos avec un effet de zoom/pan progressif et des transitions fondus
  (crossfade). Durée configurable (2-15s par photo), lecture/pause, navigation
  clavier (flèches, espace, échap). Barre de progression visuelle.
- 🖼️ **Collages** : assemble plusieurs photos dans une composition avec des
  layouts prédéfinis (grille, mosaïque, bande horizontale/verticale). Aperçu
  canvas en temps réel, export en JPEG/WebP/PNG.
- 🔤 **Texte sur photo** : ajoute du texte directement sur une photo dans
  l'éditeur. Police, graisse, taille, couleur, position (X/Y), opacité et
  ombre (couleur + flou). Parité preview/export garantie (même rendu Canvas
  et sharp SVG composite). Le texte est une opération du DSL EditStack —
  non-destructive, éditable à tout moment.

## 🆕 Quoi de neuf en 1.9.6

- 🔮 **Préchargement prédictif** : les miniatures des 20 prochaines lignes
  sont pré-décodées en arrière-plan (via le Web Worker) avant même d'être
  visibles. Intercalage avant/après — priorise les lignes les plus proches du
  viewport. Au scroll, les vignettes apparaissent instantanément depuis le
  cache LRU, sans décodage à la demande. Debounce de 150 ms pour éviter la
  surcharge.
- 📊 **SQLite ANALYZE automatique** : après chaque scan complet, `ANALYZE`
  met à jour les statistiques du query planner SQLite. Les plans de requête
  sont optimisés selon la distribution réelle des données — les requêtes de
  grille et de recherche restent rapides sur le long terme.

## 🆕 Quoi de neuf en 1.9.5

- 🧵 **Web Worker pour le décodage des miniatures** : le décodage des images
  se fait hors du main thread via `createImageBitmap()` dans un Web Worker
  (transfert zero-copy). Fallback sur `requestIdleCallback` si le protocole
  `thumb://` n'est pas accessible depuis le worker. Le main thread reste
  fluide pendant le chargement des vignettes.
- ♻️ **Cache LRU des miniatures** : les miniatures déjà décodées sont gardées
  en mémoire (cache LRU, 200 entrées max). Au scroll back, les vignettes
  s'affichent instantanément sans re-décodage. Éviction automatique avec
  `bitmap.close()` pour libérer la mémoire GPU.
- 📁 **Recherche par nom de dossier** : l'index FTS5 inclut désormais le
  chemin du dossier. Chercher « vacances 2023 » trouve les photos dans
  `/Photos/Vacances 2023/`. Migration 007 ajoutée.

## 🆕 Quoi de neuf en 1.9.4

- 🎨 **Rendu Canvas pour les vignettes** : les vignettes de la grille ne sont
  plus des éléments `<img>` DOM mais des `<canvas>` natifs — dessinés via
  `drawImage()` avec `createImageBitmap()` (décodage hors main thread).
  Moins de pression DOM, moins de reflow/layout, scroll plus fluide sur les
  très grandes bibliothèques. Gère le HiDPI (Retina), le redimensionnement
  dynamique (ResizeObserver), et conserve le retry exponentiel et le cache
  navigateur immutable. Se rapproche du rendu natif DirectX de Picasa 3.

## 🆕 Quoi de neuf en 1.9.3

- 📜 **Pagination incrémentale** : la grille ne charge plus 10 000 photos
  d'un coup. Un premier lot de 500 photos s'affiche instantanément, puis les
  suivantes se chargent automatiquement au fur et à mesure du défilement.
  Latence initiale drastiquement réduite sur les très grandes bibliothèques.
- 🎯 **Overscan adaptatif** : TanStack Virtual ajuste automatiquement le
  pré-rendu selon le nombre de cœurs du CPU — 8 lignes sur les machines
  10+ cœurs, 6 sur les 6+ cœurs, 4 sur les plus modestes. Moins de
  scintillement au scroll rapide sur les machines puissantes.

## 🆕 Quoi de neuf en 1.9.2

- 🧠 **Filtrage et tri SQL** : les filtres par note (étoiles) et par type
  (photo/vidéo) sont désormais gérés directement par SQLite via ses index
  partiels, au lieu d'un `Array.filter` + `Array.sort` en JavaScript sur
  10 000 photos. Le tri (date, nom, note) se fait aussi en SQL —
  quasi-instantané même sur de très grandes bibliothèques.
- 💾 **Scan économe en mémoire** : `getKnownFiles()` ne charge plus toute la
  table photos en RAM. Chaque worker du scan ne reçoit que les fichiers
  connus de sa partition — réduction de 50 à 100 Mo d'empreinte mémoire sur
  les bibliothèques de plusieurs centaines de milliers de photos.

## Quoi de neuf en 1.9.1

- 🔍 **Recherche plein texte FTS5** : la recherche passe sur un index SQLite
  **FTS5** ultra-rapide — une seule requête intercepte le nom de fichier, la
  légende, les tags et les personnes reconnues. Insensible aux accents (café,
  ecole, etc.), préfixe `*` pour les suffixes, opérateurs `AND` / `OR` / `NOT`.
  15 triggers SQL synchronisent l'index en temps réel (insert, update, delete)
  — aucune réindexation manuelle à gérer.
- ⚡ **Scan multi-worker** : le scan de la bibliothèque exploite désormais
  tous les cœurs du CPU. Un pool de `cpus − 1` workers scanne les dossiers
  en parallèle — un worker par racine, ou partition par sous-dossiers du
  premier niveau si une seule racine. La progression est agrégée et le
  pipeline post-scan n'est lancé qu'une fois tous les workers terminés.

## Quoi de neuf en 1.9.0

- 📱 **Galerie mobile** : consulte ta bibliothèque depuis ton téléphone via un
  petit serveur que tu héberges toi-même (`web-server/`, prêt pour Coolify).
  Seules les miniatures et métadonnées sont envoyées — **zéro original dans
  le cloud**. Synchronisation incrémentale en un clic depuis les Réglages.

## Quoi de neuf en 1.8.2

- 📦 **Taille des installeurs divisée par 2 à 3** (suite) : AppImage ~96 Mo,
  compression maximum, locales Electron réduites (fr/en)
- 🐛 **Miniatures vidéo sur systèmes sans ffmpeg** (dont les runners CI) :
  téléchargement unique et automatique du binaire officiel, mis en cache

## Quoi de neuf en 1.8.1

- 📦 **AppImage 274 → 123 Mo (−55 %)** : dépendance morte de 232 Mo supprimée,
  modèles de reconnaissance faciale réduits à l'essentiel (28 → 7 Mo),
  dépendances dédoublonnées, compression maximum
- 🐛 Correctif de packaging : une bibliothèque native piégée dans l'archive
  empêchait son chargement ; nouveau garde-fou CI testant le binaire packagé

## Quoi de neuf en 1.8.0

- ⚡ **Performance façon Picasa 3**, mesurée sur 50 000 photos : miniatures en
  cache navigateur permanent (zéro requête au re-scroll), chargement de vue
  2,8× plus rapide (colonnes ciblées, IPC −45 %), index SQL partiels, SQLite
  affûté (cache 64 Mo, mmap 256 Mo)

## Quoi de neuf en 1.7.0

- 🖱️ **Glisser-déposer** : vignettes → albums, dossiers/fichiers de
  l'explorateur → scan ou import automatique
- 🎚️ **Barre de critères d'affichage** : tri (date/nom/note), filtre ★ minimum
  et photos/vidéos, vignettes carrées ou ratio préservé — mémorisés

## Quoi de neuf en 1.6.0

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

## Quoi de neuf en 1.2.0

- 🎬 **Vidéos dans les films** : mixe photos et vidéos dans un même MP4 —
  segments normalisés puis assemblage en copie de flux (pas de double
  ré-encodage), transitions en fondu, multi-pistes audio
- 🖼️ **Miniatures vidéo** dans la grille (frame à 10 % de la durée) avec badge
  🎬 + durée
- 🧩 **timeline-core** : fondation du futur éditeur de montage (pistes, trim,
  crossfade/wipe/slide)

## Quoi de neuf en 1.1.0

- 👥 **Gestion manuelle des visages** : fusion de personnes (avec transfert de
  nom vers une cible anonyme, centroïde recalculé sur les embeddings réels),
  scission, confirmation/rejet des rattachements automatiques
- Panneau dédié dans la vue Personne, avatars triés par confiance croissante
  (les cas douteux en premier), sélection multiple

## Quoi de neuf en 1.0.0

Les 5 phases du plan initial sont couvertes :

- 🧩 **Créations** : collages (4 mises en page), diaporama plein écran, movie
  maker MP4 avec audio
- 🗺️ **Visages & carte** : reconnaissance faciale 100 % offline, clustering
  automatique par similarité, géotag manuel sur carte MapLibre
- 🔁 **Gestion avancée** : watcher temps réel, import SD/appareil photo,
  détection et fusion de doublons
- 📤 **Partage** : export batch avec filigrane, CSV des métadonnées,
  impression, email, migration de bibliothèque par hash, masquage protégé

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
- [x] Auto-update (electron-updater + releases GitHub), menu applicatif complet (Aide fonctionnelle), refonte de la barre d'actions du bac (groupes étiquetés, style navy/orange)
- [x] Convivialité — lightbox (zoom 5×, 100 % pixels réels, navigation clavier), sélection façon explorateur (Ctrl/Shift/Ctrl+A), menu contextuel clic droit, grille groupée par mois avec mois épinglé, vue Chronologie, curseur de taille des vignettes, panneau d'infos EXIF/GPS/tags/albums
- [x] Glisser-déposer (vignettes → albums, dossiers/fichiers OS → scan/import), barre de critères d'affichage (tri, filtre ★/type, ratio des vignettes) — mémorisés
- [x] Performance : cache navigateur permanent des miniatures, colonnes IPC ciblées (−45 %), index SQL partiels, pragmas SQLite, mesuré sur 50 000 photos
- [x] Taille des installeurs réduite de 50 à 65 % (résolveur ffmpeg à la demande, modèles de visages allégés, dépendances nettoyées) ; CI multi-OS (Linux/Windows/macOS) avec release automatique sur tag
- [x] Galerie mobile (`web-server/`) : miroir léger miniatures+métadonnées, synchronisation incrémentale desktop→VPS, déploiement Coolify documenté

## Licence

MIT
