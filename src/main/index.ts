import { app, BrowserWindow, ipcMain, dialog, protocol, net } from 'electron'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { writeFile, access } from 'node:fs/promises'
import sharp from 'sharp'
import { initDb, getDb } from './db'
import { getEditState, saveStack, undo, redo } from './services/edits'
import { initAutoUpdate, installUpdate } from './services/updater'
import { buildAppMenu } from './menu'
import { getConfigForUi, setConfig, testConnection, runWebSync } from './services/websync'
import { shutdownExiftool } from './services/exif'
import { startFaceScan, isFaceScanRunning, humanModelsPath } from './services/faces'
import { mergePersons, splitFaces, confirmFaces, rejectFaces, facesByPerson } from './services/faces/manage-core'
import { startWatchers } from './services/watcher'
import { importFromDevice, importFileList } from './services/importer'
import { relocateLibrary } from './services/relocate'
import { privacyStatus, setPassword, unlock, lock, isUnlocked } from './services/privacy'
import { batchExport, exportMetadataCsv, emailShare, setWallpaper } from './services/exporter'
import { printPhotos } from './services/printer'
import { makeCollage, CollageItem } from './services/collage'
import { makeMovie, MovieItem } from './services/movie'
import { getFfmpegPath } from './utils/ffmpeg'
import { parseStack } from '../shared/edit-engine'
import { renderEdited } from './services/render-sharp'
import { startScan } from './services/scanner'
import { thumbsCacheDir } from './services/pipeline'
import type { GridFilters, SortMode } from '../shared/ipc'

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

/**
 * thumb://library/{size}/{photoId} → fichier webp du cache.
 *
 * Correctifs:
 *  1. Cache-Control: no-store sur les 404 — sinon Chromium met en cache
 *     l'échec et ne redemande jamais l'image quand la miniature devient
 *     disponible (cause n°1 du bug "images qui ne s'affichent pas").
 *  2. Génération à la volée : si la miniature n'existe pas encore mais
 *     que le fichier source est connu, on la génère ici-même plutôt que
 *     d'attendre le thumbsPhase. Le pipeline de fond reste utile pour
 *     pré-générer en masse, mais l'utilisateur n'attend plus.
 *  3. Vérification d'existence du cache_path : si le fichier a été
 *     supprimé du cache disque mais que la ligne SQL est toujours là,
 *     on régénère.
 */
