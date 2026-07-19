# Changelog

Toutes les évolutions notables de PicaLibre sont documentées ici.
Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/) — versionnage sémantique.

## [2.23.3] — 2026-07-19

Durcissements issus de l'audit de suivi.

### Sécurité
- **Blocage de la navigation** : l'app étant une interface 100 % locale,
  aucune navigation du contenu n'est légitime après le chargement.
  `will-navigate` neutralise désormais toute navigation hors de la page
  de l'app elle-même (y compris le glisser-déposer d'un fichier .html sur
  la fenêtre, vecteur classique), et `setWindowOpenHandler` refuse toute
  nouvelle fenêtre — les liens https sont délégués au navigateur système.
- **Verrou de confidentialité étendu au protocole `thumb://`** : tant que
  les photos masquées sont verrouillées, ni les vignettes ni l'original
  d'une photo masquée ne sont servis (403), en défense en profondeur —
  même un renderer compromis ou une régression d'interface ne peut plus
  afficher le contenu protégé sans mot de passe. Coût mesurable nul
  quand déverrouillé.

### Vérifié (Xvfb + Electron réel)
- Photo masquée + verrou actif : vignette ET original → 403 ; après
  déverrouillage → 200 tous les deux.
- Tentative de navigation du renderer vers un site externe : URL de la
  fenêtre inchangée (navigation neutralisée).
- Toute la batterie Corbeille/confidentialité de la 2.23.1 repasse à
  l'identique (aucune régression).

## [2.23.2] — 2026-07-19

### Sécurité
- **Mise à niveau `exiftool-vendored` 28.8.0 → 35.21.0** pour corriger la
  vulnérabilité haute sévérité GHSA-cw26-7653-2rp5 (injection d'arguments
  via retours à la ligne dans les noms de tags — versions ≤ 35.18.0
  vulnérables). `npm audit` : 0 vulnérabilité après la montée.
- La v37 (dernière) a été volontairement écartée : elle exige Node ≥ 22
  alors qu'Electron 33 embarque Node 20.18 — la série 35.19+ corrige la
  même CVE en restant compatible Node ≥ 20. La v37 redeviendra pertinente
  lors de la future montée d'Electron.

### Vérifié (Xvfb + Electron réel, Node 20 embarqué)
- Pipeline complet scan → extraction EXIF → détection voyages sur les 20
  photos de test : les 13 coordonnées GPS lues à l'identique (Strasbourg,
  Paris, Marseille), les 20 dates de prise de vue extraites, la photo au
  GPS corrompu (0,0) toujours correctement normalisée — aucun changement
  de comportement, même résultat de détection qu'avant la montée.

## [2.23.1] — 2026-07-19

Correctifs issus d'un audit sécurité/performance/robustesse du code.

### Sécurité
- **La Corbeille respecte désormais le verrou de confidentialité** : une
  photo masquée protégée par mot de passe, mise à la corbeille depuis la
  vue Masquées, apparaissait dans la vue Corbeille sans mot de passe
  (introduit en 2.21.0). `photos:trashed` exclut maintenant les photos
  masquées tant que le verrou est actif ; en défense en profondeur,
  `photos:deleteForever` refuse aussi de supprimer une photo masquée
  verrouillée, même par appel IPC direct.

### Corrigé
- **Fuite de listeners IPC** côté interface : les abonnements
  `import:progress` et `export:progress` n'étaient jamais désinscrits au
  démontage (handlers dupliqués en développement/HMR).
- **Orphelins disque à la suppression définitive** : les miniatures webp
  du cache et l'éventuel proxy vidéo H.264 restaient sur le disque pour
  toujours (seules les lignes en base cascadaient). Ils sont maintenant
  supprimés, et le cache mémoire de résolution des miniatures est purgé.
- **GPS corrompu (0,0) dans la détection voyages** : la valeur EXIF
  classique « 0,0 » (appareil écrivant des zéros) était traitée comme une
  vraie position dans le golfe de Guinée et déclenchait de fausses
  ruptures géographiques. Coordonnées hors bornes ou (0,0) exact sont
  désormais traitées comme absentes.

### Performance
- La détection voyages n'attend plus 1,1 s après le **dernier** groupe
  géocodé (le délai de politesse Nominatim ne s'applique qu'entre deux
  appels réseau réels).

### Vérifié (Xvfb + Electron réel)
- Verrou : corbeille verrouillée → photo masquée invisible ; déverrouillée
  → visible ; `deleteForever` verrouillé → 0 suppression, la photo existe
  toujours en base.
- Cache : 4 miniatures webp présentes avant suppression définitive, 0
  restante sur disque après.
- GPS : une photo (0,0) insérée au milieu d'un groupe sans GPS rejoint
  son groupe temporel normalement au lieu de le scinder — détection
  globale inchangée par ailleurs (mêmes 4 groupes).

## [2.23.0] — 2026-07-19

### Remplacé — Regroupement voyages / événements (version complète)
Remplace l'implémentation simplifiée de la 2.22.0 (écart horaire sur la
sélection courante) par le moteur initialement prévu :
- **Détection sur toute la bibliothèque active**, pas seulement une
  sélection — plus besoin de choisir des photos au préalable.
- **Rupture temporelle OU géographique** : nouveau groupe dès que deux
  photos consécutives (triées par date de prise de vue) sont séparées de
  plus de 2 jours, OU de plus de 60 km (distance haversine) quand les
  deux ont des coordonnées GPS. Une rupture géographique peut se
  déclencher seule, même le même jour (vérifié : Paris → Marseille en
  quelques heures scindé correctement en 2 groupes).
- **Groupes de moins de 4 photos ignorés** — pas proposés, aucune photo
  concernée n'est jamais modifiée par la détection elle-même (lecture
  seule tant que « Créer » n'est pas cliqué).
- **Nommage automatique par géocodage inversé** (réutilise l'appel
  Nominatim déjà en place pour la vue Carte) : « Strasbourg — 15–18 mars
  2026 ». Sans GPS dans le groupe, repli sur la plage de dates seule.
- **Écran de review** : cases à cocher par groupe, nom modifiable,
  aperçu (dates, nombre de photos, ville), création réelle des albums
  réutilisant l'outillage albums existant (`albums:create` +
  `albums:addPhotos` — renommables/modifiables ensuite comme n'importe
  quel autre album).
- Point d'entrée déplacé dans la barre latérale (« 🧳 Voyages /
  événements ») puisque l'action porte sur toute la bibliothèque, plus
  dans la barre du bac. Toujours disponible aussi via Outils → menu natif.
