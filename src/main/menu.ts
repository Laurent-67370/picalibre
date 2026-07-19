/**
 * Menu applicatif PicaLibre (français).
 *
 * Objectif : aucune fonctionnalité ne doit être découvrable uniquement par
 * hasard (bouton qui n'apparaît qu'après sélection, raccourci clavier non
 * documenté, action cachée dans un panneau contextuel). Tout ce que l'app
 * sait faire a une entrée de menu correspondante, groupée par intention
 * plutôt que par écran technique :
 *  - Fichier    : faire entrer des photos/vidéos dans la bibliothèque
 *  - Édition    : agir sur la sélection courante (éditer, noter, taguer…)
 *  - Bibliothèque : naviguer entre les vues (chronologie, carte, doublons…)
 *  - Outils     : créer quelque chose à partir de la sélection (collage,
 *                 film, export, impression…) ou lancer une analyse
 *  - Affichage/Fenêtre : rôles natifs Electron
 *  - Aide       : documentation, raccourcis clavier, à propos
 *
 * Chaque item envoie une action via 'menu:action' ; le renderer la route
 * vers la fonction correspondante (menuActionsRef dans App.tsx). Si l'action
 * nécessite une sélection et qu'il n'y en a pas, le renderer explique quoi
 * faire plutôt que de rester silencieux.
 */
import { app, BrowserWindow, Menu, MenuItemConstructorOptions, dialog, shell } from 'electron'
import log from 'electron-log/main'
import { checkForUpdatesInteractive } from './services/updater'

const REPO = 'https://github.com/Laurent-67370/picalibre'

function sendMenuAction(win: BrowserWindow, action: string): void {
  if (!win.isDestroyed()) win.webContents.send('menu:action', { action })
}

const SHORTCUTS = [
  ['Clic', 'Sélectionner une photo/vidéo'],
  ['Ctrl/⌘ + clic', 'Ajouter à la sélection'],
  ['Maj + clic', 'Sélectionner une plage'],
  ['Ctrl/⌘ + A', 'Tout sélectionner'],
  ['Échap', 'Vider la sélection / fermer'],
  ['Double-clic', 'Ouvrir en plein écran'],
  ['Clic droit', "Menu d'actions sur la photo"],
  ['Glisser-déposer', 'Ajouter à un album (dans la barre latérale)'],
  ['← / →', 'Photo précédente / suivante (visionneuse)'],
  ['Molette', 'Zoom (visionneuse, images)'],
  ['Double-clic (visionneuse)', 'Basculer ajusté ↔ 100 %'],
  ['E', 'Éditer la photo affichée (visionneuse)']
].map(([k, d]) => `${k.padEnd(26, ' ')} ${d}`).join('\n')

