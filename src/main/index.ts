import { app, BrowserWindow, ipcMain, dialog, protocol, net } from 'electron'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { initDb, getDb } from './db'
import { getEditState, saveStack, undo, redo } from './services/edits'
import { renderEdited } from './services/render-sharp'
import { startScan } from './services/scanner'

let mainWindow: BrowserWindow

// Doit être appelé AVANT app.whenReady()
protocol.registerSchemesAsPrivileged([
  { scheme: 'thumb', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

/** thumb://library/{size}/{photoId} → fichier webp du cache */
function registerThumbProtocol(): void {
  protocol.handle('thumb', (request) => {
    const parts = new URL(request.url).pathname.split('/').filter(Boolean)
    const size = parseInt(parts[0], 10)
    const photoId = parseInt(parts[1], 10)
    const row = getDb()
      .prepare('SELECT cache_path FROM thumbnails WHERE photo_id = ? AND size = ?')
      .get(photoId, size) as { cache_path: string } | undefined
    if (!row) return new Response('not found', { status: 404 })
    return net.fetch(pathToFileURL(row.cache_path).toString())
  })
}

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
  ipcMain.handle('photos:byAlbum', (_e, { albumId, offset, limit }) =>
    getDb()
      .prepare(
        `SELECT p.* FROM photos p
         JOIN album_items ai ON ai.photo_id = p.id
         WHERE ai.album_id = ? AND p.status = 'active' AND p.is_hidden = 0
         ORDER BY ai.position, p.taken_at DESC LIMIT ? OFFSET ?`
      )
      .all(albumId, limit, offset)
  )
  ipcMain.handle('photos:search', (_e, { query, offset, limit }) => {
    const like = `%${query}%`
    return getDb()
      .prepare(
        `SELECT DISTINCT p.* FROM photos p
         LEFT JOIN photo_tags pt ON pt.photo_id = p.id
         LEFT JOIN tags t ON t.id = pt.tag_id
         WHERE p.status = 'active' AND p.is_hidden = 0
           AND (p.filename LIKE ? OR p.caption LIKE ? OR t.name LIKE ?)
         ORDER BY p.taken_at DESC LIMIT ? OFFSET ?`
      )
      .all(like, like, like, limit, offset)
  })
  ipcMain.handle('albums:list', () =>
    getDb()
      .prepare(
        `SELECT a.id, a.name, a.kind, COUNT(ai.photo_id) AS count
         FROM albums a LEFT JOIN album_items ai ON ai.album_id = a.id
         GROUP BY a.id ORDER BY a.sort_order, a.name COLLATE NOCASE`
      )
      .all()
  )
  ipcMain.handle('albums:create', (_e, { name }) =>
    getDb().prepare('INSERT INTO albums (name) VALUES (?) RETURNING id').get(name)
  )
  ipcMain.handle('albums:addPhotos', (_e, { albumId, photoIds }) => {
    const db = getDb()
    const maxPos = db
      .prepare('SELECT COALESCE(MAX(position), 0) AS m FROM album_items WHERE album_id = ?')
      .get(albumId) as { m: number }
    const stmt = db.prepare(
      'INSERT OR IGNORE INTO album_items (album_id, photo_id, position) VALUES (?, ?, ?)'
    )
    const tx = db.transaction((ids: number[]) => {
      ids.forEach((pid, i) => stmt.run(albumId, pid, maxPos.m + i + 1))
    })
    tx(photoIds)
  })
  ipcMain.handle('tags:list', () =>
    getDb()
      .prepare(
        `SELECT t.id, t.name, COUNT(pt.photo_id) AS count
         FROM tags t LEFT JOIN photo_tags pt ON pt.tag_id = t.id
         GROUP BY t.id ORDER BY t.name COLLATE NOCASE`
      )
      .all()
  )
  ipcMain.handle('tags:addToPhotos', (_e, { name, photoIds }) => {
    const db = getDb()
    const tag = db
      .prepare(
        `INSERT INTO tags (name) VALUES (?)
         ON CONFLICT(name) DO UPDATE SET name = excluded.name RETURNING id`
      )
      .get(name.trim()) as { id: number }
    const stmt = db.prepare('INSERT OR IGNORE INTO photo_tags (photo_id, tag_id) VALUES (?, ?)')
    const tx = db.transaction((ids: number[]) => {
      for (const pid of ids) stmt.run(pid, tag.id)
    })
    tx(photoIds)
  })
  ipcMain.handle('edits:get', (_e, { photoId }) => getEditState(photoId))
  ipcMain.handle('edits:save', (_e, { photoId, stack, action }) => {
    const s = saveStack(photoId, stack, action)
    return { canUndo: s.canUndo, canRedo: s.canRedo }
  })
  ipcMain.handle('edits:undo', (_e, { photoId }) => undo(photoId))
  ipcMain.handle('edits:redo', (_e, { photoId }) => redo(photoId))
  ipcMain.handle('edits:export', async (_e, { photoId, format = 'jpeg', maxSize }) => {
    const photo = getDb()
      .prepare('SELECT filepath, filename FROM photos WHERE id = ?')
      .get(photoId) as { filepath: string; filename: string } | undefined
    if (!photo) return { outPath: null }
    const base = photo.filename.replace(/\.[^.]+$/, '')
    const ext = format === 'jpeg' ? 'jpg' : format
    const r = await dialog.showSaveDialog(mainWindow, {
      defaultPath: `${base}_edit.${ext}`,
      filters: [{ name: format.toUpperCase(), extensions: [ext] }]
    })
    if (r.canceled || !r.filePath) return { outPath: null }
    const { stack } = getEditState(photoId)
    const buffer = await renderEdited(photo.filepath, stack, { format, maxSize })
    await writeFile(r.filePath, buffer)
    return { outPath: r.filePath }
  })
  ipcMain.handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
}

app.whenReady().then(() => {
  initDb(join(__dirname, 'migrations'))
  registerThumbProtocol()
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