- Nouveau service backend dédié `src/main/services/trips.ts` et type IPC
  `TripGroup` (`trips:detect`).

### Vérifié (Xvfb + Electron réel, roundtrip IPC complet)
19 photos EXIF avec dates/GPS variés (Strasbourg, Paris, Marseille, un
lot sans GPS, un lot volontairement trop petit) :
- 4 groupes détectés avec les tailles exactes attendues (5, 4, 4, 4)
- Rupture géographique seule confirmée (Paris → Marseille, même jour)
- Groupe de 2 photos bien exclu des propositions
- Aucune photo modifiée par la détection seule (19 toujours actives)
- Création réelle des 4 albums confirmée en base avec le bon effectif
  de photos par album
- Le géocodage (nom de ville) n'a pas pu être vérifié bout en bout en
  environnement de build (Nominatim inaccessible depuis ce réseau) —
  réutilise cependant l'appel déjà en production sur la vue Carte ; le
  repli sur date seule en cas d'échec réseau, lui, est vérifié.

## [2.22.0] — 2026-07-19

### Ajouté — Regroupement voyages / événements
- **Détection temporelle** : les photos sélectionnées sont triées par date
  de prise de vue (`taken_at`) et regroupées selon un écart maximum
  configurable (1-72h, défaut 12h). Les photos séparées de moins de cet écart
  font partie du même voyage/événement.
- **Aperçu** : avant de créer les albums, l'utilisateur voit la liste des
  voyages détectés (nom auto + nombre de photos + plage de dates).
- **Création d'albums** : un album est créé pour chaque groupe via IPC
  `albums:create` + `albums:addPhotos`. Nom auto : « Voyage — {date début}
  → {date fin} » (ou date unique si même jour).
- **UI** : bouton 🧳 Voyages dans la barre du tray (à côté de ✏️ Renommer),
  dialogue modal avec slider d'écart, bouton de détection, aperçu des
  groupes, et bouton de création.
- **États** : `tripOpen`, `tripBusy`, `tripGapHours`, `tripPreview`.

## [2.21.0] — 2026-07-19

### Ajouté — Corbeille
- **🗑 Mettre à la corbeille** (clic droit sur une photo, bouton du bac,
  ou Édition → menu, sélection multiple) : retire la sélection de toutes
  les vues normales sans toucher au fichier sur le disque. Réversible
  comme les autres actions de l'app (bandeau ↩ Annuler, 8s).
- **Vue « 🗑 Corbeille »** dans la barre latérale et le menu Bibliothèque :
  liste tout ce qui a été mis à la corbeille.
- **♻ Restaurer** depuis la vue Corbeille — repasse en actif, réversible
  aussi (repasse en corbeille via ↩ Annuler si besoin).
- **⛔ Supprimer définitivement** depuis la vue Corbeille — confirmation
  requise, seule action de la Corbeille qui touche réellement au disque :
  le fichier est effacé et la ligne base supprimée (albums/tags/visages
  associés nettoyés automatiquement). Irréversible.
- S'appuie sur le statut `status='trashed'` déjà présent dans le schéma
  depuis la toute première version (déjà utilisé en interne pour la
  fusion de doublons et le retrait de dossier) — cohérent avec le reste
  du système d'annulation, aucune migration de base nécessaire.

### Vérifié (Xvfb + Electron réel, roundtrip IPC complet)
- Mise à la corbeille de 3 photos : statut `trashed` confirmé en base,
  disparition de la vue dossier (0 encore actives), apparition dans la
  vue Corbeille.
- Restauration d'une photo : retour à `status='active'` confirmé.
- Suppression définitive des 2 restantes : fichiers présents avant
  (vérifié sur disque), absents après (vérifié sur disque) ; lignes
  base entièrement supprimées après (vérifié par requête directe).

## [2.20.3] — 2026-07-18

### Amélioré — transition du diaporama plus fluide
- Laurent, après le correctif du saut (2.20.2) : « ça pourrait être plus
  fluide ». En creusant plus loin, un second problème (plus discret) :
  seul le calque « actif » recevait l'animation Ken Burns — le calque
  qui devenait inactif retombait instantanément à l'échelle 1 (figée)
  exactement au moment où le fondu démarrait, et le calque entrant
  attendait la fin du fondu avant de commencer son propre mouvement.
- **Refonte** : chaque calque porte désormais sa propre animation
  (paramètres + horodatage de départ), totalement indépendante de
  l'autre. Le fondu redevient un pur changement d'opacité par-dessus
  deux animations qui continuent chacune leur mouvement sans
  interruption — le calque sortant garde son zoom/panoramique jusqu'au
  bout, le calque entrant démarre le sien dès qu'il devient actif,
  exactement comme un diaporama Ken Burns à deux calques classique
  (Picasa, iPhoto…).

### Vérifié (Xvfb + Electron réel, mesures à 2 instants pendant le fondu)
- Calque sortant : `scale(1.1009)` à 100 ms puis `scale(1.0921)` à
  400 ms — évolution continue et douce, confirmée (ni gel, ni saut).
- Calque entrant : `scale(1.1468)` à 100 ms puis `scale(1.138)` à
  400 ms — anime déjà sa propre trajectoire dès son apparition, pas
  figé à l'échelle 1. Pipeline de scan et parité WebGL : aucune
  régression.

## [2.20.2] — 2026-07-18

### Corrigé — le diaporama sautait en arrière juste avant chaque transition
- Signalé par Laurent : « une sorte de fondu... revient systématiquement
  sur la photo d'origine avant de passer à la photo suivante ».
- **Cause** : les paramètres d'animation Ken Burns (zoom/panoramique) de
  la PROCHAINE photo étaient appliqués dès le DÉBUT du fondu — alors que
  la photo ACTUELLE, encore visible à l'écran en train de s'estomper,
  utilise cette même variable pour son propre transform. Elle sautait
  donc instantanément vers les paramètres de départ d'une animation qui
  n'était pas la sienne, juste avant de disparaître dans le fondu — un
  bug présent depuis l'introduction du diaporama, jamais remarqué faute
  d'avoir vérifié le transform exact pendant la transition plutôt
  qu'avant/après.
- **Correctif** : les nouveaux paramètres Ken Burns ne sont désormais
  appliqués qu'à la toute fin du fondu, au moment où le calque bascule
  réellement — la photo qui s'estompe garde son animation intacte
  jusqu'au bout.

### Vérifié (Xvfb + Electron réel, transform exact mesuré pendant le fondu)
- Transform du calque actif juste avant la transition :
  `scale(1.1052) translate(-0.43%, -1.3%)`. À 100 ms dans le fondu
  (sur 600 ms, donc bien avant la fin) : **valeur strictement
  identique** — confirmé qu'il n'y a plus aucun saut. Le calque entrant
  reste à `scale(1)` tant qu'il n'est pas encore actif, comme prévu.