export function buildAppMenu(win: BrowserWindow): void {
  const isMac = process.platform === 'darwin'
  const act = (action: string): (() => void) => () => sendMenuAction(win, action)

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const, label: 'À propos de PicaLibre' },
              { type: 'separator' as const },
              {
                label: 'Réglages…',
                accelerator: 'Cmd+,',
                click: act('goSettings')
              },
              { type: 'separator' as const },
              { role: 'hide' as const, label: 'Masquer PicaLibre' },
              { role: 'unhide' as const, label: 'Tout afficher' },
              { type: 'separator' as const },
              { role: 'quit' as const, label: 'Quitter PicaLibre' }
            ]
          }
        ]
      : []),
    {
      label: 'Fichier',
      submenu: [
        {
          label: 'Ajouter un dossier à scanner…',
          accelerator: 'CmdOrCtrl+O',
          click: act('addFolder')
        },
        {
          label: 'Importer depuis SD / appareil photo…',
          accelerator: 'CmdOrCtrl+I',
          click: act('import')
        },
        {
          label: 'Rescanner la bibliothèque',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: act('rescan')
        },
        { type: 'separator' },
        ...(isMac
          ? []
          : [
              {
                label: 'Réglages…',
                accelerator: 'Ctrl+,',
                click: act('goSettings')
              },
              { type: 'separator' as const }
            ]),
        ...(isMac ? [] : [{ role: 'quit' as const, label: 'Quitter' }])
      ]
    },
    {
      label: 'Édition',
      submenu: [
        { role: 'undo', label: 'Annuler' },
        { role: 'redo', label: 'Rétablir' },
        { type: 'separator' },
        { role: 'cut', label: 'Couper' },
        { role: 'copy', label: 'Copier' },
        { role: 'paste', label: 'Coller' },
        { role: 'selectAll', label: 'Tout sélectionner' },
        { type: 'separator' },
        {
          label: 'Éditer la photo sélectionnée…',
          click: act('editSelected')
        },
        {
          label: 'Noter',
          submenu: [0, 1, 2, 3, 4, 5].map((n) => ({
            label: n === 0 ? 'Aucune note' : '★'.repeat(n),
            click: act(`rate${n}`)
          }))
        },
        { label: 'Taguer la sélection…', click: act('tagSelection') },
        { label: 'Créer un album avec la sélection…', click: act('createAlbum') },
        { label: 'Masquer / afficher la sélection', click: act('toggleHideSelection') },
        { label: '🗑 Mettre la sélection à la corbeille', click: act('trashSelection') },
        { type: 'separator' },
        { label: 'Vider la sélection (Échap)', click: act('clearSelection') }
      ]
    },
    {
      label: 'Bibliothèque',
      submenu: [
        { label: '🕒 Chronologie', click: act('goTimeline') },
        { label: '🗺 Carte', click: act('goMap') },
        { label: '⧉ Doublons', click: act('goDuplicates') },
        { label: '🙈 Photos masquées', click: act('goHidden') },
        { label: '🗑 Corbeille', click: act('goTrash') },
        { type: 'separator' },
        { label: '🔍 Analyser les visages (détection des personnes)', click: act('scanFaces') }
      ]
    },
    {
      label: 'Outils',
      submenu: [
        { label: '▶ Diaporama de la vue courante', click: act('slideshow') },
        { type: 'separator' },
        { label: '🧩 Créer un collage avec la sélection…', click: act('collage') },
        { label: '🎬 Créer un film avec la sélection…', click: act('movie') },
        { type: 'separator' },
        { label: '🧳 Détecter voyages/événements…', click: act('detectTrips') },
        { type: 'separator' },
        { label: '🖨 Imprimer la sélection…', click: act('print') },
        { label: '💾 Exporter la sélection…', click: act('exportSelection') },
        { label: '📤 Export groupé (taille/format)…', click: act('batchExport') },
        { label: '✉ Envoyer la sélection par email', click: act('emailSelection') },
        { label: '📄 Exporter les métadonnées (CSV)', click: act('csvExport') },
        { type: 'separator' },
        { label: '🪄 Correction auto (sélection)', click: act('autoFix') },
        { label: '📥 Coller les réglages copiés (sélection)', click: act('pasteSettings') },
        { label: '✏️ Renommer en lot (sélection)…', click: act('batchRename') }
      ]
    },
    {
      label: 'Affichage',
      submenu: [
        { role: 'reload', label: 'Recharger' },
        { role: 'toggleDevTools', label: 'Outils de développement' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Zoom normal' },
        { role: 'zoomIn', label: 'Zoom avant' },
        { role: 'zoomOut', label: 'Zoom arrière' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Plein écran' }
      ]
    },
    {
      label: 'Fenêtre',
      submenu: [
        { role: 'minimize', label: 'Réduire' },
        { role: 'close', label: 'Fermer' }
      ]
    },
    {
      label: 'Aide',
      submenu: [
        {
          label: '❓ Centre d\'aide',
          accelerator: 'F1',
          click: act('openHelp')
        },
        {
          label: 'Revoir la visite guidée',
          click: act('replayTour')
        },
        { type: 'separator' },
        {
          label: 'Documentation (GitHub)',
          click: () => void shell.openExternal(REPO + '#readme')
        },
        {
          label: 'Journal des modifications',
          click: () => void shell.openExternal(REPO + '/blob/main/CHANGELOG.md')
        },
        {
          label: '⌨️ Raccourcis clavier',
          click: () => {
            void dialog.showMessageBox(win, {
              type: 'info',
              title: 'Raccourcis clavier',
              message: 'Raccourcis clavier et gestes PicaLibre',
              detail: SHORTCUTS,
              buttons: ['Fermer']
            })
          }
        },
        {
          label: 'Ouvrir le dossier des logs',
          click: () => {
            const file = log.transports.file.getFile().path
            shell.showItemInFolder(file)
          }
        },
        {
          label: 'Signaler un problème…',
          click: () => void shell.openExternal(REPO + '/issues/new')
        },
        { type: 'separator' },
        {
          label: 'Rechercher les mises à jour…',
          click: () => void checkForUpdatesInteractive(win)
        },
        { type: 'separator' },
        {
          label: 'À propos de PicaLibre',
          click: () => {
            void dialog.showMessageBox(win, {
              type: 'info',
              title: 'À propos de PicaLibre',
              message: `PicaLibre ${app.getVersion()}`,
              detail:
                `Gestionnaire de photos et vidéos open-source inspiré de Picasa.\n` +
                `100 % local — aucune donnée n'est envoyée dans le cloud.\n\n` +
                `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}\n\n` +
                `${REPO}\nLicence MIT`,
              buttons: ['Fermer']
            })
          }
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
