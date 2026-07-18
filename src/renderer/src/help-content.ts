/**
 * Contenu du Centre d'aide — recherché par mot-clé, organisé par catégorie.
 * `action` optionnelle : ce que fait le bouton "Afficher" du sujet (id de
 * vue à charger, ou null si le sujet n'a pas de destination directe).
 */
export interface HelpTopic {
  id: string
  category: string
  title: string
  keywords: string[]
  body: string
  action?: { label: string; view: 'timeline' | 'map' | 'duplicates' | 'hidden' | 'settings' }
}

export const HELP_TOPICS: HelpTopic[] = [
  // ---- Démarrer ----
  {
    id: 'add-folder',
    category: 'Démarrer',
    title: 'Ajouter un dossier à la bibliothèque',
    keywords: ['ajouter', 'dossier', 'scan', 'importer', 'watcher', 'surveiller'],
    body: `Fichier → Ajouter un dossier à scanner (Ctrl/⌘+O), ou le bouton « + Ajouter un dossier » en haut de la barre latérale. Le dossier est ensuite surveillé en continu : tout nouveau fichier y apparaissant est automatiquement ajouté à la bibliothèque, sans avoir à relancer de scan manuellement.`
  },
  {
    id: 'import-sd',
    category: 'Démarrer',
    title: 'Importer depuis une carte SD ou un appareil photo',
    keywords: ['import', 'carte sd', 'appareil photo', 'copier'],
    body: `Fichier → Importer depuis SD/appareil (Ctrl/⌘+I). Les fichiers sont copiés vers un dossier de destination organisé par mois (AAAA-MM), les doublons déjà présents dans la bibliothèque (même empreinte) sont automatiquement ignorés.`
  },
  {
    id: 'rescan',
    category: 'Démarrer',
    title: 'Relancer un scan manuellement',
    keywords: ['rescan', 'rafraîchir', 'actualiser', 'relancer'],
    body: `Fichier → Rescanner la bibliothèque (Ctrl/⌘+Maj+R). Utile si un fichier a été modifié en dehors de l'app, ou si une miniature semble ne jamais s'être générée. Un léger rescan se relance aussi automatiquement à chaque démarrage de l'app.`
  },

  // ---- Bibliothèque ----
  {
    id: 'timeline',
    category: 'Bibliothèque',
    title: 'Chronologie et navigation',
    keywords: ['chronologie', 'timeline', 'dossiers', 'date', 'mois'],
    body: `La Chronologie regroupe toutes les photos et vidéos par mois. La barre latérale liste aussi les dossiers surveillés individuellement, les albums, et les personnes détectées. Clique sur n'importe quelle entrée pour filtrer la grille.`,
    action: { label: 'Ouvrir la Chronologie', view: 'timeline' }
  },
  {
    id: 'search-filter',
    category: 'Bibliothèque',
    title: 'Rechercher et filtrer',
    keywords: ['recherche', 'filtre', 'étoile', 'note', 'tag', 'nom'],
    body: `La barre de recherche (nom, tag) est en haut de la barre latérale. Dans la grille, les menus déroulants permettent de filtrer par note minimale (★) et par type (photos/vidéos). Le curseur en bas à droite ajuste la taille des vignettes.`
  },
  {
    id: 'selection',
    category: 'Bibliothèque',
    title: 'Sélectionner plusieurs photos (le bac)',
    keywords: ['sélection', 'bac', 'panier', 'multiple', 'ctrl', 'shift'],
    body: `Clic : sélectionner. Ctrl/⌘+clic : ajouter à la sélection. Maj+clic : sélectionner une plage. Ctrl/⌘+A : tout sélectionner. Échap : vider la sélection. Les photos sélectionnées apparaissent dans le bac en bas de fenêtre, avec toutes les actions groupées (albums, tags, export, correction auto, renommage…).`
  },
  {
    id: 'albums-tags',
    category: 'Bibliothèque',
    title: 'Albums et tags',
    keywords: ['album', 'tag', 'étiquette', 'collection'],
    body: `Sélectionne des photos, tape un nom dans le champ du bac, puis « Créer un album » ou « Taguer ». Un album est une collection virtuelle (les photos restent dans leur dossier d'origine) ; les tags sont cherchables depuis la barre de recherche.`
  },
  {
    id: 'people',
    category: 'Bibliothèque',
    title: 'Reconnaissance des personnes',
    keywords: ['visage', 'personne', 'reconnaissance', 'fusionner', 'scinder'],
    body: `« 🔍 Analyser les visages » dans la barre latérale détecte et regroupe les visages par personne. Renomme une personne en cliquant sur son nom. En cas d'erreur de regroupement, la vue Personne propose de fusionner deux personnes ou de scinder un visage mal classé.`
  },
  {
    id: 'map',
    category: 'Bibliothèque',
    title: 'Carte et géolocalisation',
    keywords: ['carte', 'géolocalisation', 'gps', 'lieu'],
    body: `Les photos avec coordonnées GPS (EXIF ou ajoutées manuellement) apparaissent sur la carte, avec regroupement automatique par zone. Depuis le bac, tu peux aussi géolocaliser manuellement une sélection en cliquant sur la carte.`,
    action: { label: 'Ouvrir la Carte', view: 'map' }
  },
  {
    id: 'duplicates',
    category: 'Bibliothèque',
    title: 'Doublons',
    keywords: ['doublon', 'dupliqué', 'fusion', 'même photo'],
    body: `La vue Doublons détecte les fichiers identiques (même empreinte de contenu) et propose de les fusionner : la meilleure note et le statut favori sont conservés, albums/tags/visages sont transférés vers la photo gardée. Cette fusion est annulable (Ctrl/⌘+Z) juste après.`,
    action: { label: 'Ouvrir les Doublons', view: 'duplicates' }
  },
  {
    id: 'hidden',
    category: 'Bibliothèque',
    title: 'Photos masquées et confidentialité',
    keywords: ['masquer', 'cacher', 'privé', 'mot de passe', 'confidentialité'],
    body: `Masquer une sélection (clic droit → Masquer, ou bouton du bac) la retire de toutes les vues normales. Un mot de passe optionnel (Réglages) peut verrouiller l'accès à la vue Masquées. Rien ne quitte jamais ton ordinateur : PicaLibre est 100 % local, aucun cloud.`,
    action: { label: 'Ouvrir les Photos masquées', view: 'hidden' }
  },

  // ---- Éditeur ----
  {
    id: 'editor-basics',
    category: 'Éditeur',
    title: 'Recadrer, redresser, outils de base',
    keywords: ['recadrer', 'redresser', 'crop', 'pipette', 'yeux rouges', 'tampon', 'retouche'],
    body: `Double-clic sur une photo puis « ✎ Éditer » (ou touche E dans la visionneuse). Recadrage avec ratios (libre, 1:1, 4:3, 3:2, 16:9) et règle des tiers. La pipette de blanc corrige la balance des couleurs d'un simple clic. Les outils Yeux rouges et Tampon (retouche) se sélectionnent puis se cliquent directement sur la photo.`
  },
  {
    id: 'editor-adjustments',
    category: 'Éditeur',
    title: 'Réglages (lumière, couleur)',
    keywords: ['ombre', 'lumière', 'contraste', 'saturation', 'vibrance', 'température', 'teinte', 'curseur'],
    body: `Contraste auto et Couleur auto en un clic. Curseurs manuels : Lumière de remplissage, Hautes lumières, Ombres (relève/assombrit les tons foncés sans toucher les clairs), Contraste, Saturation, Vibrance (protège les teintes déjà vives), Température, Teinte (rotation des couleurs).`
  },
  {
    id: 'editor-filters',
    category: 'Éditeur',
    title: 'Filtres créatifs',
    keywords: ['filtre', 'noir et blanc', 'sépia', 'négatif', 'postériser', 'duoton', 'cross-process'],
    body: `N&B, Sépia, Réchauffer, Refroidir, Négatif, Postériser, Duoton, Cross-process, Grain de film — chacun avec un curseur d'intensité. S'appliquent en plus des réglages et effets avancés, tous combinables.`
  },
  {
    id: 'editor-blur-effects',
    category: 'Éditeur',
    title: 'Flou, netteté et effets avancés',
    keywords: ['flou', 'netteté', 'vignette', 'doucette', 'glow', 'orton', 'tilt-shift', 'hdr', 'flou radial', 'définition', 'clarté'],
    body: `Section « Effets avancés » : Flou gaussien, Netteté (accentuation), Vignette (assombrit les bords), Doucette (soft focus), Glow (halo lumineux), Orton (effet rêveur classique), Tilt-shift radial/linéaire (zone nette entourée de flou, effet miniature), Pseudo-HDR (accentuation des détails locaux), Définition/Clarté (contraste local sur une zone large, accentue la texture sans les halos fins de la Netteté).`
  },
  {
    id: 'editor-compare',
    category: 'Éditeur',
    title: 'Comparer avant/après',
    keywords: ['comparer', 'côte à côte', 'avant après', 'original'],
    body: `Bouton « ⇔ Comparer côte à côte » (ou touche C) : affiche l'original et la version éditée côte à côte, en temps réel pendant que tu ajustes les curseurs. Désactivé automatiquement en mode recadrage.`
  },
  {
    id: 'editor-text-border',
    category: 'Éditeur',
    title: 'Texte et cadres',
    keywords: ['texte', 'légende', 'cadre', 'bordure', 'polaroid', 'musée'],
    body: `Ajoute un texte libre (police, taille, couleur, position) directement sur la photo. Styles de cadre : Solid (bordure fine uniforme), Polaroid (bord bas large), Musée (cadre épais uniforme).`
  },
  {
    id: 'batch-edit',
    category: 'Éditeur',
    title: 'Édition en lot',
    keywords: ['lot', 'plusieurs photos', 'correction auto', 'copier réglages', 'coller réglages'],
    body: `Depuis le bac ou le menu Outils : « 🪄 Correction auto » calcule contraste et couleur individuellement pour chaque photo sélectionnée. « 📋 Copier les réglages » dans l'éditeur puis « 📥 Coller les réglages » sur une sélection applique les mêmes filtres/curseurs/cadre à tout un groupe d'un coup.`
  },
  {
    id: 'batch-rename',
    category: 'Éditeur',
    title: 'Renommer en lot',
    keywords: ['renommer', 'lot', 'nom de fichier', 'modèle'],
    body: `Sélectionne des fichiers, bac ou menu Outils → « ✏️ Renommer ». Modèle personnalisable avec {n} (numéro séquentiel), {name} (nom d'origine) et {date} (date de prise de vue). Aperçu en direct avant de confirmer, annulable ensuite (Ctrl/⌘+Z).`
  },

  // ---- Vidéo ----
  {
    id: 'video-playback',
    category: 'Vidéo',
    title: 'Lecture vidéo et formats supportés',
    keywords: ['vidéo', 'lecture', 'hevc', 'h265', 'codec', 'iphone'],
    body: `Double-clic sur une vidéo pour la lire avec les contrôles natifs (lecture, volume, plein écran). Les formats courants (MP4, MOV, MKV, WebM…) sont pris en charge, y compris les vidéos HEVC/H.265 des iPhone récents — un fichier optimisé pour la lecture est généré automatiquement en arrière-plan la première fois, sans jamais modifier le fichier original.`
  },
  {
    id: 'heic',
    category: 'Vidéo',
    title: 'Photos HEIC (iPhone)',
    keywords: ['heic', 'heif', 'iphone', 'photo'],
    body: `Les photos au format HEIC (par défaut sur iPhone depuis iOS 11) sont automatiquement décodées en pleine résolution — miniatures, édition et export fonctionnent normalement, comme pour un JPEG.`
  },
  {
    id: 'video-trim',
    category: 'Vidéo',
    title: 'Découper une vidéo',
    keywords: ['découpe', 'trim', 'couper', 'début', 'fin', 'extrait'],
    body: `En lisant une vidéo dans la visionneuse, une barre sous le lecteur propose « ⏱ Marquer début » et « ⏱ Marquer fin » : ils capturent l'instant de lecture actuel. Non destructif — seuls ces deux repères sont enregistrés, le fichier original n'est jamais modifié. La lecture dans l'app boucle ensuite automatiquement sur la zone découpée, et l'inclusion dans un film (créateur de film) n'utilise que cet extrait. « ↺ Réinitialiser » retire la découpe.`
  },
  {
    id: 'video-extract-frame',
    category: 'Vidéo',
    title: "Extraire une image fixe d'une vidéo",
    keywords: ['extraire', 'capture', 'image fixe', 'photo depuis vidéo'],
    body: `En lisant une vidéo, mets-la en pause sur l'image voulue puis clique « 📷 Extraire cette image ». Une nouvelle photo est créée à partir de cette image précise et apparaît automatiquement dans la bibliothèque, dans le même dossier que la vidéo source.`
  },

  // ---- Créations ----
  {
    id: 'slideshow',
    category: 'Créations',
    title: 'Diaporama et écran de veille',
    keywords: ['diaporama', 'écran de veille', 'plein écran', 'ken burns'],
    body: `« ▶ Diaporama » lance un défilement plein écran avec effet Ken Burns (zoom/panoramique lent). Réglages → Écran de veille photo : lance automatiquement un diaporama après une période d'inactivité configurable.`
  },
  {
    id: 'collage',
    category: 'Créations',
    title: 'Collage photo',
    keywords: ['collage', 'montage', 'grille photo'],
    body: `Sélectionne 2 à 7 photos, bac → « 🧩 Collage ». Plusieurs mises en page disponibles, export en JPEG/WebP/PNG.`
  },
  {
    id: 'movie',
    category: 'Créations',
    title: 'Créer un film',
    keywords: ['film', 'movie', 'vidéo montage', 'musique'],
    body: `Mélange photos et clips vidéo dans un même film avec transitions et musique de fond (playlist multi-pistes). Accessible depuis le bac (« 🎬 Créer un film ») ou depuis une page Personne pour un film centré sur quelqu'un.`
  },

  // ---- Partage ----
  {
    id: 'export-share',
    category: 'Partage',
    title: 'Exporter et partager',
    keywords: ['export', 'partage', 'email', 'fond d\'écran', 'blog', 'impression', 'csv'],
    body: `Depuis le bac ou le menu Outils : Export simple ou groupé (taille/format/qualité), Email, Fond d'écran, Export vers blog, Impression (mise en page, formats papier), Export CSV des métadonnées.`
  },
  {
    id: 'web-gallery',
    category: 'Partage',
    title: 'Galerie mobile (accès web)',
    keywords: ['web', 'mobile', 'sync', 'serveur', 'à distance'],
    body: `Réglages → Galerie mobile : synchronise miniatures et métadonnées (jamais les fichiers originaux) vers un petit serveur que tu héberges toi-même, consultable depuis ton téléphone. Protection par jeton d'accès.`,
    action: { label: 'Ouvrir les Réglages', view: 'settings' }
  },

  // ---- Personnalisation ----
  {
    id: 'theme',
    category: 'Personnalisation',
    title: 'Thème clair / sombre',
    keywords: ['thème', 'clair', 'sombre', 'apparence', 'couleur'],
    body: `Réglages → Apparence : thème clair (par défaut, inspiré de Picasa 3) ou sombre (palette navy/orange historique de PicaLibre). La visionneuse et l'éditeur restent volontairement sombres dans les deux cas, pour ne pas fausser le jugement des couleurs pendant l'édition.`,
    action: { label: 'Ouvrir les Réglages', view: 'settings' }
  },
  {
    id: 'shortcuts',
    category: 'Personnalisation',
    title: 'Raccourcis clavier',
    keywords: ['raccourci', 'clavier', 'touche'],
    body: `Liste complète dans Aide → Raccourcis clavier. Les plus utiles : Ctrl/⌘+A (tout sélectionner), Échap (fermer/désélectionner), double-clic (afficher/lire), E (éditer, dans la visionneuse), C (comparer, dans l'éditeur), Ctrl/⌘+Z (annuler la dernière action).`
  }
]

export function searchHelp(query: string): HelpTopic[] {
  const q = query.trim().toLowerCase()
  if (!q) return HELP_TOPICS
  return HELP_TOPICS.filter(
    (t) =>
      t.title.toLowerCase().includes(q) ||
      t.category.toLowerCase().includes(q) ||
      t.body.toLowerCase().includes(q) ||
      t.keywords.some((k) => k.includes(q))
  )
}