## [2.20.1] — 2026-07-18

### Ajouté — script d'auto-correction macOS (Gatekeeper)
- Signalé par Laurent : PicaLibre n'étant pas signé par un certificat
  Apple Developer payant (voir CODE_SIGNING.md), macOS bloque parfois
  son lancement après téléchargement (« l'app est endommagée »),
  nécessitant de taper `xattr -cr /Applications/PicaLibre.app` dans le
  Terminal après chaque mise à jour.
- **Ajouté** : `Corriger PicaLibre si besoin.command`, présent dans
  chaque release à côté des installeurs. Se télécharge une fois,
  se garde où on veut, se double-clique après chaque future mise à
  jour si besoin — plus besoin d'ouvrir le Terminal ni de retaper la
  commande à chaque fois.
- **Solution définitive documentée** (CODE_SIGNING.md) : rejoindre
  l'Apple Developer Program (99 $/an) pour une notarisation Apple —
  élimine complètement le problème, mais nécessite une démarche
  personnelle du propriétaire du compte Apple Developer (identité
  vérifiée par Apple), non automatisable par ce dépôt seul.

## [2.20.0] — 2026-07-18

### Ajouté — retirer un sous-dossier précis de la bibliothèque
- Jusqu'ici, seul un dossier racine complet (« Dossiers surveillés » dans
  Réglages) pouvait être retiré — et cela n'arrêtait que la surveillance,
  sans retirer les photos déjà indexées. Impossible de cibler un seul
  sous-dossier.
- Chaque sous-dossier a en réalité toujours sa propre entrée en base
  (les photos y sont déjà rattachées individuellement) — la fonctionnalité
  manquait simplement côté interface.