async function generateThumbOnTheFly(
  photoId: number,
  size: number,
  filepath: string,
  hash: string,
  mediaType: string
): Promise<string | null> {
  try {
    const cacheDir = thumbsCacheDir()
    const cachePath = join(cacheDir, hash.slice(0, 2), `${hash}_${size}.webp`)
    try {
      await access(cachePath)
      // Le fichier existe déjà sur disque, mais la ligne SQL manquait — on l'insère
      getDb()
        .prepare(
          `INSERT OR REPLACE INTO thumbnails (photo_id, size, cache_path) VALUES (?, ?, ?)`
        )
        .run(photoId, size, cachePath)
      return cachePath
    } catch {
      // Fichier absent du disque → on le génère
    }

    const { mkdir } = await import('node:fs/promises')
    const { dirname } = await import('node:path')
    await mkdir(dirname(cachePath), { recursive: true })

    if (mediaType === 'video') {
      // Pour les vidéos, on ne peut pas générer ici sans ffmpeg — on laisse
      // le pipeline de fond le faire. Retourne 404 soft.
      return null
    }

    await sharp(filepath, { failOn: 'none' })
      .rotate()
      .resize(size, size, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toFile(cachePath)

    getDb()
      .prepare(
        `INSERT OR REPLACE INTO thumbnails (photo_id, size, cache_path) VALUES (?, ?, ?)`
      )
      .run(photoId, size, cachePath)

    // Si on génère du 256, on en profite pour mettre à jour width/height
    if (size === 256) {
      const meta = await sharp(filepath).metadata()
      getDb()
        .prepare(
          `UPDATE photos SET width = COALESCE(?, width), height = COALESCE(?, height) WHERE id = ?`
        )
        .run(meta.width ?? null, meta.height ?? null, photoId)
    }
    return cachePath
  } catch (err) {
    console.error('[thumb:gen]', photoId, (err as Error).message)
    return null
  }
}

/** Cache mémoire des chemins de miniatures — évite une requête SQL + un stat disque
 *  par vignette affichée. Les chemins sont adressés par hash de contenu, donc stables. */
const thumbPathCache = new Map<string, string>()
const THUMB_CACHE_MAX = 30000

function registerThumbProtocol(): void {
  protocol.handle('thumb', async (request) => {
    const parts = new URL(request.url).pathname.split('/').filter(Boolean)
    // Taille spéciale 'orig' : sert le fichier original (zoom 100 % de la visionneuse)
    if (parts[0] === 'orig') {
      const pid = parseInt(parts[1], 10)
      const ph = getDb().prepare('SELECT filepath FROM photos WHERE id = ?').get(pid) as
        | { filepath: string }
        | undefined
      if (!ph) return new Response('not found', { status: 404, headers: { 'Cache-Control': 'no-store' } })
      return net.fetch(pathToFileURL(ph.filepath).toString())
    }
    const size = parseInt(parts[0], 10)
    const photoId = parseInt(parts[1], 10)
    if (!Number.isFinite(size) || !Number.isFinite(photoId) || size <= 0 || photoId <= 0) {
      return new Response('bad request', {
        status: 400,
        headers: { 'Cache-Control': 'no-store' }
      })
    }

    // Chemin rapide : cache mémoire (ni SQL, ni stat — le fichier est immuable par hash)
    const cacheKey = `${photoId}:${size}`
    let cachePath = thumbPathCache.get(cacheKey)

    if (!cachePath) {
      const row = getDb()
        .prepare('SELECT cache_path FROM thumbnails WHERE photo_id = ? AND size = ?')
        .get(photoId, size) as { cache_path: string } | undefined
      cachePath = row?.cache_path
      // Vérification disque uniquement au premier accès
      if (cachePath) {
        try {
          await access(cachePath)
          if (thumbPathCache.size >= THUMB_CACHE_MAX) thumbPathCache.clear()
          thumbPathCache.set(cacheKey, cachePath)
        } catch {
          cachePath = undefined
        }
      }
    }

    // Génération à la volée si manquant
    if (!cachePath) {
      const photo = getDb()
        .prepare('SELECT filepath, hash_xxh3, media_type FROM photos WHERE id = ?')
        .get(photoId) as
        | { filepath: string; hash_xxh3: string; media_type: string }
        | undefined

      if (!photo || !photo.hash_xxh3) {
        // Photo inconnue ou hash pas encore calculé (scan en cours) :
        // 404 NON caché pour que le renderer puisse réessayer
        return new Response('not yet', {
          status: 404,
          headers: { 'Cache-Control': 'no-store' }
        })
      }

      cachePath =
        (await generateThumbOnTheFly(
          photoId,
          size,
          photo.filepath,
          photo.hash_xxh3,
          photo.media_type
        )) ?? undefined

      if (!cachePath) {
        return new Response('not found', {
          status: 404,
          headers: { 'Cache-Control': 'no-store' }
        })
      }
    }

    const resp = await net.fetch(pathToFileURL(cachePath).toString())
    // Réinjecte un Cache-Control raisonnable sur le succès
    return new Response(resp.body, {
      status: resp.status,
      headers: {
        'Content-Type': resp.headers.get('Content-Type') ?? 'image/webp',
        // Adressé par hash de contenu (v= dans l'URL) : cache navigateur permanent.
        // Re-scroller la grille ne déclenche plus AUCUNE requête.
        'Cache-Control': 'public, max-age=31536000, immutable'
      }
    })
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

/** Colonnes nécessaires à la grille — ~2,5× moins d'octets IPC que SELECT *.
 *  Les métadonnées complètes passent par photos:details (panneau d'infos). */
const GRID_COLS =
  'id, folder_id, filename, filepath, media_type, hash_xxh3, file_size, file_mtime, ' +
  'width, height, duration_ms, taken_at, gps_lat, gps_lon, rating, is_favorite, caption, status'

const GRID_COLS_P = GRID_COLS.split(', ').map((c) => 'p.' + c).join(', ')

/**
 * Construit la clause SQL WHERE supplémentaire pour les filtres minStars et
 * typeFilter. Retourne un objet avec le fragment SQL (sans le mot-clé WHERE)
 * et les paramètres bind correspondants.
 *
 * Les index partiels idx_photos_grid_folder et idx_photos_grid_timeline
 * filtrent déjà status='active' AND is_hidden=0. Les conditions minStars et
 * typeFilter sont ajoutées après ces conditions existantes.
 */
function buildFilterClauses(filters: GridFilters): { sql: string; params: (string | number)[] } {
  const conditions: string[] = []
  const params: (string | number)[] = []

  if (filters.minStars && filters.minStars > 0) {
    conditions.push('rating >= ?')
    params.push(filters.minStars)
  }

  if (filters.typeFilter && filters.typeFilter !== 'all') {
    conditions.push('media_type = ?')
    params.push(filters.typeFilter)
  }

  if (conditions.length === 0) return { sql: '', params: [] }

  return { sql: ' AND ' + conditions.join(' AND '), params }
}

/**
 * Construit la clause ORDER BY SQL pour le mode de tri demandé.
 * Déporte le tri du renderer (Array.sort en JS sur 10k photos) vers SQLite
 * qui utilise les index partiels (idx_photos_grid_timeline sur taken_at DESC).
 *
 * @param sortMode Mode de tri (défaut: 'date_desc')
 * @param prefix   Préfixe de colonne pour les tables aliasées (ex: 'p.')
 */
function buildOrderBy(sortMode: SortMode | undefined, prefix = ''): string {
  const col = (name: string): string => prefix + name
  switch (sortMode) {
    case 'date_asc':
      return `ORDER BY ${col('taken_at')} IS NULL, ${col('taken_at')} ASC, ${col('file_mtime')} ASC`
    case 'name':
      return `ORDER BY ${col('filename')} COLLATE NOCASE ASC`
    case 'rating':
      return `ORDER BY ${col('rating')} DESC, ${col('taken_at')} DESC`
    // date_desc (défaut) — même ordre que l'index partiel idx_photos_grid_timeline
    default:
      return `ORDER BY ${col('taken_at')} IS NULL, ${col('taken_at')} DESC, ${col('file_mtime')} DESC`
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
  ipcMain.handle('photos:byFolder', (_e, { folderId, offset, limit, minStars, typeFilter, sortMode }) => {
    const fc = buildFilterClauses({ minStars, typeFilter })
    const orderBy = buildOrderBy(sortMode)
    return getDb()
      .prepare(
        `SELECT ${GRID_COLS} FROM photos WHERE folder_id = ? AND status = 'active' AND is_hidden = 0${fc.sql}
         ${orderBy} LIMIT ? OFFSET ?`
      )
      .all(folderId, ...fc.params, limit, offset)
  })
  ipcMain.handle('context:photoMenu', (_e, { photoId, selectedCount }) => {
    const { Menu, shell } = require('electron') as typeof import('electron')
    const sendAction = (action: string): void =>
      mainWindow.webContents.send('photo:action', { action, photoId })
    const notify = (): void => mainWindow.webContents.send('library:changed', { folderIds: [] })
    const menu = Menu.buildFromTemplate([
      { label: '👁 Ouvrir', click: () => sendAction('open') },
      { label: '✎ Éditer', click: () => sendAction('edit') },
      { type: 'separator' },
      {
        label: 'Noter',
        submenu: [0, 1, 2, 3, 4, 5].map((n) => ({
          label: n === 0 ? 'Aucune note' : '★'.repeat(n),
          click: () => {
            getDb().prepare('UPDATE photos SET rating = ? WHERE id = ?').run(n, photoId)
            notify()
          }
        }))
      },
      { label: '🏷 Taguer…', click: () => sendAction('tagFocus') },
      { type: 'separator' },
      {
        label: selectedCount > 1 ? `🙈 Masquer la sélection (${selectedCount})` : '🙈 Masquer',
        click: () => sendAction('hide')
      },
      {
        label: '📂 Afficher dans le dossier',
        click: () => {
          const ph = getDb().prepare('SELECT filepath FROM photos WHERE id = ?').get(photoId) as
            | { filepath: string }
            | undefined
          if (ph) shell.showItemInFolder(ph.filepath)
        }
      },
      { type: 'separator' },
      {
        label: "🖥️ Définir comme fond d'écran",
        click: () => {
          void setWallpaper(photoId).then((r) => {
            if (!r.ok) {
              dialog.showErrorBox('Fond d\'écran', `Échec: ${r.error ?? 'erreur inconnue'}`)
            }
          })
        }
      }
    ])
    menu.popup({ window: mainWindow })
  })
  ipcMain.handle('photos:setRating', (_e, { photoId, rating }) => {
    getDb().prepare('UPDATE photos SET rating = ? WHERE id = ?').run(rating, photoId)
  })
  ipcMain.handle('photos:timeline', (_e, { offset, limit, minStars, typeFilter, sortMode }) => {
    const fc = buildFilterClauses({ minStars, typeFilter })
    const orderBy = buildOrderBy(sortMode)
    return getDb()
      .prepare(
        `SELECT ${GRID_COLS} FROM photos WHERE status = 'active' AND is_hidden = 0${fc.sql}
         ${orderBy} LIMIT ? OFFSET ?`
      )
      .all(...fc.params, limit, offset)
  })
  ipcMain.handle('photos:details', (_e, { photoId }) => {
    const db = getDb()
    const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(photoId)
    const tags = (
      db
        .prepare(
          `SELECT t.name FROM tags t JOIN photo_tags pt ON pt.tag_id = t.id
           WHERE pt.photo_id = ? ORDER BY t.name COLLATE NOCASE`
        )
        .all(photoId) as { name: string }[]
    ).map((r) => r.name)
    const faces = (
      db.prepare('SELECT COUNT(*) c FROM faces WHERE photo_id = ?').get(photoId) as { c: number }
    ).c
    const albums = (
      db
        .prepare(
          `SELECT a.name FROM albums a JOIN album_items ai ON ai.album_id = a.id
           WHERE ai.photo_id = ? ORDER BY a.name COLLATE NOCASE`
        )
        .all(photoId) as { name: string }[]
    ).map((r) => r.name)
    return { photo, tags, faces, albums }
  })
  ipcMain.handle('photos:byAlbum', (_e, { albumId, offset, limit, minStars, typeFilter, sortMode }) => {
    const fc = buildFilterClauses({ minStars, typeFilter })
    const orderBy = buildOrderBy(sortMode, 'p.')
    return getDb()
      .prepare(
        `SELECT ${GRID_COLS_P} FROM photos p
         JOIN album_items ai ON ai.photo_id = p.id
         WHERE ai.album_id = ? AND p.status = 'active' AND p.is_hidden = 0${fc.sql}
         ${orderBy} LIMIT ? OFFSET ?`
      )
      .all(albumId, ...fc.params, limit, offset)
  })
  ipcMain.handle('photos:search', (_e, { query, offset, limit, minStars, typeFilter, sortMode }) => {
    // FTS5 MATCH sur photos_fts (caption, filename, tags, persons, folder)
    // prefix*: permet de chercher "vac" → "vacances"
    // 'folder' permet de chercher par nom de dossier (ex: "vacances 2023")
    const ftsQuery = query.trim().split(/\s+/).map((t: string) => `"${t.replace(/"/g, '""')}"*`).join(' ')
    const fc = buildFilterClauses({ minStars, typeFilter })
    // Pour la recherche, le tri par pertinence FTS (rank) reste prioritaire
    // sauf si l'utilisateur a explicitement demandé un autre tri.
    const orderBy =
      sortMode && sortMode !== 'date_desc'
        ? buildOrderBy(sortMode, 'p.')
        : 'ORDER BY rank, p.taken_at DESC'
    return getDb()
      .prepare(
        `SELECT DISTINCT ${GRID_COLS_P} FROM photos p
         JOIN photos_fts ON photos_fts.rowid = p.id
         WHERE p.status = 'active' AND p.is_hidden = 0
           AND photos_fts MATCH ?${fc.sql}
         ${orderBy} LIMIT ? OFFSET ?`
      )
      .all(ftsQuery, ...fc.params, limit, offset)
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
      .prepare(`SELECT ${GRID_COLS} FROM photos WHERE is_hidden = 1 AND status = 'active' ORDER BY taken_at DESC`)
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
  ipcMain.handle('import:dropped', async (_e, { paths }) => {
    const { statSync } = await import('node:fs')
    const dirs: string[] = []
    const files: string[] = []
    for (const p of paths) {
      try {
        statSync(p).isDirectory() ? dirs.push(p) : files.push(p)
      } catch {
        /* chemin disparu */
      }
    }
    let addedRoots = 0
    for (const d of dirs) {
      const r = getDb().prepare('INSERT OR IGNORE INTO scan_roots (path) VALUES (?)').run(d)
      if (r.changes > 0) addedRoots++
    }
    let imported: { copied: number; skippedDuplicates: number; errors: number } | null = null
    if (files.length > 0) {
      const pick = await dialog.showOpenDialog(mainWindow, {
        title: 'Où importer ces fichiers ?',
        properties: ['openDirectory', 'createDirectory']
      })
      if (!pick.canceled && pick.filePaths[0]) {
        const stats = await importFileList(mainWindow, files, pick.filePaths[0])
        getDb().prepare('INSERT OR IGNORE INTO scan_roots (path) VALUES (?)').run(pick.filePaths[0])
        imported = stats
      }
    }
    if (addedRoots > 0 || imported) startScan(mainWindow)
    return { addedRoots, imported }
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
  ipcMain.handle('photos:byPerson', (_e, { personId, offset, limit, minStars, typeFilter, sortMode }) => {
    const fc = buildFilterClauses({ minStars, typeFilter })
    const orderBy = buildOrderBy(sortMode, 'p.')
    return getDb()
      .prepare(
        `SELECT DISTINCT ${GRID_COLS_P} FROM photos p
         JOIN faces f ON f.photo_id = p.id
         WHERE f.person_id = ? AND p.status = 'active' AND p.is_hidden = 0${fc.sql}
         ${orderBy} LIMIT ? OFFSET ?`
      )
      .all(personId, ...fc.params, limit, offset)
  })
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
  ipcMain.handle('create:collage', async (_e, { photoIds, layout, outFile, format }) => {
    const items = photosWithStacks(photoIds)
    return makeCollage(items, layout, outFile, format ?? 'jpeg')
  })
  ipcMain.handle('create:movie', async (_e, { photoIds, durationSec, audioPaths, transition, outFile }) => {
    const items = photosWithStacks(photoIds)
    return makeMovie(items, {
      ffmpegPath: await getFfmpegPath(),
      durationSec,
      audioPaths,
      transition,
      outFile,
      onProgress: (done, total) => mainWindow.webContents.send('movie:progress', { done, total })
    })
  })
  ipcMain.handle('update:install', () => installUpdate())
  ipcMain.handle('websync:getConfig', () => getConfigForUi())
  ipcMain.handle('websync:setConfig', (_e, cfg) => setConfig(cfg))
  ipcMain.handle('websync:test', (_e, cfg) => testConnection(cfg))
  ipcMain.handle('websync:run', () =>
    runWebSync(mainWindow, (p) => mainWindow.webContents.send('websync:progress', p))
  )
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


/** Sortie des modes test CI : ferme exiftool (process enfant persistant) puis force la fin. */
function exitTest(code: number): void {
  void shutdownExiftool()
    .catch(() => {})
    .then(() => app.exit(code))
  setTimeout(() => app.exit(code), 3000) // filet de sécurité
}

app.whenReady().then(() => {
  initDb()
  registerThumbProtocol()
  registerFaceresProtocol()
  registerIpc()
  createWindow()
  buildAppMenu(mainWindow)
  startWatchers(mainWindow)
  initAutoUpdate(mainWindow)

  // Mode test headless relocate : PICALIBRE_TEST_RELOCATE="nouvelleRacine"
  const testRelocate = process.env.PICALIBRE_TEST_RELOCATE
  if (testRelocate) {
    void relocateLibrary(mainWindow, testRelocate).then((stats) => {
      console.log('[test] RELOCATE', JSON.stringify(stats))
      exitTest(0)
    })
  }

  // Mode test headless import : PICALIBRE_TEST_IMPORT="source::dest"
  const testImport = process.env.PICALIBRE_TEST_IMPORT
  if (testImport) {
    const [src, dst] = testImport.split('::')
    void importFromDevice(mainWindow, src, dst).then((stats) => {
      console.log('[test] IMPORT', JSON.stringify(stats))
      setTimeout(() => exitTest(0), 4000) // laisse le scan de la destination finir
    })
  }

  // Banc de performance : 50 000 photos synthétiques, mesures des chemins chauds.
  if (process.env.PICALIBRE_TEST_BENCH) {
    const db = getDb()
    const t = (fn: () => void): number => {
      const t0 = performance.now()
      fn()
      return Math.round((performance.now() - t0) * 10) / 10
    }
    // Seed
    db.prepare("INSERT OR IGNORE INTO folders (id, path) VALUES (1, '/bench')").run()
    const ins = db.prepare(
      `INSERT INTO photos (folder_id, filename, filepath, hash_xxh3, file_size, file_mtime, taken_at, rating)
       VALUES (1, ?, ?, ?, 1000, ?, ?, ?)`
    )
    const insThumb = db.prepare(
      'INSERT OR IGNORE INTO thumbnails (photo_id, size, cache_path) VALUES (?, 256, ?)'
    )
    const seedMs = t(() =>
      db.transaction(() => {
        for (let i = 0; i < 50000; i++) {
          const r = ins.run(`b${i}.jpg`, `/bench/b${i}.jpg`, `h${i}`, 1700000000 + i, 1700000000 + i, i % 6)
          insThumb.run(r.lastInsertRowid, `/bench/cache/h${i}_256.webp`)
        }
      })()
    )
    // 1. Vue : SELECT * vs colonnes de grille (10 000 lignes)
    const wide = t(() => db.prepare(`SELECT * FROM photos WHERE folder_id = 1 AND status='active' AND is_hidden=0 ORDER BY taken_at DESC LIMIT 10000`).all())
    const slim = t(() => db.prepare(`SELECT ${GRID_COLS} FROM photos WHERE folder_id = 1 AND status='active' AND is_hidden=0 ORDER BY taken_at DESC LIMIT 10000`).all())
    const wideBytes = JSON.stringify(db.prepare(`SELECT * FROM photos LIMIT 1000`).all()).length
    const slimBytes = JSON.stringify(db.prepare(`SELECT ${GRID_COLS} FROM photos LIMIT 1000`).all()).length
    // 2. Miniatures : requête SQL par vignette vs cache mémoire
    const lookup = db.prepare('SELECT cache_path FROM thumbnails WHERE photo_id = ? AND size = 256')
    const sqlPer2000 = t(() => { for (let i = 1; i <= 2000; i++) lookup.get(i) })
    const mem = new Map<number, string>()
    for (let i = 1; i <= 2000; i++) mem.set(i, (lookup.get(i) as { cache_path: string }).cache_path)
    const memPer2000 = t(() => { for (let i = 1; i <= 2000; i++) mem.get(i) })
    console.log('[bench] seed 50k:', seedMs, 'ms')
    console.log('[bench] vue 10k lignes — SELECT *:', wide, 'ms | colonnes grille:', slim, 'ms')
    console.log('[bench] payload IPC (1000 lignes) —', wideBytes, '→', slimBytes, `octets (-${Math.round((1 - slimBytes / wideBytes) * 100)}%)`)
    console.log('[bench] 2000 vignettes — SQL:', sqlPer2000, 'ms | cache mémoire:', memPer2000, 'ms')
    console.log('[bench] plan folder:', JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN SELECT ${GRID_COLS} FROM photos WHERE folder_id=1 AND status='active' AND is_hidden=0 ORDER BY taken_at DESC LIMIT 100`).all()))
    exitTest(0)
  }

  // Mode test synchro web : configure + synchronise vers un serveur cible, quitte.
  // Format : "http://host:port|token" — utilisé par la CI pour valider le
  // cycle complet desktop → picalibre-web sans intervention manuelle.
  if (process.env.PICALIBRE_TEST_WEBSYNC) {
    const [url, token] = process.env.PICALIBRE_TEST_WEBSYNC.split('|')
    setConfig({ url, token })
    runWebSync(mainWindow, (p) => console.log('[websync-test]', JSON.stringify(p)))
      .then(() => exitTest(0))
      .catch((err) => {
        console.error('[websync-test] erreur:', err.message)
        exitTest(1)
      })
  }

  // Mode test menu : vérifie la structure du menu applicatif puis quitte.
  if (process.env.PICALIBRE_TEST_MENU) {
    const { Menu } = require('electron')
    const m = Menu.getApplicationMenu()
    const labels = m ? m.items.map((i: any) => i.label) : []
    const aide = m?.items.find((i: any) => i.label === 'Aide')
    const aideItems = aide ? (aide as any).submenu.items.filter((x: any) => x.type !== 'separator').map((x: any) => x.label) : []
    console.log('[menu] barres:', JSON.stringify(labels))
    console.log('[menu] aide:', JSON.stringify(aideItems))
    console.log('[menu]', aideItems.length >= 5 ? 'OK' : 'VIDE')
    exitTest(aideItems.length >= 5 ? 0 : 1)
  }

  // Mode capture : scanne, sélectionne le 1er dossier, capture la fenêtre en PNG, quitte.
  const shotDir = process.env.PICALIBRE_TEST_SCREENSHOT
  if (shotDir) {
    getDb().prepare('INSERT OR IGNORE INTO scan_roots (path) VALUES (?)').run(shotDir)
    startScan(mainWindow)
    setTimeout(async () => {
      // Sélectionner le premier dossier dans l'UI
      await mainWindow.webContents.executeJavaScript(
        `(() => { const el = [...document.querySelectorAll('aside div')].find(d => d.textContent.includes('📁')); if (el) el.click(); })()`
      )
      // Double-clic sur la 1re vignette → capture de la LIGHTBOX
      setTimeout(() => {
        void mainWindow.webContents.executeJavaScript(
          `(() => { const im = document.querySelector('main figure img'); if (im) im.click() })()`
        )
      }, 3000)
      setTimeout(async () => {
        const probe = await mainWindow.webContents.executeJavaScript(
        `(() => {
          const headers = [...document.querySelectorAll('main span')].filter(e => e.style.textTransform === 'capitalize' && e.style.fontWeight === '600').map(e => e.textContent)
          const pinned = [...document.querySelectorAll('div')].find(d => d.style.pointerEvents === 'none' && /^📅 /.test(d.textContent))
          const slider = !!document.querySelector('input[type=range][min="100"]')
          const sortSel = [...document.querySelectorAll('select')].some(x => x.textContent.includes('Plus récentes'))
          const fitBtn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Carré') || b.textContent.includes('Ratio'))
          const draggable = !!document.querySelector('main figure[draggable="true"]')
          const info = [...document.querySelectorAll('aside strong')].some(e => e.textContent.includes('Informations'))
          const lightbox = !!document.querySelector('video, [data-lightbox]') || [...document.querySelectorAll('button')].some(b => b.textContent.includes('Bibliothèque'))
          return { headers, pinned: pinned ? pinned.textContent : null, slider, info, lightbox, sortSel, fit: fitBtn ? fitBtn.textContent : null, draggable }
        })()`
      )
        console.log('[shot] probe:', JSON.stringify(probe))
        const img = await mainWindow.webContents.capturePage()
        const shotOut = join(app.getPath('temp'), 'picalibre-capture.png')
        await writeFile(shotOut, img.toPNG())
        console.log('[shot] capture écrite:', shotOut)
        exitTest(probe.lightbox ? 0 : 1)
      }, 6000)
    }, 9000)
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
        if (!process.env.PICALIBRE_TEST_KEEPALIVE) exitTest(0)
      } else if (Date.now() - t0 > 60000) {
        console.error('[test] TIMEOUT pipeline')
        clearInterval(iv)
        exitTest(1)
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
