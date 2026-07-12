import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'node:path'
import { initDb, getDb } from './db'
import { startScan } from './services/scanner'

let mainWindow: BrowserWindow

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#1e2126',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  ipcMain.handle('scanRoots:list', () =>
    getDb().prepare('SELECT id, path, mode FROM scan_roots').all()
  )
  ipcMain.handle('scanRoots:add', (_e, { path, mode = 'watch' }) => {
    const r = getDb()
      .prepare('INSERT INTO scan_roots (path, mode) VALUES (?, ?) RETURNING id')
      .get(path, mode) as { id: number }
    return r
  })
  ipcMain.handle('scanRoots:remove', (_e, { id }) => {
    getDb().prepare('DELETE FROM scan_roots WHERE id = ?').run(id)
  })
  ipcMain.handle('scan:start', () => {
    startScan(mainWindow)
    return { jobId: 0 }
  })
  ipcMain.handle('folders:tree', () =>
    getDb().prepare('SELECT id, path, parent_id, is_hidden FROM folders ORDER BY path').all()
  )
  ipcMain.handle('photos:byFolder', (_e, { folderId, offset, limit }) =>
    getDb()
      .prepare(
        `SELECT * FROM photos WHERE folder_id = ? AND status = 'active' AND is_hidden = 0
         ORDER BY taken_at DESC, filename LIMIT ? OFFSET ?`
      )
      .all(folderId, limit, offset)
  )
  ipcMain.handle('photos:setRating', (_e, { photoId, rating }) => {
    getDb().prepare('UPDATE photos SET rating = ? WHERE id = ?').run(rating, photoId)
  })
  ipcMain.handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
}

app.whenReady().then(() => {
  initDb(join(__dirname, 'migrations'))
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