- **Ajouté** : bouton 🗑 à côté de chaque sous-dossier dans la barre
  latérale. Retire ses photos de la bibliothèque (fichiers intacts sur
  le disque), avec confirmation et annulation juste après (Ctrl/⌘+Z,
  même mécanisme que les autres actions destructives de l'app). Le
  sous-dossier ne revient plus lors des scans suivants, même si les
  fichiers restent physiquement présents.
- Sujet d'aide mis à jour en conséquence.

### Vérifié (Xvfb + Electron réel, scénario complet)
- Avant retrait : photo active confirmée en base. Après retrait : 0
  photo active, dossier marqué exclu. **Après un scan complet
  relancé : toujours 0** — confirme que l'exclusion persiste réellement
  et n'est pas juste un état temporaire en mémoire. Après annulation :
  photo restaurée, dossier réactivé. Pipeline de scan et parité CPU/GPU
  revérifiés : aucune régression.

## [2.19.6] — 2026-07-18

### Corrigé — vignettes qui se chevauchaient après un aller-retour par Réglages
- Signalé par Laurent avec capture d'écran : dans un dossier, les
  vignettes s'affichaient correctement ; après être allé dans Réglages
  puis revenu dans le dossier, les vignettes se chevauchaient à des
  positions incohérentes, nécessitant un rechargement manuel.
- **Cause** : la grille (virtualisée avec `@tanstack/react-virtual`, pour
  n'afficher que les lignes visibles même avec des milliers de photos)
  est complètement démontée en allant dans Réglages ou en gestion des
  visages, puis remontée — un tout nouvel élément DOM à chaque fois. Le
  `ResizeObserver` qui mesure la largeur du conteneur (`gridWidth`, d'où
  dépend le nombre de colonnes) n'avait des dépendances vides : il ne
  s'exécutait qu'au tout premier montage de l'app, restant attaché pour
  toujours à l'ANCIEN élément démonté. Le nombre de colonnes ne se
  remettait plus jamais à jour pour le nouveau conteneur, désynchronisant
  le regroupement des lignes et les positions calculées par le
  virtualiseur.
- **Correctif** : le `ResizeObserver` se réattache maintenant proprement
  à chaque remontage de la grille (avec une lecture immédiate de la
  largeur, pas seulement à la prochaine notification), et le virtualiseur
  est explicitement re-mesuré au même moment.

### Vérifié (Xvfb + Electron réel, scénario exact signalé, 60 photos)
- Dossier → Réglages → retour au dossier : nombre de vignettes affichées
  et chevauchements réels mesurés (bounding rects qui se recouvrent) via
  `getBoundingClientRect()` sur chaque vignette, avant et après le
  changement de vue. Avant correctif : 35→7 vignettes, 18 chevauchements
  détectés. Après correctif : 35→35 vignettes, 0 chevauchement — répété
  3 fois pour écarter tout hasard. Pipeline de scan et parité CPU/GPU
  revérifiés : aucune régression.

## [2.19.5] — 2026-07-18

### Corrigé — l'éditeur (et d'autres vues) repassait derrière la Carte
- Signalé par Laurent : depuis la Carte, sélectionner une photo puis
  cliquer « Éditer » faisait revenir la carte au premier plan,
  recouvrant l'éditeur — impossible d'éditer quoi que ce soit.
- **Même cause que le bug de la Lightbox (2.19.2), mais plus large** :
  en vérifiant tous les composants plein écran de l'app, la quasi
  totalité avait un z-index inférieur aux overlays internes de MapView
  (jusqu'à 1000) — l'Éditeur (100), le Diaporama (200), le Créateur de
  film (200), le Collage (150), l'Impression (250), le Centre d'aide
  (300), la Visite guidée (400), et plusieurs dialogues d'App.tsx
  (renommage/export en lot, écran de veille, glisser-déposer, toast
  d'annulation — 200 à 260). Un oubli systémique plutôt qu'un cas
  isolé : les overlays de MapView avaient reçu des valeurs élevées sans
  jamais être comparées au reste de l'app.
- **Correctif** : tous ces composants passent à une échelle cohérente
  au-dessus de 1000 (1005 à 1090 selon le composant), garantissant
  qu'aucun ne puisse plus se retrouver caché derrière la Carte — ni les
  uns derrière les autres dans un ordre imprévisible.

### Vérifié (Xvfb + Electron réel, scénario exact signalé)
- Carte → sélection d'une photo → Éditer : l'élément réellement au
  premier plan à l'endroit du panneau de l'éditeur (vérifié par un vrai
  test de positionnement du navigateur, `elementFromPoint`) est bien le
  panneau de l'éditeur, pas la carte.

## [2.19.4] — 2026-07-18

### Amélioré — contraste complémentaire dans la Lightbox
- En complément du correctif 2.19.3 (variables de thème sur fond
  toujours sombre) : le gris `#94a3b8` restant (compteur de position,
  indication de zoom, barre d'aide du bas, barre de découpe vidéo)
  éclairci en `#cbd5e1`, plus nettement lisible. Couleur de texte par
  défaut également forcée sur le conteneur racine de la Lightbox (même
  logique défensive que la cause racine du bug de l'éditeur).

### Vérifié sur un vrai rendu capturé (pas un calcul théorique)
- Xvfb + Electron réel, Lightbox ouverte, capture de la barre d'aide du
  bas analysée pixel par pixel : couleur de texte confirmée
  `rgb(203,213,225)` (= `#cbd5e1`) sur fond `rgb(15,23,42)` (= `#0f172a`)
  — ratio de contraste mesuré **12,02:1**, largement au-dessus du seuil
  WCAG AAA (7:1).

## [2.19.3] — 2026-07-18

### Corrigé — texte illisible dans la Lightbox (et Slideshow/Face Movie) en thème clair
- Signalé par Laurent avec capture d'écran : les indications de la
  Lightbox (nom de fichier, position, zoom) en gris peu contrasté sur
  fond sombre.
- **Cause, plus large qu'il n'y paraissait** : Lightbox, Slideshow et
  Face Movie ont un fond **toujours sombre**, volontairement, quel que
  soit le thème de l'app (clair ou sombre) — mais leur texte utilisait
  des variables CSS de thème (`var(--muted)`, `var(--border)`) au lieu
  de couleurs fixes. En thème clair, ces variables valent des couleurs
  pensées pour un fond blanc — beaucoup moins lisibles sur le fond
  toujours sombre de ces vues immersives. Plus grave : le **nom de
  fichier** de la Lightbox n'avait carrément aucune couleur définie et
  héritait de `var(--text)`, qui vaut un bleu marine très foncé en
  thème clair — quasiment invisible sur fond sombre.
- Même défaut retrouvé et corrigé dans Slideshow et Face Movie (barre
  de progression, libellé « Durée »). InfoPanel vérifié à part : lui
  suit correctement le thème (n'est jamais affiché en même temps que la
  Lightbox), pas un bug.

### Vérifié (Xvfb + Electron réel, thème clair — le scénario exact du bug)
- Couleurs réellement calculées par le navigateur (pas une lecture de
  code) : nom de fichier `rgb(226,232,240)` sur fond `rgb(15,23,42)`
  (contraste très largement au-dessus des standards d'accessibilité),
  compteur de position `rgb(148,163,184)`, tous deux confirmés lisibles.

## [2.19.2] — 2026-07-18

### Corrigé — la photo ouverte depuis la Carte restait cachée derrière elle
- Signalé par Laurent avec capture d'écran : cliquer un marqueur sur la
  Carte ouvrait bien la Lightbox, mais celle-ci restait visuellement
  **derrière** la carte.
- **Cause** : la Lightbox utilisait `z-index: 90` — plus bas que les
  propres overlays de la vue Carte (jusqu'à `z-index: 1000` pour la
  bannière « pas de connexion »), et même plus bas que l'éditeur photo
  (100). Un simple oubli lors de l'ajout de ces overlays, jamais
  remarqué avant faute d'avoir testé l'ouverture d'une photo précisément
  depuis la Carte.
- **Correctif** : `z-index: 1050`, confortablement au-dessus de tous les
  éléments actuels de l'app (le plus haut jusqu'ici : 1000).

### Vérifié (Xvfb + Electron réel)
- Photo géolocalisée, Carte ouverte, marqueur cliqué : l'élément
  réellement au premier plan à cet endroit (vérifié par un vrai test de
  positionnement du navigateur — `elementFromPoint`, pas juste une
  lecture de la propriété CSS) est bien l'image de la Lightbox, pas la
  carte. Non-régression confirmée sur l'ouverture normale depuis la
  grille.

## [2.19.1] — 2026-07-18

### Ajouté — sujet d'aide manquant
- « Retirer ou modifier un dossier surveillé » (Réglages → mode
  Surveillé/Une fois/Exclu + suppression) — la fonctionnalité existait
  déjà, seul le sujet d'aide manquait. Cherchable via « retirer »,
  « supprimer » ou « dossier » dans le centre d'aide (❓ / F1).

## [2.19.0] — 2026-07-18

### Refait — panneau de l'éditeur, trop long à faire défiler
- Signalé par Laurent avec capture d'écran : les boutons Réglages/
  Filtres/Effets/Texte/Cadre en haut du panneau **n'étaient pas de vrais
  onglets** — juste des liens de défilement vers des ancres, tout le
  contenu (curseurs de réglages, filtres, 8 effets avancés, texte,
  cadre) s'affichait toujours en même temps, dans un ordre qui plus est
  incohérent dans le code (les curseurs de Réglages se trouvaient après
  Texte et Cadre).
- **Vrais onglets** maintenant : un seul groupe de contrôles visible à
  la fois.
- **Section Effets avancés repensée** : les 8 effets (Flou, Netteté,
  Vignette, Doucette, Glow, Orton, Tilt-shift, Pseudo-HDR, Définition)
  étaient auparavant 8 curseurs pleine largeur toujours affichés — ils
  sont désormais une grille compacte de boutons à bascule ; le curseur
  d'un effet n'apparaît qu'une fois cliqué/activé, avec une valeur de
  départ raisonnable. Plusieurs effets restent combinables.

### Vérifié (Xvfb + Electron réel)
- Onglet Réglages actif : « EFFETS AVANCÉS » absent de l'écran.
- Onglet Effets actif : grille affichée, **0 curseur d'effet visible**
  tant qu'aucun n'est activé, contenu des Filtres (bouton « Sépia »)
  absent.
- Clic sur « 🌫 Flou » : son curseur apparaît, lui seul.
- Retour sur l'onglet Filtres : « EFFETS AVANCÉS » disparaît, « Sépia »
  réapparaît — exclusion mutuelle confirmée dans les deux sens.

## [2.18.2] — 2026-07-18

### Corrigé — piste supplémentaire pour « spawn ENOTDIR » (macOS)
- Laurent a renvoyé une seconde capture après mise à jour : le message
  d'erreur est resté **strictement identique** au ENOTDIR brut de la
  2.18.0, sans le contexte ajouté en 2.18.1 (chemin ffmpeg, sortie
  ffmpeg) — signe probable que la mise à jour ne s'est pas encore
  totalement appliquée (l'app doit être quittée complètement, pas juste
  la fenêtre fermée, pour qu'electron-updater termine l'installation).
- **En parallèle**, un vrai piège Electron identifié et corrigé par
  précaution : `fs.access()`/`fs.stat()` sont redirigés automatiquement
  par Electron vers `.asar.unpacked` quand un fichier a été extrait de
  l'archive, mais **`child_process.spawn()`/`execFile()` n'en bénéficient
  pas** — le chemin littéral peut alors pointer à l'intérieur de
  l'archive `.asar` (un simple fichier pour l'OS, pas un vrai dossier),
  provoquant exactement ENOTDIR au moment du spawn, après que toutes les
  vérifications `access()` en amont aient réussi. Nouvelle fonction
  `spawnSafe()` dans le résolveur ffmpeg : substitue `app.asar` par
  `app.asar.unpacked` dans tout chemin destiné à `spawn()`.

### Si le problème persiste après cette mise à jour
Vérifier dans Aide → À propos que la version affichée est bien 2.18.2
(sur macOS, **quitter complètement l'app — ⌘Q — avant de relancer**,
sinon la mise à jour reste téléchargée sans être appliquée). Si l'erreur
revient malgré une version confirmée à jour, le message affichera
désormais le chemin ffmpeg exact utilisé — une capture de ce message
détaillé permettra un diagnostic définitif.

## [2.18.1] — 2026-07-18

### Corrigé — « spawn ENOTDIR » lors de l'extraction d'image fixe
- Signalé par Laurent avec une capture d'écran réelle : échec de
  l'extraction d'image sur un appareil en conditions réelles, hors de
  l'environnement de développement où toute la vérification de cette
  session a eu lieu — un angle mort assumé (voir note ci-dessous).
- **Cause probable identifiée** : `getFfmpegPath()` mémorise le chemin
  résolu pour toute la durée du process, sans jamais revérifier qu'il
  reste valide. Si le binaire résolu devient inaccessible entre-temps
  (profil nettoyé, cache vidé, disque externe débranché…), tout appel
  ffmpeg suivant échoue avec une erreur système cryptique au lieu de
  retenter une résolution propre.
- **Correctif** : le chemin mémorisé est revérifié (`access()`) avant
  chaque utilisation ; s'il n'existe plus, une nouvelle résolution
  complète est relancée automatiquement (système → embarqué → cache →
  téléchargement), au lieu d'échouer silencieusement sur un chemin mort.
- En complément : messages d'erreur nettement plus clairs dans
  l'extraction d'image (vidéo source manquante, ffmpeg introuvable,
  sortie ffmpeg incluse) plutôt qu'un ENOTDIR brut sans contexte.

### Limite honnête de cette correction
Je n'ai pas pu reproduire l'environnement exact où l'erreur est survenue
(l'intégralité des tests de cette session tourne en environnement de
développement Linux/Xvfb, jamais sur un build empaqueté réel). Ce
correctif répare la cause la plus probable identifiée à la lecture du
code, mais sans confirmation sur l'appareil concerné. À revérifier après
mise à jour — et si le problème persiste, le nouveau message d'erreur
détaillé (au lieu du ENOTDIR brut) donnera de quoi diagnostiquer plus loin.

## [2.18.0] — 2026-07-18

### Ajouté — les 3 derniers écarts vs Picasa 3.9, fermés
- **Définition/Clarté** : nouveau curseur dans l'éditeur (section Effets
  avancés) — contraste local sur une zone large (rayon 30px), accentue
  la texture/structure générale sans les halos fins de la Netteté. Même
  technique que le Pseudo-HDR mais sans compression de dynamique
  (Reinhard), plus proche du curseur « Clarté » de Lightroom.
- **📷 Extraire une image fixe d'une vidéo** : bouton dans la visionneuse
  vidéo, capture l'instant de lecture actuel via ffmpeg et l'ajoute
  comme nouvelle photo dans la bibliothèque (même dossier que la vidéo
  source, déjà surveillé — pas de duplication de la logique d'insertion,
  le pipeline habituel prend le relais).
- **✂ Découpe vidéo non destructive** : boutons « Marquer début » /
  « Marquer fin » dans la visionueuse, capturent l'instant de lecture
  actuel. Le fichier original n'est jamais modifié — seuls deux points
  de repère sont stockés (migration 009, `trim_start_ms`/`trim_end_ms`).
  La lecture dans l'app boucle sur la zone découpée ; l'inclusion dans
  un film (créateur de film) n'utilise que l'extrait découpé.
- Les 3 nouveaux sujets intégrés au centre d'aide interactif (Définition/
  Clarté, Découper une vidéo, Extraire une image fixe).

### Vérifié avec de vraies données (pas de simulation)
- Définition : export réel, variance mesurée avant/après (14378→16216,
  contraste local confirmé).
- Extraction de frame : fichier JPEG réel généré (640×480, 9219 couleurs
  distinctes), automatiquement indexé comme nouvelle photo en base.
- Découpe vidéo : points de repère persistés en base ; créateur de film
  testé avec et sans découpe sur le même clip — segment de film réduit
  à la durée découpée exacte (2s sur un clip de 5s, découpe 1s→3s)
  contre la durée intégrale sans découpe (5s).
- UI réelle vérifiée dans la vraie fenêtre de l'app (pas un script
  autonome) : lecteur vidéo, bouton d'extraction et barre de découpe
  tous confirmés présents et fonctionnels.
- Parité CPU/GPU (18 filtres/réglages) et pipeline de scan complet :
  aucune régression.

Avec ce correctif, le [comparatif Picasa 3.9 vs PicaLibre](README.md)
ne montre plus aucun écart ouvert.

## [2.17.0] — 2026-07-18

### Ajouté — vraie aide interactive (façon Picasa 3)
- **Visite guidée au premier lancement** : 5 étapes qui repèrent les vrais
  éléments de l'interface (bouton Ajouter un dossier, barre latérale,
  grille, bac, bouton d'aide) avec un voile sombre et une découpe en
  surbrillance autour de chacun. Passable à tout moment, persistée
  (ne réapparaît plus une fois vue), rejouable depuis Aide → Revoir la
  visite guidée.
- **Centre d'aide cherchable** (bouton ❓ dans la barre d'outils, touche
  F1, ou Aide → Centre d'aide) : 24 sujets répartis en 7 catégories
  (Démarrer, Bibliothèque, Éditeur, Vidéo, Créations, Partage,
  Personnalisation), recherche en direct sur titre/catégorie/
  contenu/mots-clés. Certains sujets (Doublons, Carte, Photos masquées,
  Réglages) ont un bouton d'action qui ferme l'aide et navigue
  directement vers la fonctionnalité concernée.

### Vérifié de bout en bout (Xvfb + Electron réel, pas de simulation)
- Visite guidée : contenu exact de la 1ʳᵉ étape confirmé par ciblage DOM
  précis (couleur de fond + texte), bouton Passer fonctionnel,
  persistance `localStorage` confirmée, **ne réapparaît pas** à un
  nouveau lancement du process (même profil).
- Centre d'aide : ouverture via le bouton dédié confirmée, recherche
  « recadrer » → 1 résultat exact, affichage du détail confirmé,
  recherche « doublon » → clic sur le sujet → clic sur le bouton
  d'action → centre d'aide fermé **et** navigation réelle vers la vue
  Doublons confirmée (contenu de la vue vérifié).

## [2.16.0] — 2026-07-18

### Corrigé — bug majeur : la lecture vidéo était cassée pour TOUTES les vidéos
- **Cause racine** : la CSP (Content-Security-Policy) de l'app n'avait
  aucune directive `media-src`. Sans elle, `<video>` retombe sur
  `default-src 'self'`, qui exclut le protocole `thumb://` utilisé pour
  servir les vidéos — chaque tentative de lecture échouait avec
  `MEDIA_ELEMENT_ERROR: Media load rejected by URL safety check`,
  **avant même** de tester la compatibilité du codec. Confirmé sur une
  vraie vidéo H.264 : lecture cassée avant correctif, parfaite après
  (`readyState=4`, `currentTime` progresse, aucune erreur).
- Ajout de `media-src 'self' thumb:` à la CSP.

### Ajouté — vrai support HEVC/H.265 (vidéos iPhone)
- Une fois la CSP corrigée, une vraie vidéo HEVC générée localement
  (tag `hvc1`, comme sur iPhone) échouait encore avec
  `DEMUXER_ERROR_NO_SUPPORTED_STREAMS` — cette fois un vrai problème de
  codec : Chromium (build Electron standard, sans codecs propriétaires)
  ne décode pas HEVC.
- **Correctif** : détection du codec via `ffmpeg -i` (réutilise le même
  appel que le sondage de durée, `probeVideoInfo` remplace
  `probeDuration`) ; si HEVC, génération en arrière-plan d'un **proxy
  H.264** (`ffmpeg -c:v libx264`), mis en cache par hash comme les
  miniatures. Le fichier original n'est jamais modifié. Le protocole
  `thumb://library/orig/{id}` sert automatiquement le proxy s'il existe.
  Nouvelle phase dédiée `videoProxyPhase` (marqueurs `.skip` pour ne
  sonder qu'une fois les vidéos déjà en H.264 — la grande majorité —
  et rattraper aussi les bibliothèques scannées avant ce correctif).

### Vérifié avec de vraies vidéos (pas de simulation)
- Vidéo H.264 : lecture confirmée avant/après (non-régression).
- Vidéo HEVC réelle (générée via `libx265`, tag `hvc1`) : miniature OK
  nativement (ffmpeg décode HEVC), lecture cassée sans proxy
  (`DEMUXER_ERROR_NO_SUPPORTED_STREAMS`), **lecture parfaite avec proxy**
  (`videoWidth=1280`, `currentTime` progresse, `duration=5`, 0 erreur).
- Marqueur `.skip` confirmé pour la vidéo H.264 (aucun proxy inutile
  généré).
- Créateur de film (Movie Maker) avec clip HEVC en entrée : fonctionne
  sans changement (ffmpeg décode nativement, n'a jamais eu besoin du
  proxy — celui-ci ne sert qu'à la lecture via `<video>` dans l'app).

## [2.15.0] — 2026-07-18

### Ajouté — vrai support HEIC (photos iPhone)
- **Cause racine confirmée** : sharp/libvips (distribution npm standard)
  ne décode PAS le HEIC — vérifié directement via `sharp.format.heif` :
  `fileSuffix` ne liste que `.avif`, jamais `.heic`. libheif+HEVC est
  absent des binaires précompilés (licence des brevets HEVC, contrairement
  à AVIF/AV1 qui est libre de droits). L'extension `.heic` était pourtant
  déjà reconnue par le scanner → import silencieusement cassé pour toute
  photo iPhone au format par défaut depuis iOS 11.
- **Correctif** : `heic-convert` (libheif-js, WASM pur, zéro dépendance
  système, identique sur les 3 OS sans compilation native) décode le
  fichier en entier — pleine résolution, pas juste une preview basse
  qualité comme le fallback RAW/PSD existant. Nouvel utilitaire partagé
  `src/shared/heic.ts`, branché aux 3 points d'entrée réels : génération
  de miniatures en masse, génération à la volée, et `renderEdited()` —
  cette dernière couvrant à elle seule tout l'aval (éditeur, export,
  export groupé, email, fond d'écran, blog, collage, film).

### Vérifié avec un vrai fichier iPhone (pas un test synthétique)
- Fichier HEIC authentique (ISO Media, HEIF HEVC Main Profile, 2,99 Mo)
  téléchargé depuis un dépôt public.
- Décodage direct : 3992×2992px en 2,5 s.
- Scan complet via l'app réelle (Xvfb + Electron) : pipeline OK, photo
  correctement enregistrée en base (dimensions exactes), miniatures
  256/1024 générées (23 974 couleurs distinctes — image réelle, pas
  cassée/vide).
- Export simple : résolution d'origine préservée à l'identique.
- Export avec édition réelle (sépia + vignette + recadrage) :
  redimensionnement et recadrage corrects, écart mesurable de 39,4/pixel
  vs l'original confirmant que l'édition s'applique bien au contenu HEIC
  décodé (pas un passage muet).

## [2.14.2] — 2026-07-17

### Corrigé — Contraste du texte dans l'éditeur
- **Cause racine** : l'éditeur a un fond `#111418` (presque noir) mais les
  labels et titres héritaient de la couleur du thème. En thème clair,
  `--text` = `#1e293b` (gris foncé) → gris foncé sur fond noir, illisible.
- **Fix** : `color: '#e2e8f0'` (gris clair) forcé sur le conteneur et le
  panneau `aside` de l'éditeur, quel que soit le thème.
- **Titres de sections** : `color: '#cbd5e1'`, opacity 1 (au lieu de 0.85).
- **Textes d'aide** (pipette, yeux rouges, tampon) : `color: '#94a3b8'`,
  opacity 0.9 (au lieu de 0.75).
- **Boutons de navigation rapide** : `color: '#e2e8f0'` ajouté.

## [2.14.1] — 2026-07-17

### Corrigé — Lisibilité et accessibilité de l'éditeur
- **Titres de sections** : fontSize 11→13, opacity 0.5→0.85, fontWeight 600,
  letterSpacing 0.3px. Lisibles et bien contrastés.
- **Labels de curseurs** : fontSize 12→14 pour tous les sliders.
- **Panneau élargi** : 300→330px, fontSize global 14, scrollbar fin.
- **Barre de navigation rapide** : 5 boutons (Réglages, Filtres, Effets,
  Texte, Cadre) qui scrollent vers la section correspondante.
- **Section « Effets avancés »** : en-tête avec séparateur visuel (borderTop)
  regroupant Flou, Netteté, Vignette, Doucette, Glow, Orton, Tilt-shift,
  Pseudo-HDR.
- **Sections Texte et Cadre** : séparateurs visuels ajoutés.

## [2.14.0] — 2026-07-17

### Ajouté — Tilt-shift (flou radial/linéaire)
- Type `tiltshift` au DSL EditStack avec params : mode (`radial`/`linear`),
  focusX, focusY, focusRadius, blurRadius.
- Mode radial : cercle net centré sur (focusX, focusY).
- Mode linéaire : bande horizontale nette.
- Transition douce entre zone nette et zone floue (50% du rayon).
- Aperçu visuel de la zone nette (cercle/bande pointillée).
- Sliders UI : mode, focusX, focusY, focusRadius, blurRadius.
- Opération spatiale (exclue de colorOps).

### Ajouté — Pseudo-HDR (local tone mapping)
- Type `hdr` au DSL EditStack avec param `intensity` (0..1).
- Algorithme : flou léger (radius ~5px) → extraction haute fréquence
  (image - blur) → boost des détails (image + intensity * high_freq * 2) →
  compression de dynamique Reinhard (hdr / (1 + hdr/255)).
- Slider UI : intensité 0..1.
- Opération spatiale (exclue de colorOps).

## [2.13.0] — 2026-07-17

### Ajouté — Brique flou (blur foundation)
- Type `blur` au DSL EditStack avec param `radius` (0..20px).
- Opération spatiale (modifie les pixels voisins, pas juste la couleur).
- `render-sharp.ts` : `sharp.blur(radius)` pour l'export.
- `render-canvas.ts` : `ctx.filter = blur(${radius}px)` pour le CPU.
- `render-webgl.ts` : exclu de `colorOpsOf()` (opération spatiale).
- `Editor.tsx` : slider Rayon 0..20px.

### Ajouté — Netteté (sharpen / unsharp mask)
- Type `sharpen` au DSL avec param `amount` (0..1).
- Algorithme : `image + amount * (image - blur(image))` (unsharp mask).
- `render-sharp.ts` : `sharp.sharpen({ sigma: 1.0, m1: amount*500, m2: amount*500 })`.
- `render-canvas.ts` : canvas offscreen avec flou + unsharp mask pixel par pixel.
- `Editor.tsx` : slider Amount 0..100.

### Ajouté — Doucette (soft focus)
- Type `softfocus` au DSL avec param `intensity` (0..1).
- Algorithme : `blend(image, blur(image, 6px), intensity)`.
- `render-sharp.ts` : composite avec opacité (pixel blend lerp).
- `render-canvas.ts` : `globalAlpha` + `ctx.filter` blur.
- `Editor.tsx` : slider intensité.

### Ajouté — Glow (halo lumineux)
- Type `glow` au DSL avec param `intensity` (0..1).
- Algorithme : `image + screen-blend(brightness×1.3, blur(10px))`.
- `render-sharp.ts` : threshold + blur + composite screen (pixel blend).
- `render-canvas.ts` : ImageData + blend pixel par pixel.
- `Editor.tsx` : slider intensité.

### Ajouté — Orton
- Type `orton` au DSL avec param `intensity` (0..1).
- Algorithme : `blend(brightness×1.4, blur(15px), 0.5)` — sur-exposition + flou + blend.
- `render-sharp.ts` : brightness + blur + composite (pixel blend).
- `render-canvas.ts` : ImageData + blend pixel par pixel.
- `Editor.tsx` : slider intensité.

### Parité preview/export
- Tous les effets garantissent la parité preview/export (même algorithme
  pixel par pixel entre render-sharp, render-canvas et render-webgl).

## [2.12.0] — 2026-07-16

### Ajouté — 3 réglages manquants vs Picasa 3.9
- **Ombres** : miroir symétrique de « Hautes lumières » (pondéré par
  l'obscurité au lieu de la clarté) — relève ou assombrit sélectivement
  les tons foncés, sans quasiment toucher les tons clairs. Distinct de
  « Lumière de remplissage » (qui ne fait que relever, jamais assombrir).
- **Vibrance** : saturation « intelligente », boost inversement
  proportionnel à la saturation déjà présente — protège les teintes déjà
  vives et les carnations d'une sursaturation, contrairement à
  « Saturation » qui boost tout uniformément.
- **Teinte** : rotation de teinte via conversion RGB↔HSV (±180°).

### Vérifié
- Parité CPU/GPU stricte confirmée par le test dédié (écart max 1/255 sur
  les 3 nouveaux réglages, comme tous les réglages existants, y compris
  en chaîne combinée avec les autres opérations).
- Comportement sémantique vérifié unitairement : Ombres relève un pixel
  sombre (30→205) sans presque toucher un pixel clair (220→221) ;
  Vibrance protège un rouge pur déjà saturé (inchangé) tout en boostant
  une couleur pâle ; Teinte +120° sur un rouge pur donne exactement un
  vert pur (0,255,0).

## [2.11.0] — 2026-07-16

### Ajouté — édition et renommage en lot (façon Picasa)
- **✏️ Renommer en lot** : sélectionne des photos/vidéos, choisis un modèle
  (`{n}` numéro séquentiel, `{name}` nom d'origine, `{date}` date de prise
  de vue) avec aperçu en direct. Renomme les fichiers **sur le disque**
  (pas juste dans la bibliothèque), watcher de fichiers désactivé pendant
  l'opération pour éviter toute interférence, annulable (Ctrl/⌘+Z, comme
  Masquer/Fusion de doublons).
- **🪄 Correction auto (lot)** : applique contraste + balance des blancs
  automatiques à toute une sélection — mais calculés **individuellement**
  pour chaque photo (pas une valeur copiée), à partir de sa miniature déjà
  en cache (rapide).
- **📋 Copier les réglages** (éditeur) → **📥 Coller les réglages** (bac) :
  copie tuning/filtre/vignette/cadre d'une photo éditée, colle sur toute
  une sélection. Recadrage, retouche, yeux rouges et texte exclus de la
  copie (n'ont de sens que sur la photo d'origine).
- Toutes ces actions accessibles depuis le bac **et** le menu Outils.

### Vérifié
- Renommage en lot testé de bout en bout sur de vrais fichiers (Xvfb +
  Electron réel) : 5/5 fichiers renommés sur disque + base, 5/5 restaurés
  fidèlement après annulation (disque et base).
- Édition en lot testée de bout en bout : correction auto produit des
  valeurs de balance des blancs **différentes** par photo (calcul
  individuel confirmé), le collage de réglages produit des valeurs
  **identiques** sur toute la sélection (copie fidèle confirmée),
  annulation groupée vérifiée.

## [2.10.0] — 2026-07-16

### Ajouté — plus d'effets créatifs et de cadres
- **4 nouveaux filtres** dans l'éditeur : Postériser, Duoton (dégradé
  navy→orange, identité visuelle PicaLibre), Cross-process, Grain de
  film — s'ajoutent aux 5 existants (N&B, Sépia, Réchauffer, Refroidir,
  Négatif). Toujours mélangés par intensité (0-100 %) comme les filtres
  existants.
