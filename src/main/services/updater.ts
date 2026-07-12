/**
 * Auto-update via electron-updater + releases GitHub.
 * - Windows (NSIS) et macOS : téléchargement puis installation au redémarrage.
 * - Linux : uniquement en AppImage (le .deb passe par le gestionnaire de paquets).
 * - Jamais actif en dev (app non packagée).
 */
import { autoUpdater } from 'electron-updater'
import { BrowserWindow, app } from 'electron'

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
