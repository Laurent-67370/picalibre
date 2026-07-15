# Changelog

Toutes les évolutions notables de PicaLibre sont documentées ici.
Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/) — versionnage sémantique.

## [2.7.0] — 2026-07-15

### Ajouté — annulation façon Picasa
- **Annuler (Ctrl/⌘+Z)** pour l'action « Masquer / afficher » : un bandeau
  discret apparaît en bas de l'écran pendant ~8 s après un masquage ou un
  démasquage (« 3 photo(s) masquée(s) — ↩ Annuler »), reproduisant le
  comportement historique de Picasa — un seul niveau d'annulation pour la
  toute dernière action, plutôt qu'une pile complexe. C'est l'action la
  plus fréquente et la plus « silencieusement destructive » de PicaLibre
  (aucune confirmation avant de masquer), donc la première à en profiter.
  Architecture en union discriminée pour étendre facilement à d'autres
  actions (notation, tag…) par la suite.

## [2.6.0] — 2026-07-15

### Ajouté — fiabilité et diagnostic
- **Logs persistants** (`electron-log`) : tous les `console.log`/`console.error`
  déjà présents dans le code (scanner, pipeline, ffmpeg, updater…) sont
  désormais aussi écrits dans `userData/logs/main.log` (rotation à 5 Mo).
  Jusqu'ici, la seule façon de diagnostiquer un échec silencieux (ex. la
  vignette vidéo qui ne se générait pas) était de relancer l'app depuis un
  terminal. Accessible via **Aide → Ouvrir le dossier des logs**.
