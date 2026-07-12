import { app, BrowserWindow, ipcMain, dialog, protocol, net } from 'electron'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { initDb, getDb } from './db'
import { getEditState, saveStack, undo, redo } from './services/edits'
import { startFaceScan, isFaceScanRunning, humanModelsPath } from './services/faces'
import { mergePersons, splitFaces, confirmFaces, rejectFaces, facesByPerson } from './services/faces/manage-core'
import { startWatchers } from './services/watcher'
import { importFromDevice } from './services/importer'
import { relocateLibrary } from './services/relocate'
import { privacyStatus, setPassword, unlock, lock, isUnlocked } from './services/privacy'
import { batchExport, exportMetadataCsv, emailShare } from './services/exporter'
import { printPhotos } from './services/printer'
import { makeCollage, CollageItem } from './services/collage'
import { makeMovie, MovieItem } from './services/movie'
import ffmpegPath from 'ffmpeg-static'
import { parseStack } from '../shared/edit-engine'
import { renderEdited } from './services/render-sharp'
import { startScan } from './services/scanner'

app.setName('picalibre')

let mainWindow: BrowserWindow

// Doit être appelé AVANT app.whenReady()
protocol.registerSchemesAsPrivileged([
  { scheme: 'thumb', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'faceres', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

/** thumb://library/{size}/{photoId} → fichier webp du cache */
/** faceres://models/<fichier> → modèles Human embarqués (node_modules) */
function registerFaceresProtocol(): void {
  protocol.handle('faceres', (request) => {
    const u = new URL(request.url)
    const file = u.pathname.replace(/^\/+/, '')
    if (file.includes('..')) return new Response('forbidden', { status: 403 })
    const full = join(humanModelsPath(), file)
    return net.fetch(pathToFileURL(full).toString())
  })
}

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
  const webglTest = !!process.env.PICALIBRE_TEST_WEBGL
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL + (webglTest ? '?webgltest=1' : ''))
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: webglTest ? { webgltest: '1' } : undefined
    })
  }
  if (webglTest) {
    mainWindow.webContents.on('console-message', (_e, _level, message) => {
      if (message.startsWith('[webgl-test]')) {
        console.log(message)
        if (message.includes('VERDICT:')) {
          app.exit(message.includes('PASS') || message.includes('SKIP') ? 0 : 1)
        }
      }
    })
  }
}

/** Photos + stacks d'édition, dans l'ordre demandé. */
function photosWithStacks(photoIds: number[]): Array<CollageItem & MovieItem> {
  const db = getDb()
  const getPhoto = db.prepare('SELECT filepath, media_type FROM photos WHERE id = ?')
  const getStack = db.prepare('SELECT current_stack FROM edits WHERE photo_id = ?')
  const items: Array<CollageItem & MovieItem> = []
  for (const id of photoIds) {
    const p = getPhoto.get(id) as { filepath: string; media_type: string } | undefined
    if (!p) continue
    const e = getStack.get(id) as { current_stack: string } | undefined
    items.push({
      filepath: p.filepath,
      stack: parseStack(e?.current_stack ?? '{}'),
      isVideo: p.media_type === 'video'
    })
  }
  return items
}