- **Vignette** (nouveau curseur dédié) : assombrissement radial des
  bords, nul au centre — effet indépendant des filtres, cumulable avec
  eux.
- **Cadre « Musée »** : bordure épaisse uniforme, en plus de Solid et
  Polaroid.
- *Note technique* : le moteur d'édition garantit une parité stricte
  CPU (export sharp) / GPU (preview WebGL) — chaque nouveau filtre a été
  implémenté des deux côtés (JS + GLSL) et vérifié par le test de parité
  dédié (écart ≤ 1/255 sur les 3 filtres couleur). Exception assumée et
  documentée pour le grain : sin() perd en précision pour de grands
  arguments sur GPU (limitation matérielle, pas un bug), sans
  conséquence pour un effet de bruit stochastique — remplacé par un
  smoke-test (exécution sans erreur) plutôt qu'une comparaison pixel.
  Vignette vérifiée par mesure de luminosité réelle (coin/centre passant
  de 0,93 à 0,24 une fois appliquée à 100 %, capture Xvfb+Electron).

## [2.9.0] — 2026-07-16

### Ajouté — comparaison côte à côte (Éditeur)
- **⇔ Comparer côte à côte** (raccourci `C`) : affiche l'original et la
  version éditée simultanément, l'un à côté de l'autre — la fonctionnalité
  phare de Picasa 3.9, absente jusqu'ici de PicaLibre. Chaque panneau est
  étiqueté (ORIGINAL / ÉDITÉ), désactivé automatiquement en mode recadrage
  (qui a besoin du canvas plein pour placer le cadre).
