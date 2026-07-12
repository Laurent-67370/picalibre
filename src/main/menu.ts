/**
 * Menu applicatif PicaLibre (français).
 * Sans menu défini, Electron affiche son menu par défaut — avec un menu
 * « Aide » vide. Celui-ci fournit un menu complet : Fichier (actions reliées
 * au renderer), Édition/Affichage/Fenêtre (rôles natifs), et une Aide utile :
 * documentation, changelog, signalement de bug, vérification de mise à jour,
 * À propos.
 */
import { app, BrowserWindow, Menu, MenuItemConstructorOptions, dialog, shell } from 'electron'
import { checkForUpdatesInteractive } from './services/updater'

const REPO = 'https://github.com/Laurent-67370/picalibre'

function sendMenuAction(win: BrowserWindow, action: string): void {
  if (!win.isDestroyed()) win.webContents.send('menu:action', { action })
}

export function buildAppMenu(win: BrowserWindow): void {
  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const, label: 'À propos de PicaLibre' },
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
          click: () => sendMenuAction(win, 'addFolder')
        },
        {
          label: 'Importer depuis SD / appareil photo…',
          accelerator: 'CmdOrCtrl+I',
          click: () => sendMenuAction(win, 'import')
        },
        { type: 'separator' },
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
        { role: 'selectAll', label: 'Tout sélectionner' }
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
          label: 'Documentation (GitHub)',
          click: () => void shell.openExternal(REPO + '#readme')
        },
        {
          label: 'Journal des modifications',
          click: () => void shell.openExternal(REPO + '/blob/main/CHANGELOG.md')
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
