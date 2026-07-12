/**
 * Auto-update via electron-updater + releases GitHub.
 * - Windows (NSIS) et macOS : téléchargement puis installation au redémarrage.
 * - Linux : uniquement en AppImage (le .deb passe par le gestionnaire de paquets).
 * - Jamais actif en dev (app non packagée).
 */
import { autoUpdater } from 'electron-updater'
import { BrowserWindow, app, dialog } from 'electron'

export function initAutoUpdate(win: BrowserWindow): void {
  if (!app.isPackaged) return
  if (process.platform === 'linux' && !process.env.APPIMAGE) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  const send = (status: string, info?: unknown): void => {
    if (!win.isDestroyed()) win.webContents.send('update:status', { status, info })
  }
  autoUpdater.on('update-available', (i) => send('available', { version: i.version }))
  autoUpdater.on('download-progress', (p) => send('downloading', { percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (i) => send('ready', { version: i.version }))
  autoUpdater.on('error', (e) => send('error', { message: e.message }))

  // Premier check 5 s après le lancement, puis toutes les 4 h
  setTimeout(() => void autoUpdater.checkForUpdates().catch(() => {}), 5000)
  setInterval(() => void autoUpdater.checkForUpdates().catch(() => {}), 4 * 3600 * 1000)
}

export function installUpdate(): void {
  autoUpdater.quitAndInstall()
}

/** Vérification déclenchée depuis le menu Aide, avec retour visuel systématique. */
export async function checkForUpdatesInteractive(win: BrowserWindow): Promise<void> {
  if (!app.isPackaged) {
    void dialog.showMessageBox(win, {
      type: 'info',
      message: 'Mode développement',
      detail: "La vérification des mises à jour n'est active que dans l'application installée."
    })
    return
  }
  if (process.platform === 'linux' && !process.env.APPIMAGE) {
    void dialog.showMessageBox(win, {
      type: 'info',
      message: 'Installation .deb',
      detail: 'Les mises à jour du paquet .deb passent par votre gestionnaire de paquets.\nLa version AppImage se met à jour automatiquement.'
    })
    return
  }
  try {
    const result = await autoUpdater.checkForUpdates()
    const latest = result?.updateInfo?.version
    if (!latest || latest === app.getVersion()) {
      void dialog.showMessageBox(win, {
        type: 'info',
        message: 'PicaLibre est à jour',
        detail: `Version installée : ${app.getVersion()}`
      })
    }
    // Si une mise à jour existe, le flux automatique prend le relais
    // (téléchargement + bandeau « Redémarrer et installer »).
  } catch (err) {
    void dialog.showMessageBox(win, {
      type: 'warning',
      message: 'Vérification impossible',
      detail: (err as Error).message
    })
  }
}