- *Découverte au passage* : un début d'implémentation orphelin existait
  déjà (`showOriginal`, un mode bascule original↔édité sur un seul
  canvas) mais n'était relié à aucun bouton — resté inactif. Le nouveau
  côte-à-côte le complète sans le retirer.
- **Vérifié rigoureusement** (pas juste visuellement) : capture réelle
  (Xvfb + Electron) avec un filtre N&B appliqué, coordonnées exactes des
  deux canvas récupérées via le DOM, mesure de saturation par zone
  (179 à gauche vs 36 à droite, confirmant original coloré / édité
  désaturé) et vérification pixel par pixel de l'espace entre les deux
  panneaux (0 débordement).

## [2.8.0] — 2026-07-15

### Corrigé — la vraie cause de la vignette manquante intermittente
- **Root cause identifiée** (après plusieurs pistes explorées en vain :
  signature macOS, `stream:true`, timeouts ffmpeg) : les requêtes
  sélectionnant les photos/vidéos à traiter dans le pipeline de
  miniatures ne vérifiaient l'absence que de la taille **256px** pour
  décider si un item devait être (re)traité. Si la taille 256 réussissait
  mais que la 1024 échouait (course avec le watcher de fichiers qui peut
  déclencher son propre scan pendant qu'un scan explicite est en cours),
  l'item était **exclu silencieusement de toutes les passes suivantes** —
  la miniature 1024 ne pouvait plus jamais se générer, y compris via le
  rescan automatique au démarrage (2.6.0) ou un rescan manuel.
- Les requêtes (miniatures photo et vidéo) vérifient désormais l'absence
  de **l'une ou l'autre** taille. Le pipeline devient auto-réparant : un
  échec partiel sur un item est automatiquement rattrapé à la prochaine
  passe (mécanisme de rescan déjà existant), au lieu de rester bloqué
  indéfiniment.
- **Diagnostic renforcé** : le worker de miniatures (`thumb-worker.ts`)
  logue désormais chaque échec individuel et retente une fois avant
  d'abandonner (les échecs sharp/libvips étaient jusqu'ici comptés en
  silence, sans log ni retry) ; la phase miniatures logue ses statistiques
  finales en cas d'échec.