function registerIpc(): void {
  ipcMain.handle('scanRoots:list', () =>
    getDb().prepare('SELECT id, path, mode FROM scan_roots').all()
  )
  ipcMain.handle('scanRoots:add', (_e, { path, mode = 'watch' }) => {
    const r = getDb()
      .prepare('INSERT INTO scan_roots (path, mode) VALUES (?, ?) RETURNING id')
      .get(path, mode) as { id: number }
    startWatchers(mainWindow)
    return r
  })
  ipcMain.handle('scanRoots:remove', (_e, { id }) => {
    getDb().prepare('DELETE FROM scan_roots WHERE id = ?').run(id)
    startWatchers(mainWindow)
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
  ipcMain.handle('scanRoots:setMode', (_e, { id, mode }) => {
    getDb().prepare('UPDATE scan_roots SET mode = ? WHERE id = ?').run(mode, id)
    startWatchers(mainWindow)
  })
  ipcMain.handle('library:relocate', (_e, { newRoot }) => relocateLibrary(mainWindow, newRoot))
  ipcMain.handle('photos:setHidden', (_e, { photoIds, hidden }) => {
    if (!hidden && !isUnlocked()) return { ok: false, error: 'verrouillé' }
    const db = getDb()
    const stmt = db.prepare('UPDATE photos SET is_hidden = ? WHERE id = ?')
    const tx = db.transaction((ids: number[]) => {
      for (const id of ids) stmt.run(hidden ? 1 : 0, id)
    })
    tx(photoIds)
    return { ok: true }
  })
  ipcMain.handle('photos:hidden', () => {
    if (!isUnlocked()) return []
    return getDb()
      .prepare(`SELECT * FROM photos WHERE is_hidden = 1 AND status = 'active' ORDER BY taken_at DESC`)
      .all()
  })
  ipcMain.handle('privacy:status', () => privacyStatus())
  ipcMain.handle('privacy:setPassword', (_e, { password }) => setPassword(password))
  ipcMain.handle('privacy:unlock', (_e, { password }) => ({ ok: unlock(password) }))
  ipcMain.handle('privacy:lock', () => lock())
  ipcMain.handle('export:batch', (_e, opts) => batchExport(mainWindow, opts))
  ipcMain.handle('export:metadata', async (_e, { photoIds, destFile }) =>
    exportMetadataCsv(photoIds, destFile)
  )
  ipcMain.handle('photos:print', (_e, { photoIds, perPage }) => printPhotos(photoIds, perPage))
  ipcMain.handle('share:email', (_e, { photoIds }) => emailShare(mainWindow, photoIds))
  ipcMain.handle('duplicates:list', () => {
    const db = getDb()
    const hashes = db
      .prepare(
        `SELECT hash_xxh3 AS hash FROM photos
         WHERE status = 'active' AND hash_xxh3 != ''
         GROUP BY hash_xxh3 HAVING COUNT(*) > 1`
      )
      .all() as { hash: string }[]
    const byHash = db.prepare(
      `SELECT * FROM photos WHERE hash_xxh3 = ? AND status = 'active' ORDER BY filepath`
    )
    return hashes.map((h) => ({ hash: h.hash, photos: byHash.all(h.hash) }))
  })
  ipcMain.handle('duplicates:merge', (_e, { keepId, removeIds }) => {
    const db = getDb()
    const tx = db.transaction((ids: number[]) => {
      for (const rid of ids) {
        // Fusion des références : albums, tags, visages pointent vers la photo gardée
        db.prepare(
          `INSERT OR IGNORE INTO album_items (album_id, photo_id, position, added_at)
           SELECT album_id, ?, position, added_at FROM album_items WHERE photo_id = ?`
        ).run(keepId, rid)
        db.prepare('DELETE FROM album_items WHERE photo_id = ?').run(rid)
        db.prepare(
          `INSERT OR IGNORE INTO photo_tags (photo_id, tag_id)
           SELECT ?, tag_id FROM photo_tags WHERE photo_id = ?`
        ).run(keepId, rid)
        db.prepare('DELETE FROM photo_tags WHERE photo_id = ?').run(rid)
        db.prepare('UPDATE faces SET photo_id = ? WHERE photo_id = ?').run(keepId, rid)
        // La meilleure note/favori survit
        db.prepare(
          `UPDATE photos SET
             rating = MAX(rating, (SELECT rating FROM photos WHERE id = ?)),
             is_favorite = MAX(is_favorite, (SELECT is_favorite FROM photos WHERE id = ?))
           WHERE id = ?`
        ).run(rid, rid, keepId)
        db.prepare(`UPDATE photos SET status = 'trashed' WHERE id = ?`).run(rid)
      }
    })
    tx(removeIds)
  })
  ipcMain.handle('import:run', async (_e, { sourceDir, destDir }) => {
    const stats = await importFromDevice(mainWindow, sourceDir, destDir)
    startWatchers(mainWindow) // la nouvelle racine est surveillée
    return stats
  })
  ipcMain.handle('persons:list', () =>
    getDb()
      .prepare(
        `SELECT pe.id, pe.name, pe.face_count,
                f.photo_id AS samplePhotoId, f.bbox_x, f.bbox_y, f.bbox_w, f.bbox_h
         FROM persons pe
         LEFT JOIN faces f ON f.id = (
           SELECT id FROM faces WHERE person_id = pe.id ORDER BY confidence DESC LIMIT 1
         )
         WHERE pe.is_ignored = 0 AND pe.face_count > 0
         ORDER BY pe.name IS NULL, pe.name COLLATE NOCASE, pe.face_count DESC`
      )
      .all()
  )
  ipcMain.handle('persons:rename', (_e, { personId, name }) => {
    getDb().prepare('UPDATE persons SET name = ? WHERE id = ?').run(name.trim() || null, personId)
  })
  ipcMain.handle('photos:byPerson', (_e, { personId, offset, limit }) =>
    getDb()
      .prepare(
        `SELECT DISTINCT p.* FROM photos p
         JOIN faces f ON f.photo_id = p.id
         WHERE f.person_id = ? AND p.status = 'active' AND p.is_hidden = 0
         ORDER BY p.taken_at DESC LIMIT ? OFFSET ?`
      )
      .all(personId, limit, offset)
  )
  ipcMain.handle('persons:merge', (_e, { targetId, sourceIds }) => {
    mergePersons(getDb(), targetId, sourceIds)
    mainWindow.webContents.send('persons:changed', {})
  })
  ipcMain.handle('faces:byPerson', (_e, { personId }) => facesByPerson(getDb(), personId))
  ipcMain.handle('faces:confirm', (_e, { faceIds }) => {
    confirmFaces(getDb(), faceIds)
  })
  ipcMain.handle('faces:split', (_e, { faceIds }) => {
    const newPersonId = splitFaces(getDb(), faceIds)
    mainWindow.webContents.send('persons:changed', {})
    return { newPersonId }
  })
  ipcMain.handle('faces:reject', (_e, { faceIds }) => {
    const newPersonId = rejectFaces(getDb(), faceIds)
    mainWindow.webContents.send('persons:changed', {})
    return { newPersonId }
  })
  ipcMain.handle('faces:scan', () => {
    if (isFaceScanRunning()) return { started: false }
    void startFaceScan(mainWindow)
    return { started: true }
  })
  ipcMain.handle('photos:withGps', () =>
    getDb()
      .prepare(
        `SELECT id, filename, gps_lat, gps_lon FROM photos
         WHERE gps_lat IS NOT NULL AND gps_lon IS NOT NULL
           AND status = 'active' AND is_hidden = 0`
      )
      .all()
  )
  ipcMain.handle('photos:setGps', (_e, { photoIds, lat, lon }) => {
    const db = getDb()
    const stmt = db.prepare(
      'UPDATE photos SET gps_lat = ?, gps_lon = ?, gps_manual = 1 WHERE id = ?'
    )
    const tx = db.transaction((ids: number[]) => {
      for (const id of ids) stmt.run(lat, lon, id)
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
  ipcMain.handle('dialog:pickFile', async (_e, { name, extensions }) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name, extensions }]
    })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('dialog:saveFile', async (_e, { defaultName, name, extensions }) => {
    const r = await dialog.showSaveDialog(mainWindow, {
      defaultPath: defaultName,
      filters: [{ name, extensions }]
    })
    return r.canceled || !r.filePath ? null : r.filePath
  })
  ipcMain.handle('create:collage', async (_e, { photoIds, layout, outFile }) => {
    const items = photosWithStacks(photoIds)
    return makeCollage(items, layout, outFile)
  })
  ipcMain.handle('create:movie', async (_e, { photoIds, durationSec, audioPaths, transition, outFile }) => {
    const items = photosWithStacks(photoIds)
    return makeMovie(items, {
      ffmpegPath: (ffmpegPath as unknown as string) ?? 'ffmpeg',
      durationSec,
      audioPaths,
      transition,
      outFile,
      onProgress: (done, total) => mainWindow.webContents.send('movie:progress', { done, total })
    })
  })
  ipcMain.handle('dialog:pickFiles', async (_e, { name, extensions }) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name, extensions }]
    })
    return r.canceled ? [] : r.filePaths
  })
  ipcMain.handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
}