- **Rescan léger automatique au démarrage** : jusqu'ici, seul le watcher de
  fichiers démarrait tout seul — si le pipeline avait échoué une fois sur
  un fichier (miniature vidéo notamment) ou si des fichiers avaient été
  ajoutés pendant que l'app était fermée, rien ne relançait jamais le
  traitement sans action explicite (ajout d'un nouveau dossier). Un scan
  léger se relance désormais automatiquement à chaque lancement, dès qu'au
  moins un dossier est déjà configuré (désactivé en mode test headless).

### Corrigé — résilience du pipeline vidéo
- **Timeout de sécurité sur les appels `ffmpeg`** (génération de miniature
  vidéo, sondage de durée) : un process qui reste bloqué (disque lent,
  fichier corrompu, environnement CI capricieux) est désormais tué après
  15-20 s au lieu de figer tout le pipeline indéfiniment.
- **Retry + timeout sur le téléchargement du binaire ffmpeg** (premier
  usage vidéo sans ffmpeg système/embarqué) : jusqu'à 3 tentatives avec
  délai croissant (2 s, 4 s) et timeout de 60 s par tentative, au lieu
  d'un unique essai sans filet. Fait suite à un échec CI Linux ponctuel
  (probable aléa réseau) observé sur la 2.5.1, résolu par un simple
  re-run mais révélant l'absence de résilience à cet endroit.

## [2.5.1] — 2026-07-15

### Corrigé
- **macOS : la mise à jour se télécharge mais ne s'installe jamais**,
  même en cliquant sur « Redémarrer et installer ». Cause racine :
  Squirrel.Mac (le mécanisme d'installation d'electron-updater sur macOS)
  exige une signature **Developer ID Apple réelle** (payante, 99 $/an)
  pour remplacer le `.app` en place — c'est documenté par Electron
  lui-même. La signature ad-hoc de PicaLibre (depuis la 2.3.2) suffit à
  satisfaire Gatekeeper au premier lancement, mais pas cette validation
  d'installation-là : `quitAndInstall()` échouait silencieusement, sans
  aucune erreur visible. Le bouton ouvre désormais la page de release
  GitHub pour un remplacement manuel du `.app` (comme pour un premier
  téléchargement), avec un message clair expliquant pourquoi.
- ⚠️ **Cette mise à jour vers la 2.5.1 elle-même** devra probablement être
  installée manuellement une dernière fois (le correctif n'est actif
  qu'une fois la 2.5.1 déjà en place) — les mises à jour suivantes
  ouvriront correctement la page de téléchargement.

## [2.5.0] — 2026-07-15

### Ajouté — thème clair inspiré de Picasa 3 (par défaut) + thème sombre en option
- **Nouveau thème clair, par défaut** : palette gris argenté/blanc inspirée
  de Picasa 3, avec l'orange PicaLibre conservé comme accent principal
  (cohérence avec le logo et les badges du dépôt) et le bleu de sélection
  historique repris pour les surbrillances — proche de l'esprit Picasa
  tout en restant identifiable comme PicaLibre.
- **Thème sombre navy/orange** conservé à l'identique (mêmes valeurs
  hexadécimales qu'avant), sélectionnable dans **Réglages → 🎨 Apparence**.
  Préférence persistée (`localStorage`), appliquée avant le premier rendu
  pour éviter tout flash du mauvais thème.
- **Modes immersifs volontairement sombres dans les deux thèmes** :
  visionneuse plein écran, éditeur, lecteur de film/diaporama, aperçu
  collage, panneaux flottants de la carte — comme Picasa, Lightroom ou
  Photos, l'espace de visualisation/retouche reste sombre indépendamment
  du thème de l'appli, pour ne pas fausser le jugement des couleurs et
  rester lisible par-dessus des photos ou des tuiles de carte variées.
- *Note technique* : ~90 couleurs codées en dur remplacées par des tokens
  CSS (`--bg`, `--card`, `--border`, `--text`, `--muted`, `--select`,
  `--star`, `--success`, `--danger`…) dans `styles.css` et les composants
  du renderer. Plusieurs premiers remplacements automatiques s'étaient
  révélés incorrects par endroits (bordures/texte de panneaux volontai-
  rement sombres qui suivaient à tort le thème, cassant le contraste en
  clair) — corrigés après relecture ciblée et vérification par capture
  d'écran réelle (Xvfb + Electron).

## [2.4.0] — 2026-07-15

### Ajouté — refonte de la barre de menus : tout devient trouvable
- **Constat** : plusieurs fonctionnalités n'étaient visibles qu'une fois
  « tombé dessus » — le panier en bas de fenêtre n'affichait Collage, Film,
  Export groupé, Impression, Email et CSV qu'après avoir déjà sélectionné
  des photos ; aucun moyen de relancer un scan de la bibliothèque sans
  rajouter un dossier ; aucune liste de raccourcis clavier.
- **Nouveau menu « Bibliothèque »** : Chronologie, Carte, Doublons, Photos
  masquées, Analyser les visages — la navigation qui n'existait qu'en
  barre latérale est désormais aussi dans la barre de menus.
- **Nouveau menu « Outils »** : Diaporama, Collage, Film, Impression,
  Export (simple/groupé), Email, CSV — chaque action indique clairement
  qu'une sélection est requise si le panier est vide, au lieu de rester
  invisible.
- **Menu « Édition » enrichi** : Éditer la sélection, Noter (0 à 5 ★),
  Taguer, Créer un album, Masquer/afficher, Vider la sélection — en plus
  des rôles natifs (Annuler/Copier/Coller…).
- **Menu « Fichier »** : nouvelle entrée **Rescanner la bibliothèque**
  (Ctrl/⌘+Maj+R) — comble un vrai manque identifié en 2.3.x : le pipeline
  de miniatures ne se relançait jamais automatiquement au démarrage,
  seul un nouvel ajout de dossier le déclenchait.
- **Aide → Raccourcis clavier** : liste complète (clic, Ctrl/⌘+clic,
  Maj+clic, double-clic, glisser-déposer, molette, flèches, E) — plus
  aucun geste caché.
- *Note technique* : accélérateurs choisis en évitant deux conflits
  potentiels — `E` n'est **pas** un raccourci global (aurait cassé la
  frappe de la lettre « e » dans tous les champs texte de l'app) et reste
  scindé à la visionneuse ; `Ctrl/⌘+R` (déjà pris par le rôle natif
  « Recharger ») a été évité au profit de `Ctrl/⌘+Maj+R` pour Rescanner.

## [2.3.4] — 2026-07-15

### Corrigé
- **Lecture vidéo toujours impossible malgré le lecteur ajouté en 2.3.3** :
  le schéma `thumb://` était enregistré sans le privilège **`stream: true`**
  (`protocol.registerSchemesAsPrivileged`). Sans lui, Chromium refuse de
  traiter `thumb://library/orig/{id}` comme une source média valide pour
  `<video>` — échec entièrement silencieux, aucune erreur visible côté
  renderer. C'est la cause racine confirmée en testant sur machine réelle
  (Mac mini M4) : le lecteur ajouté en 2.3.3 ne se déclenchait jamais.
- **Seek vidéo cassé (corollaire)** : le handler `orig` refaisait un
  `net.fetch` neuf sans transmettre les en-têtes `Range` de la requête
  d'origine — chaque déplacement dans la barre de progression aurait
  re-téléchargé le fichier depuis le début (`currentTime` revenant
  toujours à 0, bug documenté d'Electron sur ce pattern). Les en-têtes de
  la requête entrante sont désormais transmis à `net.fetch`.

## [2.3.3] — 2026-07-15

### Ajouté
- **Lecture vidéo dans la visionneuse plein écran** : `Lightbox.tsx` ne
  contenait aucune balise `<video>` — le double-clic sur un fichier vidéo
  ouvrait la même visionneuse que pour les images, qui tentait d'afficher
  le flux `.mp4` (servi par `thumb://library/orig/{id}`) dans une balise
  `<img>`, incapable de le lire. Résultat : rien ne s'affichait et aucune
  lecture n'était possible. Ajout d'un lecteur `<video controls autoPlay>`
  natif dédié pour `media_type === 'video'`, avec navigation ← → conservée
  et zoom/pan/molette/édition désactivés (non pertinents pour une vidéo).

### Connu — vignette vidéo dans la grille
- La génération de miniature vidéo (frame ffmpeg → cache webp) reste
  déléguée au pipeline de fond (`videoThumbsPhase`) ; ses erreurs ne sont
  loggées qu'en console (jamais remontées à l'UI). Si une vignette reste
  vide durablement, lancer l'app depuis un terminal pour capturer le
  message `[video-thumb] ...` exact.

## [2.3.2] — 2026-07-15

### Corrigé
- **macOS : message Gatekeeper « L'app est endommagée » sur Apple Silicon**.
  Sans certificat Apple Developer, electron-builder ne signait pas le
  `.app` — sur arm64, un bundle non signé déclenche ce message trompeur au
  lieu du simple avertissement « développeur non identifié » obtenu sur
  Intel. Ajout d'un hook `afterPack` qui signe le bundle en ad-hoc
  (`codesign --deep --force --sign -`) juste avant la mise en DMG/zip —
  suffisant pour satisfaire Gatekeeper localement, sans notarisation.

## [2.3.1] — 2026-07-14

### Corrigé — vérification approfondie des fonctionnalités 2.0.0→2.3.0
- **Bug critique : le scan plantait entièrement sur les machines à 1-2 cœurs
  logiques.** Le partitionnement multi-worker du scanner (`partitionRoots`)
  faisait un modulo par zéro (`partitions.length - 1 === 0`) lors de la
  répartition round-robin des sous-dossiers quand un seul worker était
  disponible → `TypeError: Cannot read properties of undefined (reading
  'roots')`, scan totalement bloqué (aucune photo jamais indexée). Corrigé :
  sur machine mono/bi-cœur, un seul worker pleinement récursif scanne tout,
  sans partitionnement shallow/récursif qui n'a pas de sens à un seul worker.
- **Fallback RAW/PSD jamais déclenché** : `sharp(...).metadata()` lève une
  exception sur un format non supporté par libvips (RAW propriétaire, PSD
  sans plugin) au lieu de renvoyer `{width: undefined}` comme le supposait le
  code — l'exception remontait directement au bloc catch englobant, court-
  circuitant le fallback `exiftool.extractPreview()`. Corrigé avec un
  try/catch dédié autour de `.metadata()`. **Limite structurelle à connaître**
  (pas un bug) : le fallback ne peut réussir que si le fichier RAW/PSD a une
  preview JPEG intégrée — quasi systématique pour les RAW d'appareils photo,
  variable pour les PSD selon l'option « Maximiser la compatibilité ».
- Nouveau script de non-régression `scripts/test-raw-psd-fallback.ts`.

### Vérifié — tests réels effectués (pas de simulation)
- Bordures/cadres (DSL `border`) : dimensions exactes, couleur pixel-parfaite,
  variante polaroid, déterminisme — validé sur export sharp réel.
- Géolocalisation : 3 photos avec vraies coordonnées EXIF GPS (Tour Eiffel,
  Strasbourg, Nice) → extraction EXIF correcte, carte Leaflet rendue avec les
  3 marqueurs et 20 tuiles OSM chargées (sonde DOM + capture d'écran réelle).

## [2.3.0] — 2026-07-14

### Ajouté — Géolocalisation et carte interactive
- **Lecture GPS EXIF** : extraction de GPSLatitude/GPSLongitude/GPSAltitude
  via exiftool-vendored (déjà en place dans le pipeline metadata).
- **Migration 008** : index spatial optimisé `idx_photos_gps_spatial` sur
  `(gps_lat, gps_lon)` avec filtre partiel `WHERE gps_lat IS NOT NULL`.
- **Handlers IPC** :
  - `photos:withGeo` : photos dans une bounding box (south/west/north/east)
    + filtres grille (minStars, typeFilter).
  - `photos:reverseGeocode` : géocoding inverse via Nominatim.
- **Carte interactive** : composant `MapView.tsx` avec Leaflet +
  OpenStreetMap. Marqueurs clusterisés, clic → lightbox.
- **Filtrage par lieu** : photos dans la zone visible de la carte uniquement.
- **Bouton « Carte »** dans la barre d'outils.
- **Fallback offline** : message si pas de connexion aux tuiles OSM.
- Respect de `gps_manual = 1` (ne pas écraser un géotag manuel).

## [2.2.0] — 2026-07-14

### Ajouté — Face Movies
- Diaporama spécial centré sur un visage spécifique.
- Zoom sur la bounding box du visage (coordonnées normalisées 0-1).
- Ken Burns adapté : amplitude de pan réduite, zoom de base calculé pour
  que le visage occupe ~60% de l'écran.
- Crossfade entre photos (deux calques).
- Bouton « Face Movie » dans la vue d'une personne.

### Ajouté — Impression
- Layouts : planche contact (5×7), plein page, grille 2×3, grille 3×3.
- Formats papier : A4, A3, Letter, Legal (dimensions @page en mm).
- Marges configurables (slider 0-30mm).
- Prévisualisation avant impression (dialogue avec miniatures).
- CSS `@media print` dédié.
- Bouton Imprimer dans la barre d'outils.

### Ajouté — RAW natif
- Extensions supportées : .CR2, .NEF, .ARW, .RAF, .ORF, .DNG.
- Miniatures via sharp (libvips) avec fallback exiftool (extractJpgFromRaw
  puis extractPreview) si sharp ne peut pas décoder.
- Métadonnées EXIF via exiftool-vendored (lit nativement les RAW).
- Hash xxh3 sur le fichier RAW entier.

### Ajouté — PSD
- Extension .psd ajoutée aux images supportées.
- Sharp/libvips extrait le calque fusionné.
- Fallback exiftool (extractPreview) si sharp échoue.

## [2.1.0] — 2026-07-14

### Ajouté — Cadres et bordures
- Opération `border` dans le DSL EditStack (non-destructive, parité preview/export).
- Styles : `solid` (bordure uniforme) et `polaroid` (bord bas 4× plus épais).
- Paramètres : épaisseur (% de la largeur), couleur.
- UI complète dans l'éditeur : checkbox, select style, slider, color picker.

### Ajouté — Écran de veille photo (screensaver)
- Diaporama plein écran après N minutes d'inactivité (configurable 1-30 min).
- Réutilise le moteur Ken Burns (Slideshow.tsx).
- Détection d'inactivité : mousemove, keydown, scroll, click, wheel, touchstart.
- N'importe quelle interaction quitte le screensaver (curseur masqué).
- Persistance des préférences dans localStorage.

### Ajouté — Fond d'écran (wallpaper setter)
- « Définir comme fond d'écran » dans le menu contextuel d'une photo.
- Linux : `gsettings set org.gnome.desktop.background picture-uri`.
- Windows : PowerShell `SystemParametersInfo SPIF_SETDESKWALLPAPER`.
- macOS : `osascript` System Events.
- Exporte la photo avec éditions appliquées vers un fichier temporaire.

### Ajouté — Envoi par email
- « Envoyer par email » dans le menu contextuel.
- Export JPEG 1600px vers fichier temporaire.
- Ouvre le dossier + lance le client mail (mailto:).

### Ajouté — Export vers blog
- « Exporter vers blog » dans le menu contextuel.
- Redimensionne à 1024px, JPEG qualité 88.
- Copie le chemin dans le presse-papiers, ouvre le navigateur.

### Ajouté — Export groupé (batch export)
- Handler IPC `photos:batchExport` : liste de photoIds, dossier, taille, format, qualité.
- Tailles : original, 1920px, 1024px, 800px. Formats : JPEG, WebP, PNG.
- Barre de progression via IPC (`batch:progress`).
- Bouton « Export groupé » dans l'UI avec dialogue d'options.

## [2.0.0] — 2026-07-14

### Ajouté — Diaporama avec transitions Ken Burns
- Mode plein écran qui enchaîne les photos filtrées de la grille.
- Effet Ken Burns : zoom/pan progressif déterministe (seed par photo ID).
- Transitions fondus (crossfade) entre les photos — deux calques alternent.
- Durée configurable : 2-15s par photo (5s par défaut), slider dans l'UI.
- Contrôles : lecture/pause, flèches gauche/droite, espace, échap.
- Barre de progression visuelle en bas.
- Utilise `thumb://library/1024/{photoId}` pour la qualité.

### Ajouté — Collages
- Layouts prédéfinis : grille, mosaïque, bande horizontale, bande verticale.
- Aperçu canvas en temps réel avec rendu cover-fit.
- Export multi-format : JPEG, WebP, PNG (sélecteur dans l'UI).
- Composant `CollagePreview` (220 lignes) avec `computePreviewLayout()`.
- IPC étendu avec paramètre `format` optionnel sur `create:collage`.

### Ajouté — Texte sur photo (opération DSL EditStack)
- Nouveau type `TextOpParams` et opération `text` dans le DSL EditStack.
- Paramètres : contenu, police, graisse, taille, couleur, position X/Y
  (normalisés 0-1), opacité, ombre (couleur + flou).
- Rendu Canvas 2D (`drawText()`) pour la preview.
- Composite SVG pour l'export sharp (filtre `feGaussianBlur` pour l'ombre).
- Parité preview/export garantie (mêmes coordonnées, même fontSize relatif,
  même positionnement centre).
- Texte vide = opération neutre (suppression automatique).
- Dessiné/composé en dernier, après toutes les opérations couleur et spatiales.
- UI complète dans l'éditeur.

## [1.9.6] — 2026-07-14

### Performance — Préchargement prédictif des miniatures
- Nouveau module `thumb-prefetch.ts` : pré-décode les miniatures des lignes
  avant et après le viewport via le Web Worker existant.
- Limite stricte à 20 miniatures en avance (`PREFETCH_LIMIT`).
- Intercalage avant/après : priorise les lignes les plus proches du viewport.
- Insère les `ImageBitmap` décodés dans le cache LRU → dessin instantané.
- Ensemble `inFlight` (Set) pour éviter les décodages dupliqués.
- Vérifie `thumbCache.has()` avant de lancer un décodage.
- Debounce de 150 ms sur le scroll listener pour éviter la surcharge.
- `cleanupPrefetch()` au démontage.

### Performance — SQLite ANALYZE automatique
- `ANALYZE` exécuté après chaque scan complet dans `pipeline.ts`.
- Met à jour les statistiques du query planner SQLite sur la distribution des
  données dans les tables et index.
- Les plans de requête sont optimisés selon les données réelles — les requêtes
  de grille et de recherche FTS5 restent rapides sur le long terme.

## [1.9.5] — 2026-07-14

### Performance — Web Worker pour le décodage des miniatures
- Nouveau Web Worker (`thumb-decoder.worker.ts`) qui reçoit une URL `thumb://`,
  fait `fetch` + `createImageBitmap`, et renvoie l'`ImageBitmap` au main thread
  (transférable, zero-copy).
- `ThumbCanvas` tente le Web Worker en priorité. Si le protocole custom n'est
  pas accessible depuis le worker (Electron), fallback sur `createImageBitmap`
  + `requestIdleCallback` dans le main thread (polyfill inclus).
- Le main thread reste fluide pendant le chargement des vignettes.

### Performance — Cache LRU des miniatures en mémoire
- Classe `ThumbLRUCache` avec Map ordonnée (ordre d'insertion = ordre LRU).
- `get()` met à jour l'accès LRU (delete + re-insert), compte hits/misses.
- `set()` éviction automatique avec `bitmap.close()` pour libérer la mémoire GPU.
- Taille max 200 entrées (~50 Mo avec des 256px WebP).
- Au scroll back, les vignettes s'affichent instantanément sans re-décodage.

### Ajouté — Recherche par nom de dossier (FTS5)
- Migration 007 : ajoute la colonne `folder` à la table `photos_search_content`
  et à l'index FTS5 `photos_fts`.
- Triggers de synchronisation mis à jour pour peupler `folder` depuis la table
  `folders` (LEFT JOIN).
- La recherche FTS5 `MATCH` interroge automatiquement toutes les colonnes —
  chercher « vacances 2023 » trouve les photos dans `/Photos/Vacances 2023/`.

## [1.9.4] — 2026-07-14

### Performance — Rendu Canvas pour les vignettes
- Remplacement des éléments `<img>` par des `<canvas>` natifs pour le rendu
  des vignettes de la grille.
- Nouveau composant `ThumbCanvas` (228 lignes) :
  - Chargement via `createImageBitmap()` (décodage off-main-thread) avec
    fallback sur `Image()` classique.
  - Dessin sur canvas via `drawImage()` avec calcul manuel cover/contain.
  - Gestion du `devicePixelRatio` pour un rendu net sur écrans HiDPI (Retina).
  - `ResizeObserver` pour suivre la taille du conteneur et redessiner.
  - Retry exponentiel conservé : 500ms → 1s → 2s → 4s → 8s.
  - Annulation du chargement en cours si la photo change.
  - Protocole `thumb://` et cache navigateur immutable inchangés.
- Remplace le composant `ThumbImg` dans `App.tsx` pour le rendu de la grille.
- Réduit la pression DOM (moins d'éléments = moins de React reconciliation).

## [1.9.3] — 2026-07-14

### Performance — Pagination incrémentale (infinite scroll)
- Remplacement de `PAGE = 10000` par `PAGE_SIZE = 500` — la grille ne
  charge plus 10 000 photos d'un coup.
- Premier lot de 500 photos affiché instantanément, puis chargement
  automatique des pages suivantes au défilement.
- `loadMore()` demande la page suivante via IPC avec `offset = photos.length`,
  concatène les résultats, met à jour `hasMore`.
- Listener scroll : déclenche `loadMore()` quand il reste < 500px à scroller.
- Latence initiale drastiquement réduite sur les très grandes bibliothèques.

### Performance — Overscan adaptatif
- `computeAdaptiveOverscan()` — ajuste le pré-rendu TanStack Virtual selon
  `navigator.hardwareConcurrency` :
  - ≥ 10 cœurs → overscan 8 (pré-rendu plus large)
  - ≥ 6 cœurs → overscan 6
  - ≤ 4 cœurs → overscan 4 (prudent)
- Moins de scintillement au scroll rapide sur les machines puissantes.

## [1.9.2] — 2026-07-14

### Performance — Filtrage et tri SQL
- Les filtres **minStars** (note minimale) et **typeFilter** (photo/vidéo)
  sont désormais appliqués côté SQL via `buildFilterClauses()`, utilisant
  les index partiels existants (`idx_photos_grid_folder`,
  `idx_photos_grid_timeline`).
- Le tri (`sortMode`) se fait en SQL via `buildOrderBy()` — date desc/asc,
  nom, note — au lieu d'un `Array.sort` en JavaScript.
- 5 handlers IPC mis à jour : `photos:timeline`, `photos:byFolder`,
  `photos:byAlbum`, `photos:search`, `photos:byPerson`.
- `App.tsx` : suppression du `useMemo` de filtrage/tri JS, passage des
  filtres via IPC, rechargement automatique de la vue quand les filtres
  changent.
- Types `GridFilters` / `SortMode` / `TypeFilter` ajoutés dans `ipc.ts`.

### Performance — Scan économe en mémoire (getKnownFiles)
- `getKnownFiles()` ne charge plus toute la table photos en `Map` JS.
- Nouvelle fonction `getKnownFilesForRoots(roots, shallow)` filtre par
  partition — chaque worker du scan multi-worker ne reçoit que les fichiers
  connus de sa partition.
- Réduction de 50 à 100 Mo d'empreinte mémoire sur les bibliothèques de
  plusieurs centaines de milliers de photos.

## [1.9.1] — 2026-07-14

### Ajouté — Recherche plein texte FTS5
- **Index FTS5 SQLite** : la recherche photos passe d'un `LIKE` SQL sur
  colonnes à une table virtuelle **FTS5** indexant `filename`, `caption`,
  `tags` et `persons` — une seule requête MATCH intercepte tous les champs.
- **Insensible aux accents** : un tokenizer personnalisé (`remove_diacritics`)
  normalise `café` → `cafe`, `école` → `ecole` ; on peut chercher dans les
  deux sens sans se soucier des accents.
- **15 triggers SQL** synchronisent l'index FTS5 automatiquement en temps réel
  sur `INSERT` / `UPDATE` / `DELETE` des tables `photos`, `tags`,
  `photo_tags` et `persons` — aucune réindexation manuelle, aucune maintenance.
- Handler IPC `photos:search` réécrit pour tirer parti du FTS5 : support des
  opérateurs `AND` / `OR` / `NOT`, préfixe `*` pour les suffixes, classement
  par pertinence (`bm25`), fallback automatique si la requête est vide.
- Migration 006 créée et testée.

### Performance
- La recherche est désormais quasi-instantanée même sur des dizaines de
  milliers de photos, là où les `LIKE '%terme%'` devenus lents devaient
  parcourir toute la table.

### Ajouté — Scan multi-worker (parallélisation)
- **Pool de workers** : le scan de la bibliothèque lance désormais
  `cpus − 1` workers en parallèle au lieu d'un seul. Chaque worker parcourt
  sa partition de dossiers de manière indépendante.
- **Multi-racines** : les racines configurées sont réparties en round-robin
  sur les workers disponibles.
- **Racine unique** : la racine est partitionnée par sous-dossiers de premier
  niveau — un worker « shallow » scanne les fichiers à la racine, les autres
  scannent récursivement chacun un sous-dossier.
- **Progression agrégée** : le main process somme les compteurs de tous les
  workers et envoie une progression unifiée au renderer.
- **Pipeline post-scan** : lancé une seule fois après la terminaison de tous
  les workers (compteur `workersDone` + flag `pipelineStarted`).
- Protocole IPC inchangé : chaque worker envoie `batch` / `progress` / `done`
  / `error` exactement comme avant. Les transactions SQLite étant synchrones,
  les batches parallèles ne créent pas de conflit.

## [1.9.0] — 2026-07-14

### Ajouté — Galerie mobile (« vue web depuis le VPS »)
- **`web-server/`** : nouveau service Node/Express déployable sur ton propre
  VPS (Dockerfile fourni, compatible Coolify — même pattern que tes autres
  apps sur Oracle Cloud). Miroir **léger** : miniatures 256/1024 webp +
  métadonnées seulement, **aucun fichier original ne quitte le poste**.
  Protégé par un jeton `Bearer` obligatoire sur toute l'API.
- Page mobile en HTML/JS vanilla (zéro framework, thème navy/orange) :
  connexion par URL + jeton, navigation Chronologie/Dossiers/Albums,
  recherche, défilement infini, visionneuse plein écran.
- **Synchronisation desktop → serveur** (Réglages → « 📱 Galerie mobile ») :
  incrémentale via une table `web_sync` (photo_id → hash déjà envoyé), ne
  renvoie que le nouveau ou le modifié ; vérifie aussi les miniatures déjà
  présentes côté serveur avant upload (reprise propre après coupure) ; bouton
  « Tester la connexion » et barre de progression par phase.
- Nouveau job CI dédié : lance le serveur, synchronise une vraie bibliothèque
  scannée par l'app desktop, vérifie les photos et miniatures côté serveur.

## [1.8.2] — 2026-07-14

### Performance (taille des applications, suite)
- **AppImage 123 → ~96 Mo** (−65 % cumulé depuis la v1.8.0 à 274 Mo) :
  compression maximum, locales Electron réduites (fr/en), nettoyage des
  fichiers annexes des dépendances (docs, types, exemples).
- Nouvelle étape CI : **E2E sur le binaire réellement packagé** (pile native
  dans `app.asar.unpacked`) — attrape les régressions de packaging que le
  build de dev ne voit pas.

### Corrigé
- **Miniatures vidéo impossibles sur les systèmes sans ffmpeg** (dont les
  runners GitHub ubuntu-24.04, contrairement à l'hypothèse initiale) : le
  résolveur **télécharge désormais le binaire officiel une seule fois** vers
  `userData/bin` (même source que le paquet npm), le vérifie (`-version`) et le
  met en cache — validé sur le binaire packagé sans ffmpeg système
  (téléchargement → installation → miniature vidéo → pipeline OK).
  ffmpeg-static réellement dédoublonné (dependencies uniquement).
- **Crash au démarrage du paquet Linux** (« Cannot find module
  'ffmpeg-static' ») : le module, volontairement exclu du paquet Linux
  (−77 Mo, ffmpeg système utilisé en priorité), était encore importé au
  niveau module → chargement paresseux et optionnel dans le résolveur, et
  dépendance dédoublonnée (elle figurait en dependencies **et**
  devDependencies). Validé sur le binaire packagé : pipeline complet OK.

## [1.8.1] — 2026-07-12

### Taille des installeurs (AppImage : 274 → 123 Mo, −55 %)
- Suppression de **ffprobe-static** : dépendance morte de 232 Mo (binaires de
  toutes les plateformes) — la durée des vidéos est déjà lue via `ffmpeg -i`.
- **Modèles de visages** : seuls blazeface + faceres (utilisés) sont embarqués,
  au lieu des 20 modèles de la distribution Human (28 → 7 Mo).
- maplibre-gl déplacé en devDependency (il est bundlé par Vite, il était
  embarqué en double) ; variante musl de libvips exclue (−16 Mo) ; sources et
  intermédiaires de compilation de better-sqlite3 exclus ; compression maximum.

### Corrigé
- **libvips (sharp) piégé dans l'asar** : une bibliothèque native ne peut pas
  être chargée depuis l'archive — `asarUnpack` couvre désormais `@img`,
  exiftool-vendored et ffmpeg-static. Bug latent invisible car l'E2E testait
  le mode dev, jamais le paquet.
- **Nouveau garde-fou CI** : l'E2E complet tourne aussi sur le **binaire
  packagé** Linux (scan + EXIF + miniatures = sqlite/exiftool/sharp validés
  dans l'asar.unpacked).

## [1.8.0] — 2026-07-12

### Performance (mesures sur bibliothèque de 50 000 photos)
- **Cache navigateur des miniatures** : réponses `immutable` avec le hash de
  contenu en version d'URL → re-scroller la grille ne déclenche plus **aucune**
  requête (elles partaient toutes en revalidation). C'est le gain « Picasa ».
- **Cache mémoire des chemins de miniatures** dans le protocole `thumb://` :
  plus de requête SQL ni de stat disque par vignette (2 000 vignettes :
  9 ms → 1,4 ms, premier affichage).
- **Chargement de vue 2,8× plus rapide** : colonnes de grille explicites au
  lieu de `SELECT *` (10 000 lignes : 190 → 67 ms) et **payload IPC −45 %**.
- **Index SQL partiels** ciblant les photos visibles (dossier+date, chronologie,
  miniatures) — vérifiés au plan d'exécution.
- **SQLite affûté** : 64 Mo de cache de pages, mmap 256 Mo, temp en mémoire.
- **Rechargements coalescés pendant le scan** : au plus un rafraîchissement de
  vue toutes les 1,2 s au lieu d'un par lot de 200 fichiers.
- Nouveau banc de mesure `PICALIBRE_TEST_BENCH` (seed 50 k, chronos, plans SQL).

## [1.7.0] — 2026-07-12

### Ajouté
- **Glisser-déposer interne** : glisser une vignette (ou toute la sélection)
  sur un album de la barre latérale l'y ajoute — l'album cible se surligne en
  pointillés orange pendant le survol.
- **Glisser-déposer depuis l'explorateur** : déposer des **dossiers** les
  ajoute aux racines de scan ; déposer des **fichiers** ouvre le choix d'un
  dossier de destination puis les importe (copie datée AAAA-MM, doublons
  ignorés par hash). Grand voile « 📥 Dépose ici » pendant le survol.
- **Barre de critères d'affichage** au-dessus de la grille, mémorisée :
  - tri : plus récentes / plus anciennes / nom / note ;
  - filtre par **note minimale** (★ cliquables) et par **type** (photos/vidéos) ;
  - **vignettes carrées ou ratio préservé** (bouton ▣/⬒) ;
  - compteur « affichés / total » quand un filtre est actif.
- Le groupement par mois s'applique aux tris par date ; les autres tris
  affichent une grille continue. Sélection (plages, Ctrl+A), lightbox et
  diaporama suivent exactement ce qui est affiché.

## [1.6.0] — 2026-07-12

### Ajouté
- **Groupement par date** : la grille est organisée par mois avec en-têtes
  (« juillet 2026 — 2 élément(s) ») dans toutes les vues, et une pastille
  « 📅 mois courant » reste épinglée en haut pendant le défilement. Les photos
  sans date EXIF sont regroupées en fin de liste.
- **Vue Chronologie** 🕒 : toutes les photos de la bibliothèque, tous dossiers
  confondus, de la plus récente à la plus ancienne.
- **Curseur de taille des vignettes** (signature Picasa) en bas à droite de la
  grille : 100 → 320 px en continu, mémorisé entre les sessions.
- **Panneau d'informations** à droite quand une seule photo est sélectionnée :
  date lisible, dimensions, poids, appareil/objectif, réglages de prise de vue
  (f/, vitesse, ISO, focale), GPS avec bouton « Voir sur la carte », tags en
  chips, albums, visages détectés. Fermable, réapparaît à la prochaine
  sélection (préférence mémorisée).

### Corrigé
- Le mode capture d'écran (CI) écrivait son PNG dans le dossier scanné, qui se
  faisait indexer comme une photo → capture écrite dans le dossier temporaire.

## [1.5.0] — 2026-07-12

### Ajouté
- **Visionneuse plein écran (lightbox)** : double-clic sur une vignette →
  grande image, flèches ←/→ (boutons + clavier), **zoom molette jusqu'à 5×**,
  **double-clic = 100 % pixels réels** (chargement de l'original à la volée via
  `thumb://library/orig`), glisser pour naviguer dans l'image, notation ★,
  bouton Éditer (raccourci E), Échap pour fermer — la « loupe » Picasa du
  cahier des charges initial.
- **Menu contextuel clic droit** sur les vignettes : Ouvrir, Éditer, Noter
  (sous-menu ★), Taguer, Masquer (sélection multiple gérée), **Afficher dans le
  dossier** (explorateur système).

### Modifié
- **Sélection façon explorateur de fichiers** : clic = sélectionner, Ctrl+clic
  = ajouter/retirer, Shift+clic = plage, **Ctrl+A** = tout, Échap = désélection.
  La sélection alimente directement le bac d'actions. L'éditeur s'ouvre
  désormais depuis la visionneuse ou le clic droit (le double-clic affiche).

## [1.4.3] — 2026-07-12

### Modifié
- **Barre d'actions du bac entièrement repensée** (elle était illisible :
  icônes seules minuscules, gris sur gris, sans hiérarchie) :
  - boutons avec icône **et** libellé, survol net, état désactivé évident ;
  - actions regroupées sous étiquettes : bac (compteur orange + vignettes +
    vider), **Organiser** (album/tag), **Créer** (diaporama, collage, film),
    **Partager** (export, impression, email, CSV, masquage) ;
  - actions principales en orange (palette navy/orange) ;
  - bac vide → invitation claire « Clique sur des photos… » au lieu d'une
    rangée de boutons grisés ;
  - retour à la ligne automatique : plus rien de coupé en fenêtre étroite.
- Feuille de style globale : tous les boutons, champs et listes de
  l'application héritent du nouveau style (survol, focus orange, arrondis).

## [1.4.2] — 2026-07-12

### Corrigé
- **Menu « Aide » vide** : l'application n'avait aucun menu défini, Electron
  affichait le sien par défaut. Menu applicatif complet en français :
  - Fichier : « Ajouter un dossier » (Ctrl+O) et « Importer SD/appareil »
    (Ctrl+I) reliés aux actions de l'interface ;
  - Édition / Affichage / Fenêtre : rôles natifs traduits ;
  - Aide : Documentation, Journal des modifications, Signaler un problème,
    **Rechercher les mises à jour** (avec retour visuel : à jour / mode dev /
    cas .deb), À propos (version + versions Electron/Chromium/Node).

## [1.4.1] — 2026-07-12

### Corrigé
- **Images des dossiers importés qui ne s'affichaient pas** (PR #3 finalisée) :
  - Chromium mettait en cache les 404 du protocole `thumb://` pendant le scan et
    ne redemandait jamais l'image une fois la miniature prête → `Cache-Control:
    no-store` sur les 404 ;
  - génération **à la volée** d'une miniature manquante au moment de l'affichage
    (le pipeline de fond ne sert plus qu'à pré-générer en masse) ;
  - deux dossiers ajoutés rapidement : le 2ᵉ pipeline était silencieusement
    ignoré (`running` déjà vrai) → file d'attente avec relance ;
  - composant `ThumbImg` avec retry à backoff (500 ms → 8 s) côté interface ;
  - régénération automatique si le fichier de cache a disparu du disque.
- Erreur TypeScript de la PR #3 qui bloquait la CI (null vs undefined).

### Ajouté
- Mode `PICALIBRE_TEST_SCREENSHOT` : scan + sélection du 1er dossier + capture
  PNG de la fenêtre — validation visuelle de la grille en CI/headless.

## [1.4.0] — 2026-07-12

### Ajouté
- **Mises à jour automatiques** (electron-updater + releases GitHub) : vérification
  au lancement puis toutes les 4 h, téléchargement en arrière-plan, bandeau dans
  l'app avec « Redémarrer et installer » ou installation au prochain arrêt.
  Actif sur Windows (NSIS), macOS et Linux AppImage ; le .deb reste géré par le
  gestionnaire de paquets. Jamais actif en développement.
- Les métadonnées de mise à jour (`latest*.yml`, blockmaps) sont publiées avec
  chaque release par la CI.

## [1.3.1] — 2026-07-12

### Ajouté
- **CI GitHub Actions Linux + Windows** : typecheck, 4 suites unitaires, build,
  E2E pipeline complet + parité WebGL exécutés dans Electron sur runners réels
  (Xvfb sur Linux, session native sur Windows), installeurs en artefacts
  (AppImage/.deb et NSIS .exe). Logs E2E publiés en commentaire de commit.

### Corrigé (révélé par la CI Windows)
- Chemins `/tmp` en dur dans les suites de test → `os.tmpdir()`.
- Les modes test ne quittaient jamais : le process exiftool persistant bloquait
  `app.quit()` → arrêt exiftool + `app.exit` forcé.
- `package-lock.json` désynchronisé (échec `npm ci`) ; rebuild ABI Electron
  forcé en CI ; email d'auteur requis par la cible .deb.

## [1.3.0] — 2026-07-12

### Ajouté
- **Preview WebGL** pour les opérations couleur de l'éditeur : fragment shader
  généré depuis le stack (un extrait GLSL par op, dans l'ordre), uniforms pour
  les valeurs, cache de programmes par signature de séquence. Chemin rapide sans
  op spatiale : texture directe depuis le canvas, aucun `getImageData`.
- Fallback CPU automatique (WebGL absent, contexte perdu ou erreur shader) —
  `applyColorOps` reste la vérité commune avec l'export sharp.
- Mode test `PICALIBRE_TEST_WEBGL=1` : suite de parité GPU↔CPU exécutée dans le
  renderer Electron réel (13 cas : chaque op isolée, 5 filtres, chaîne complète).

### Corrigé
- Double inversion verticale du rendu GPU (flip à l'upload **et** au recopiage),
  détectée immédiatement par la suite de parité : écart max ramené de 255/255 à
  1/255 (≤ 0,4 % des pixels).

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

[1.9.1]: https://github.com/Laurent-67370/picalibre/releases/tag/v1.9.1
[1.9.0]: https://github.com/Laurent-67370/picalibre/releases/tag/v1.9.0
[1.8.2]: https://github.com/Laurent-67370/picalibre/releases/tag/v1.8.2
[1.8.1]: https://github.com/Laurent-67370/picalibre/releases/tag/v1.8.1
[1.8.0]: https://github.com/Laurent-67370/picalibre/releases/tag/v1.8.0
[1.7.0]: https://github.com/Laurent-67370/picalibre/releases/tag/v1.7.0
[1.6.0]: https://github.com/Laurent-67370/picalibre/releases/tag/v1.6.0
[1.5.0]: https://github.com/Laurent-67370/picalibre/releases/tag/v1.5.0
[1.4.3]: https://github.com/Laurent-67370/picalibre/releases/tag/v1.4.3
[1.4.2]: https://github.com/Laurent-67370/picalibre/releases/tag/v1.4.2
[1.4.1]: https://github.com/Laurent-67370/picalibre/releases/tag/v1.4.1
[1.4.0]: https://github.com/Laurent-67370/picalibre/releases/tag/v1.4.0
[1.3.1]: https://github.com/Laurent-67370/picalibre/releases/tag/v1.3.1
[1.3.0]: https://github.com/Laurent-67370/picalibre/releases/tag/v1.3.0
[1.2.0]: https://github.com/Laurent-67370/picalibre/releases/tag/v1.2.0
[1.1.0]: https://github.com/Laurent-67370/picalibre/releases/tag/v1.1
[1.0.0]: https://github.com/Laurent-67370/picalibre/releases/tag/v1.0.0