- **Reproduit et vérifié empiriquement** : ~10 % de taux d'échec
  intermittent avant correctif (reproduit une douzaine de fois sur des
  lancements réels via Xvfb+Electron, avec inspection directe de la base
  SQLite pour confirmer précisément quelle miniature manquait) ; 30/30
  lancements réussis après correctif.

## [2.7.2] — 2026-07-15

### Corrigé
- **Timeout de téléchargement ffmpeg ramené à 15 s au lieu de 60 s** par
  une modification de debug local restée par erreur dans le commit 2.7.1
  — bien trop court pour 77 Mo sur une connexion normale (échouerait
  systématiquement en dessous de ~40 Mbps soutenus). Repéré en relisant
  le diff avant publication, jamais publié en release. Revenu à 60 s.

## [2.7.1] — 2026-07-15

### Ajouté — annulation étendue à la fusion de doublons
- **Annuler (Ctrl/⌘+Z)** couvre maintenant aussi la **fusion de doublons**
  (vue Doublons) — la seule action réellement destructive de PicaLibre
  jusqu'ici sans filet : elle fusionne notes/favoris, déplace albums/tags/
  visages vers la photo gardée, puis met l'autre à la corbeille.
- Annulation fidèle, pas approximative : un instantané complet est capturé
  **avant** la fusion (note/favori d'origine de la photo gardée, lignes
  d'albums/tags de la photo supprimée, identifiants de ses visages) et
  restauré tel quel. Seule concession pragmatique (façon Picasa, pensé
  pour un « oups » immédiat plutôt qu'un historique complet) : un tag ou
  un album que la photo gardée aurait « gagné » pendant la fusion peut
  rester après annulation — sans perte de données, juste une note en trop
  possible.

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