app.whenReady().then(() => {
  initDb()
  registerThumbProtocol()
  registerFaceresProtocol()
  registerIpc()
  createWindow()
  startWatchers(mainWindow)

  // Mode test headless relocate : PICALIBRE_TEST_RELOCATE="nouvelleRacine"
  const testRelocate = process.env.PICALIBRE_TEST_RELOCATE
  if (testRelocate) {
    void relocateLibrary(mainWindow, testRelocate).then((stats) => {
      console.log('[test] RELOCATE', JSON.stringify(stats))
      app.quit()
    })
  }

  // Mode test headless import : PICALIBRE_TEST_IMPORT="source::dest"
  const testImport = process.env.PICALIBRE_TEST_IMPORT
  if (testImport) {
    const [src, dst] = testImport.split('::')
    void importFromDevice(mainWindow, src, dst).then((stats) => {
      console.log('[test] IMPORT', JSON.stringify(stats))
      setTimeout(() => app.quit(), 4000) // laisse le scan de la destination finir
    })
  }

  // Mode test headless (CI) : scanne un dossier, vérifie le pipeline, quitte.
  const testRoot = process.env.PICALIBRE_TEST_SCAN
  if (testRoot) {
    getDb().prepare('INSERT OR IGNORE INTO scan_roots (path) VALUES (?)').run(testRoot)
    startWatchers(mainWindow)
    startScan(mainWindow)
    const t0 = Date.now()
    const iv = setInterval(() => {
      const q = (sql: string): number => (getDb().prepare(sql).get() as { c: number }).c
      const photos = q('SELECT COUNT(*) c FROM photos')
      const thumbs = q('SELECT COUNT(*) c FROM thumbnails')
      const dims = q('SELECT COUNT(*) c FROM photos WHERE width IS NOT NULL')
      console.log(`[test] photos=${photos} thumbs=${thumbs} dims=${dims}`)
      if (photos > 0 && thumbs >= photos * 2 && dims === photos) {
        console.log(`[test] PIPELINE OK en ${Date.now() - t0} ms`)
        clearInterval(iv)
        if (!process.env.PICALIBRE_TEST_KEEPALIVE) app.quit()
      } else if (Date.now() - t0 > 60000) {
        console.error('[test] TIMEOUT pipeline')
        clearInterval(iv)
        app.exit(1)
      }
    }, 1500)
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
