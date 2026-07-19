import { app, BrowserWindow, ipcMain, dialog, protocol, net, shell } from 'electron'
import log from 'electron-log/main'

/**
 * Logs persistants (electron-log).
 * Écrit dans userData/logs/main.log (rotation automatique à 5 Mo, 3 fichiers
 * conservés). `Object.assign(console, log.functions)` redirige TOUS les
 * console.log/warn/error déjà présents dans le code (scanner, pipeline,
 * ffmpeg, updater…) vers ce fichier, sans avoir à toucher chaque appel un
 * par un — jusqu'ici, la seule façon de diagnostiquer un souci (ex. échec
 * silencieux de génération de miniature vidéo) était de relancer l'app
 * depuis un terminal. Consultable via Aide → Ouvrir le dossier des logs.
 */
log.initialize()
log.transports.file.maxSize = 5 * 1024 * 1024
log.transports.file.level = 'info'
Object.assign(console, log.functions)

import { pathToFileURL } from 'node:url'
import { join, dirname, basename, extname } from 'node:path'
import { spawn } from 'node:child_process'
import { writeFile, access, rename as fsRename, unlink as fsUnlink } from 'node:fs/promises'
import sharp from 'sharp'
import { resolveHeicInput } from '../shared/heic'
import { initDb, getDb } from './db'
import { getEditState, saveStack, undo, redo } from './services/edits'
import { initAutoUpdate, installUpdate } from './services/updater'
import { buildAppMenu } from './menu'
import { getConfigForUi, setConfig, testConnection, runWebSync } from './services/websync'
import { shutdownExiftool } from './services/exif'
import { detectTrips } from './services/trips'
import { startFaceScan, isFaceScanRunning, humanModelsPath } from './services/faces'
import { mergePersons, splitFaces, confirmFaces, rejectFaces, facesByPerson } from './services/faces/manage-core'
import { startWatchers, stopWatchers } from './services/watcher'
import { importFromDevice, importFileList } from './services/importer'
import { relocateLibrary } from './services/relocate'
import { privacyStatus, setPassword, unlock, lock, isUnlocked } from './services/privacy'
import { batchExport, batchExportAdvanced, exportMetadataCsv, emailShare, emailPhoto, blogExport, setWallpaper } from './services/exporter'
import { printPhotos } from './services/printer'
import { makeCollage, CollageItem } from './services/collage'
import { makeMovie, MovieItem } from './services/movie'
import { getFfmpegPath } from './utils/ffmpeg'
import {
  parseStack,
  computeAutoContrast,
  computeAutoColor,
  upsertOp,
  type EditStack
} from '../shared/edit-engine'
import { renderEdited } from './services/render-sharp'
import { startScan } from './services/scanner'
import { thumbsCacheDir } from './services/pipeline'
import type { GridFilters, SortMode, BoundingBox, ReverseGeocodeResult, MergeSnapshot } from '../shared/ipc'

app.setName('picalibre')

let mainWindow: BrowserWindow

// Doit être appelé AVANT app.whenReady()
protocol.registerSchemesAsPrivileged([
  // stream:true est indispensable pour que <video src="thumb://.../orig/{id}">
  // puisse lire un fichier vidéo — sans lui, Chromium refuse de traiter le
  // schéma comme une source média valide (échec silencieux, aucune erreur
  // visible côté renderer). Les miniatures webp (images) n'en ont pas besoin
  // mais le privilège est sans effet négatif pour elles.
  { scheme: 'thumb', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
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

    const input = await resolveHeicInput(filepath)
    await sharp(input, { failOn: 'none' })
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
      const meta = await sharp(input).metadata()
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
 *  par vignette affichée. Les chemins sont adressés par hash de contenu, donc stables.
 *
 *  Éviction LRU par batch plutôt que clear() intégral : à 30 000 entrées, vider tout
 *  le cache d'un coup provoque un « thundering herd » (toutes les vignettes suivantes
 *  retombent sur le chemin lent SQL + stat). À la place, on supprime les 5 000 plus
 *  anciennes via l'ordre d'insertion du Map (itéré dans l'ordre chronologique). */
const thumbPathCache = new Map<string, string>()
const THUMB_CACHE_MAX = 30000
const THUMB_CACHE_EVICT = 5000

function evictThumbCacheOldest(): void {
  // Map itère dans l'ordre d'insertion : les premières clés sont les plus
  // anciennes. On en supprime un batch fixe plutôt que tout vider.
  let removed = 0
  for (const key of thumbPathCache.keys()) {
    thumbPathCache.delete(key)
    if (++removed >= THUMB_CACHE_EVICT) break
  }
}

function registerThumbProtocol(): void {
  /**
   * Durcissement (audit) : tant que les photos masquées sont verrouillées,
   * le protocole thumb ne doit servir NI l'original NI les vignettes d'une
   * photo masquée — sinon un renderer compromis (ou une régression UI)
   * pourrait afficher le contenu protégé sans mot de passe. Coût quand
   * déverrouillé/pas de mot de passe : un micro-SELECT settings par
   * requête, négligeable devant la lecture disque du webp.
   */
  const isPhotoLocked = (photoId: number): boolean => {
    if (isUnlocked()) return false
    const row = getDb().prepare('SELECT is_hidden FROM photos WHERE id = ?').get(photoId) as
      | { is_hidden: number }
      | undefined
    return !!row?.is_hidden
  }
  protocol.handle('thumb', async (request) => {
    const parts = new URL(request.url).pathname.split('/').filter(Boolean)
    // Taille spéciale 'orig' : sert le fichier original (zoom 100 % de la visionneuse)
    if (parts[0] === 'orig') {
      const pid = parseInt(parts[1], 10)
      if (Number.isFinite(pid) && isPhotoLocked(pid)) {
        return new Response('locked', { status: 403, headers: { 'Cache-Control': 'no-store' } })
      }
      const ph = getDb()
        .prepare('SELECT filepath, media_type, hash_xxh3 FROM photos WHERE id = ?')
        .get(pid) as { filepath: string; media_type: string; hash_xxh3: string } | undefined
      if (!ph) return new Response('not found', { status: 404, headers: { 'Cache-Control': 'no-store' } })
      // Vidéo dans un codec non lisible nativement par Chromium (HEVC) :
      // un proxy H.264 a pu être généré en arrière-plan (pipeline.ts) —
      // le servir à la place de l'original s'il existe. L'original n'est
      // jamais modifié sur disque.
      let servePath = ph.filepath
      if (ph.media_type === 'video') {
        const proxyPath = join(
          thumbsCacheDir(),
          ph.hash_xxh3.slice(0, 2),
          `${ph.hash_xxh3}_proxy.mp4`
        )
        if (await access(proxyPath).then(() => true).catch(() => false)) {
          servePath = proxyPath
        }
      }
      // Transmet Range (et autres en-têtes pertinents) : sans ça, chaque
      // requête (y compris un seek vidéo) re-fetch le fichier entier depuis
      // le début — la barre de progression d'un <video> resterait cassée
      // (currentTime revient toujours à 0).
      return net.fetch(pathToFileURL(servePath).toString(), { headers: request.headers })
    }
    const size = parseInt(parts[0], 10)
    const photoId = parseInt(parts[1], 10)
    if (!Number.isFinite(size) || !Number.isFinite(photoId) || size <= 0 || photoId <= 0) {
      return new Response('bad request', {
        status: 400,
        headers: { 'Cache-Control': 'no-store' }
      })
    }
    if (isPhotoLocked(photoId)) {
      return new Response('locked', { status: 403, headers: { 'Cache-Control': 'no-store' } })
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
          if (thumbPathCache.size >= THUMB_CACHE_MAX) evictThumbCacheOldest()
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
      // Durcissement (audit) : sandbox Chromium actif. Le preload n'utilise
      // que contextBridge/ipcRenderer/webUtils, tous disponibles en preload
      // sandboxé — vérifié sur le bundle compilé (seul require: 'electron').
      // Les fenêtres secondaires (faces, impression) étaient déjà
      // sandboxées par défaut depuis Electron 20.
      sandbox: true
    }
  })

  /**
   * Durcissement (audit) : l'app est une SPA 100 % locale — aucune
   * navigation du webContents n'est jamais légitime après le chargement
   * initial. Sans ces gardes, glisser-déposer un fichier .html (ou une
   * URL) sur la fenêtre fait naviguer l'application entière hors de son
   * interface. Les liens externes (window.open / target=_blank) sont
   * délégués au navigateur système, et uniquement en https.
   */
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const isDev = !!process.env.ELECTRON_RENDERER_URL
    // En prod, seule la page de l'app elle-même (out/renderer) est un
    // référentiel légitime — pas « n'importe quel file:// », sinon le
    // drop d'un .html local resterait un vecteur de navigation.
    const allowed = isDev
      ? url.startsWith(process.env.ELECTRON_RENDERER_URL as string)
      : url.startsWith(pathToFileURL(join(__dirname, '../renderer')).toString())
    if (!allowed) e.preventDefault()
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
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
  const getPhoto = db.prepare(
    'SELECT filepath, media_type, trim_start_ms, trim_end_ms FROM photos WHERE id = ?'
  )
  const getStack = db.prepare('SELECT current_stack FROM edits WHERE photo_id = ?')
  const items: Array<CollageItem & MovieItem> = []
  for (const id of photoIds) {
    const p = getPhoto.get(id) as
      | { filepath: string; media_type: string; trim_start_ms: number | null; trim_end_ms: number | null }
      | undefined
    if (!p) continue
    const e = getStack.get(id) as { current_stack: string } | undefined
    items.push({
      filepath: p.filepath,
      stack: parseStack(e?.current_stack ?? '{}'),
      isVideo: p.media_type === 'video',
      trimStartMs: p.trim_start_ms,
      trimEndMs: p.trim_end_ms
    })
  }
  return items
}

/** Colonnes nécessaires à la grille — ~2,5× moins d'octets IPC que SELECT *.
 *  Les métadonnées complètes passent par photos:details (panneau d'infos). */
const GRID_COLS =
  'id, folder_id, filename, filepath, media_type, hash_xxh3, file_size, file_mtime, ' +
  'width, height, duration_ms, taken_at, gps_lat, gps_lon, rating, is_favorite, caption, status, ' +
  'trim_start_ms, trim_end_ms'

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
    getDb()
      .prepare('SELECT id, path, parent_id, is_hidden FROM folders WHERE is_hidden = 0 ORDER BY path')
      .all()
  )

  /**
   * Retirer un sous-dossier précis de la bibliothèque (contrairement à
   * scanRoots:remove, qui n'arrête que la SURVEILLANCE d'une racine sans
   * toucher aux photos déjà indexées) : les photos de CE dossier précis
   * passent en status='trashed' (récupérables, comme le reste du système
   * d'annulation de l'app), et le dossier est marqué is_hidden=1 pour ne
   * plus jamais être réintégré lors d'un futur scan de la racine parente
   * (voir upsertScannedBatch, qui saute désormais les dossiers exclus).
   * Les fichiers restent intacts sur le disque.
   */
  ipcMain.handle('folders:remove', (_e, { folderId }) => {
    const db = getDb()
    const photoIds = db
      .prepare("SELECT id FROM photos WHERE folder_id = ? AND status = 'active'")
      .all(folderId)
      .map((r) => (r as { id: number }).id)
    // Transaction englobante : sans elle, un crash entre le marquage du
    // dossier (is_hidden=1) et la mise à la corbeille des photos laisse la
    // base dans un état incohérent (dossier masqué mais photos actives).
    const tx = db.transaction((fid: number) => {
      db.prepare('UPDATE folders SET is_hidden = 1 WHERE id = ?').run(fid)
      db.prepare("UPDATE photos SET status = 'trashed' WHERE folder_id = ?").run(fid)
    })
    tx(folderId)
    return { photoIds }
  })

  ipcMain.handle('folders:undoRemove', (_e, { folderId, photoIds }) => {
    const db = getDb()
    // Transaction englobante : le rétablissement du dossier et celui des
    // photos doivent rester atomiques (sinon on pourrait voir un dossier
    // visible dont toutes les photos resteraient à la corbeille).
    const tx = db.transaction((fid: number, ids: number[]) => {
      db.prepare('UPDATE folders SET is_hidden = 0 WHERE id = ?').run(fid)
      if (ids.length > 0) {
        const placeholders = ids.map(() => '?').join(',')
        db.prepare(`UPDATE photos SET status = 'active' WHERE id IN (${placeholders})`).run(
          ...ids
        )
      }
    })
    tx(folderId, photoIds as number[])
  })

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
        label: selectedCount > 1 ? `🗑 Mettre la sélection à la corbeille (${selectedCount})` : '🗑 Mettre à la corbeille',
        click: () => sendAction('trash')
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
      },
      {
        label: "✉️ Envoyer par email",
        click: () => {
          void emailPhoto(photoId).then((r) => {
            if (!r.ok) {
              dialog.showErrorBox('Email', `Échec: ${r.error ?? 'erreur inconnue'}`)
            }
          })
        }
      },
      {
        label: "📝 Exporter vers blog",
        click: () => {
          void blogExport(photoId).then((r) => {
            if (!r.ok) {
              dialog.showErrorBox('Blog', `Échec: ${r.error ?? 'erreur inconnue'}`)
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
  ipcMain.handle('photos:hidden', (_e, page?: { offset: number; limit: number }) => {
    if (!isUnlocked()) return []
    // Paginé (audit) : même flux LIMIT/OFFSET que les autres vues — sans
    // payload (appels historiques/tests), tout est renvoyé comme avant.
    return getDb()
      .prepare(
        `SELECT ${GRID_COLS} FROM photos WHERE is_hidden = 1 AND status = 'active' ORDER BY taken_at DESC${page ? ` LIMIT ${Math.max(0, Math.floor(page.limit))} OFFSET ${Math.max(0, Math.floor(page.offset))}` : ''}`
      )
      .all()
  })

  /**
   * Corbeille (façon Picasa/Poubelle système) : "Mettre à la corbeille"
   * passe status='active' → 'trashed' — le fichier reste intact sur le
   * disque, la photo disparaît simplement de toutes les vues normales
   * (déjà garanti par les requêtes existantes filtrant status='active').
   * Réversible via photos:undoTrash (bandeau "↩ Annuler", même mécanisme
   * que les autres actions) OU depuis la vue Corbeille elle-même.
   * photos:deleteForever est la seule action qui touche réellement au
   * disque et à la base — irréversible, confirmation requise côté UI.
   */
  ipcMain.handle('photos:trash', (_e, { photoIds }: { photoIds: number[] }) => {
    const db = getDb()
    const stmt = db.prepare("UPDATE photos SET status = 'trashed' WHERE id = ? AND status = 'active'")
    const tx = db.transaction((ids: number[]) => {
      for (const id of ids) stmt.run(id)
    })
    tx(photoIds)
    return { ok: true }
  })
  ipcMain.handle('photos:undoTrash', (_e, { photoIds }: { photoIds: number[] }) => {
    const db = getDb()
    const stmt = db.prepare("UPDATE photos SET status = 'active' WHERE id = ? AND status = 'trashed'")
    const tx = db.transaction((ids: number[]) => {
      for (const id of ids) stmt.run(id)
    })
    tx(photoIds)
  })
  ipcMain.handle('photos:trashed', (_e, page?: { offset: number; limit: number }) =>
    getDb()
      .prepare(
        // Verrou de confidentialité : tant que les photos masquées sont
        // verrouillées, celles mises à la corbeille depuis la vue Masquées
        // ne doivent PAS apparaître ici — sinon la Corbeille devient un
        // contournement du mot de passe. Paginé comme les autres vues.
        `SELECT ${GRID_COLS} FROM photos WHERE status = 'trashed'${isUnlocked() ? '' : ' AND is_hidden = 0'} ORDER BY taken_at DESC${page ? ` LIMIT ${Math.max(0, Math.floor(page.limit))} OFFSET ${Math.max(0, Math.floor(page.offset))}` : ''}`
      )
      .all()
  )
  ipcMain.handle('photos:deleteForever', async (_e, { photoIds }: { photoIds: number[] }) => {
    const db = getDb()
    const rows = db
      .prepare(
        // Même défense en profondeur que photos:trashed : verrouillé, on ne
        // peut pas supprimer définitivement une photo masquée (l'UI ne peut
        // de toute façon pas la lister, mais un appel IPC direct non plus).
        `SELECT id, filepath, filename, hash_xxh3, media_type FROM photos
         WHERE id IN (${photoIds.map(() => '?').join(',') || 'NULL'}) AND status = 'trashed'${isUnlocked() ? '' : ' AND is_hidden = 0'}`
      )
      .all(...photoIds) as {
      id: number
      filepath: string
      filename: string
      hash_xxh3: string
      media_type: string
    }[]
    const errors: Array<{ id: number; filename: string; error: string }> = []
    let deleted = 0
    const del = db.prepare('DELETE FROM photos WHERE id = ?')
    const thumbRows = db.prepare('SELECT cache_path FROM thumbnails WHERE photo_id = ?')
    // Les suppressions de fichiers disque sont lentes et peuvent échouer :
    // on les fait hors transaction. On collecte les ids dont le fichier a
    // pu être supprimé (ou était déjà absent — ENOENT), puis on supprime
    // toutes les lignes SQL correspondantes dans une seule transaction.
    const toDelete: number[] = []
    for (const row of rows) {
      try {
        await fsUnlink(row.filepath)
      } catch (err) {
        // Fichier déjà absent du disque (déplacé/supprimé manuellement) :
        // on continue quand même à nettoyer la base, ce n'est pas bloquant.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          errors.push({ id: row.id, filename: row.filename, error: (err as Error).message })
          continue
        }
      }
      // Nettoyage du cache disque AVANT le DELETE (la cascade SQL supprime
      // les lignes thumbnails mais laisserait les .webp orphelins pour
      // toujours) : miniatures webp + éventuel proxy vidéo H.264.
      const caches = thumbRows.all(row.id) as { cache_path: string }[]
      for (const c of caches) {
        await fsUnlink(c.cache_path).catch(() => {})
      }
      if (row.media_type === 'video') {
        await fsUnlink(
          join(thumbsCacheDir(), row.hash_xxh3.slice(0, 2), `${row.hash_xxh3}_proxy.mp4`)
        ).catch(() => {})
      }
      // Purge du cache mémoire de résolution des miniatures (toutes tailles)
      for (const key of thumbPathCache.keys()) {
        if (key.startsWith(`${row.id}:`)) thumbPathCache.delete(key)
      }
      toDelete.push(row.id)
    }
    // Transaction englobante : un à un sans transaction, N photos = N commits
    // (fsync à chaque fois). Une seule transaction réduit drastiquement le
    // coût disque et garantit l'atomicité si l'app est interrompue.
    if (toDelete.length > 0) {
      const tx = db.transaction((ids: number[]) => {
        for (const id of ids) del.run(id)
      })
      tx(toDelete)
    }
    deleted = toDelete.length
    return { deleted, errors }
  })

  /**
   * Renommage en lot (façon Picasa) : {n} = compteur séquentiel (3 chiffres),
   * {name} = nom de fichier d'origine (sans extension), {date} = date de
   * prise de vue AAAA-MM-JJ si connue, sinon date de modification.
   * Le watcher est coupé pendant l'opération (sinon chaque renommage sur
   * disque déclenche un 'unlink'+'add' chokidar qui pourrait marquer la
   * photo 'missing' ou provoquer un rescan concurrent). La BDD est mise à
   * jour AVANT le renommage sur disque : si un rescan tardif survient quand
   * même après redémarrage du watcher, il ne trouvera rien d'incohérent.
   */
  ipcMain.handle('photos:batchRename', async (_e, { photoIds, pattern, startNumber }) => {
    await stopWatchers()
    const db = getDb()
    const get = db.prepare(
      'SELECT id, filepath, filename, taken_at, file_mtime FROM photos WHERE id = ?'
    )
    // Préparé hors boucle : le même statement est réutilisé pour chaque photo
    // (gain mesurable sur un batch de plusieurs centaines de renommages).
    const updatePath = db.prepare(
      'UPDATE photos SET filepath = ?, filename = ? WHERE id = ?'
    )
    const renamed: Array<{
      id: number
      oldPath: string
      oldFilename: string
      newPath: string
      newFilename: string
    }> = []
    const errors: Array<{ id: number; filename: string; error: string }> = []
    let n = startNumber
    for (const id of photoIds as number[]) {
      const row = get.get(id) as
        | { id: number; filepath: string; filename: string; taken_at: number | null; file_mtime: number }
        | undefined
      if (!row) continue
      const ext = extname(row.filepath)
      const base = basename(row.filepath, ext)
      const ts = (row.taken_at ?? row.file_mtime) * 1000
      const date = new Date(ts).toISOString().slice(0, 10)
      const counter = String(n).padStart(3, '0')
      const newFilename =
        (pattern as string)
          .replace(/\{n\}/g, counter)
          .replace(/\{name\}/g, base)
          .replace(/\{date\}/g, date) + ext
      // Sécurité : rejeter les path traversal (/, \, ..) dans le nouveau nom
      if (
        newFilename.includes('/') ||
        newFilename.includes('\\') ||
        newFilename.includes('..') ||
        newFilename.includes('\0')
      ) {
        errors.push({
          id,
          filename: row.filename,
          error: 'caractères interdits dans le motif de renommage (/, \\, ..)'
        })
        n++
        continue
      }
      const newPath = join(dirname(row.filepath), newFilename)
      n++
      if (newPath === row.filepath) continue
      try {
        await access(newPath)
        errors.push({ id, filename: row.filename, error: 'un fichier porte déjà ce nom' })
        continue
      } catch {
        /* n'existe pas encore — bon signe, on continue */
      }
      try {
        updatePath.run(newPath, newFilename, id)
        await fsRename(row.filepath, newPath)
        renamed.push({ id, oldPath: row.filepath, oldFilename: row.filename, newPath, newFilename })
      } catch (err) {
        // Rollback BDD si le renommage disque a échoué après la mise à jour
        updatePath.run(row.filepath, row.filename, id)
        errors.push({ id, filename: row.filename, error: (err as Error).message })
      }
    }
    startWatchers(mainWindow)
    return { renamed, errors }
  })

  ipcMain.handle('photos:undoBatchRename', async (_e, items) => {
    await stopWatchers()
    const db = getDb()
    // Préparé hors boucle (même raison que batchRename).
    const updatePath = db.prepare(
      'UPDATE photos SET filepath = ?, filename = ? WHERE id = ?'
    )
    for (const it of items as Array<{
      id: number
      oldPath: string
      oldFilename: string
      newPath: string
      newFilename: string
    }>) {
      try {
        updatePath.run(it.oldPath, it.oldFilename, it.id)
        await fsRename(it.newPath, it.oldPath)
      } catch (err) {
        console.error('[undoBatchRename] échec pour', it.id, (err as Error).message)
      }
    }
    startWatchers(mainWindow)
  })

  /**
   * Extraire une image fixe d'une vidéo à un instant précis (façon Picasa).
   * La frame est écrite dans le MÊME dossier que la vidéo source — déjà
   * surveillé — donc pas besoin de dupliquer la logique d'insertion en
   * base : un rescan (immédiat, pour une apparition rapide) suffit, le
   * pipeline habituel (hash, miniatures, EXIF) fait le reste.
   */
  ipcMain.handle('video:extractFrame', async (_e, { photoId, atSeconds }) => {
    const db = getDb()
    const ph = db.prepare('SELECT filepath FROM photos WHERE id = ?').get(photoId) as
      | { filepath: string }
      | undefined
    if (!ph) throw new Error('Vidéo introuvable dans la bibliothèque')
    if (!(await access(ph.filepath).then(() => true).catch(() => false))) {
      throw new Error(`Fichier vidéo source introuvable sur le disque : ${ph.filepath}`)
    }
    const ff = await getFfmpegPath()
    if (!(await access(ff).then(() => true).catch(() => false))) {
      // Ne devrait plus arriver depuis le renforcement de getFfmpegPath()
      // (revérification avant de renvoyer un chemin mémorisé), mais un
      // message clair vaut mieux qu'un ENOTDIR cryptique si ça arrive.
      throw new Error(
        `ffmpeg introuvable au chemin résolu (${ff}). Réessaie — un nouveau ` +
          `téléchargement automatique va être tenté au prochain essai.`
      )
    }
    const dir = dirname(ph.filepath)
    const base = basename(ph.filepath, extname(ph.filepath))
    const tsLabel = Math.max(0, atSeconds).toFixed(2).replace('.', '-')
    let outPath = join(dir, `${base}_frame_${tsLabel}s.jpg`)
    let n = 1
    while (await access(outPath).then(() => true).catch(() => false)) {
      outPath = join(dir, `${base}_frame_${tsLabel}s_${n}.jpg`)
      n++
    }
    console.log('[extractFrame] ffmpeg:', ff, '| source:', ph.filepath, '| sortie:', outPath)
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ff, [
        '-y', '-ss', String(Math.max(0, atSeconds)), '-i', ph.filepath,
        '-frames:v', '1', '-q:v', '2', outPath
      ])
      const killTimer = setTimeout(() => {
        proc.kill('SIGKILL')
        reject(new Error('ffmpeg timeout (20s) — process tué'))
      }, 20_000)
      let stderr = ''
      proc.stderr?.on('data', (d) => (stderr += d.toString()))
      proc.on('error', (err) => {
        clearTimeout(killTimer)
        reject(new Error(`Impossible de lancer ffmpeg (${ff}) : ${err.message}`))
      })
      proc.on('close', (code) => {
        clearTimeout(killTimer)
        code === 0
          ? resolve()
          : reject(new Error(`ffmpeg a échoué (code ${code})\n${stderr.slice(-400)}`))
      })
    })
    startScan(mainWindow) // rescan immédiat plutôt que d'attendre le debounce du watcher
    return { outPath }
  })

  /**
   * Découpe vidéo non destructive (façon Picasa) : ne stocke que les
   * points de repère, jamais de réencodage du fichier original. Appliqués
   * à la lecture (Lightbox, coupe JS au timeupdate) et à l'inclusion dans
   * un film (movie.ts, -ss/-to ffmpeg). trimEnd=null efface la découpe.
   */
  ipcMain.handle('photos:setTrim', (_e, { photoId, trimStartMs, trimEndMs }) => {
    getDb()
      .prepare('UPDATE photos SET trim_start_ms = ?, trim_end_ms = ? WHERE id = ?')
      .run(trimStartMs, trimEndMs, photoId)
  })

  ipcMain.handle('privacy:status', () => privacyStatus())
  ipcMain.handle('privacy:setPassword', (_e, { password }) => setPassword(password))
  ipcMain.handle('privacy:unlock', (_e, { password }) => ({ ok: unlock(password) }))
  ipcMain.handle('privacy:lock', () => lock())
  ipcMain.handle('export:batch', (_e, opts) => batchExport(mainWindow, opts))
  ipcMain.handle('export:metadata', async (_e, { photoIds, destFile }) =>
    exportMetadataCsv(photoIds, destFile)
  )
  ipcMain.handle('photos:print', (_e, { photoIds, layout, paperSize, marginMm }) =>
    printPhotos(photoIds, layout, paperSize, marginMm)
  )
  ipcMain.handle('share:email', (_e, { photoIds }) => emailShare(mainWindow, photoIds))
  ipcMain.handle('photos:email', (_e, { photoId }) => emailPhoto(photoId))
  ipcMain.handle('photos:blogExport', (_e, { photoId }) => blogExport(photoId))
  ipcMain.handle('photos:batchExport', async (_e, { photoIds, maxSize, format, quality }) => {
    const pick = await dialog.showOpenDialog(mainWindow, {
      title: "Dossier d'export groupé",
      properties: ['openDirectory', 'createDirectory']
    })
    if (pick.canceled || !pick.filePaths[0]) return { exported: 0, errors: 0, canceled: true }
    const r = await batchExportAdvanced(mainWindow, {
      photoIds,
      destDir: pick.filePaths[0],
      maxSize,
      format,
      quality
    })
    return { ...r, canceled: false }
  })
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
    // Instantané AVANT mutation — seule façon d'annuler proprement ensuite :
    // la fusion écrase note/favori du gardé (MAX) et déplace irrévocablement
    // albums/tags/visages depuis les photos supprimées.
    const keepBefore = db
      .prepare('SELECT rating, is_favorite FROM photos WHERE id = ?')
      .get(keepId) as { rating: number; is_favorite: number }
    const snapshot: MergeSnapshot = {
      keepId,
      keepBefore,
      removed: (removeIds as number[]).map((rid: number) => ({
        id: rid,
        albumItems: db
          .prepare('SELECT album_id, position, added_at FROM album_items WHERE photo_id = ?')
          .all(rid) as { album_id: number; position: number; added_at: number }[],
        tagIds: (
          db.prepare('SELECT tag_id FROM photo_tags WHERE photo_id = ?').all(rid) as {
            tag_id: number
          }[]
        ).map((r) => r.tag_id),
        faceIds: (
          db.prepare('SELECT id FROM faces WHERE photo_id = ?').all(rid) as { id: number }[]
        ).map((r) => r.id)
      }))
    }

    // Préparation des statements hors de la boucle : avant, chaque tour
    // de la transaction recompilait 7 statements (INSERT album_items, DELETE,
    // INSERT photo_tags, DELETE, UPDATE faces, UPDATE photos rating, UPDATE
    // status) — sur un doublon de N photos, c'est 7N préparations au lieu de 7.
    const stmts = {
      albumInsert: db.prepare(
        `INSERT OR IGNORE INTO album_items (album_id, photo_id, position, added_at)
         SELECT album_id, ?, position, added_at FROM album_items WHERE photo_id = ?`
      ),
      albumDelete: db.prepare('DELETE FROM album_items WHERE photo_id = ?'),
      tagInsert: db.prepare(
        `INSERT OR IGNORE INTO photo_tags (photo_id, tag_id)
         SELECT ?, tag_id FROM photo_tags WHERE photo_id = ?`
      ),
      tagDelete: db.prepare('DELETE FROM photo_tags WHERE photo_id = ?'),
      faceMove: db.prepare('UPDATE faces SET photo_id = ? WHERE photo_id = ?'),
      keepBest: db.prepare(
        `UPDATE photos SET
           rating = MAX(rating, (SELECT rating FROM photos WHERE id = ?)),
           is_favorite = MAX(is_favorite, (SELECT is_favorite FROM photos WHERE id = ?))
         WHERE id = ?`
      ),
      trash: db.prepare(`UPDATE photos SET status = 'trashed' WHERE id = ?`)
    }

    const tx = db.transaction((ids: number[]) => {
      for (const rid of ids) {
        // Fusion des références : albums, tags, visages pointent vers la photo gardée
        stmts.albumInsert.run(keepId, rid)
        stmts.albumDelete.run(rid)
        stmts.tagInsert.run(keepId, rid)
        stmts.tagDelete.run(rid)
        stmts.faceMove.run(keepId, rid)
        // La meilleure note/favori survit
        stmts.keepBest.run(rid, rid, keepId)
        stmts.trash.run(rid)
      }
    })
    tx(removeIds)
    return snapshot
  })
  ipcMain.handle('duplicates:undoMerge', (_e, snapshot: MergeSnapshot) => {
    const db = getDb()
    // Préparation hors boucle (même raison que merge) : on a 4 statements
    // distincts exécutés en boucle, on les prépare une fois.
    const stmts = {
      restoreKeep: db.prepare(
        'UPDATE photos SET rating = ?, is_favorite = ? WHERE id = ?'
      ),
      restoreStatus: db.prepare(`UPDATE photos SET status = 'active' WHERE id = ?`),
      albumInsert: db.prepare(
        `INSERT OR IGNORE INTO album_items (album_id, photo_id, position, added_at)
         VALUES (?, ?, ?, ?)`
      ),
      tagInsert: db.prepare(
        'INSERT OR IGNORE INTO photo_tags (photo_id, tag_id) VALUES (?, ?)'
      ),
      faceRestore: db.prepare('UPDATE faces SET photo_id = ? WHERE id = ?')
    }
    const tx = db.transaction((snap: MergeSnapshot) => {
      stmts.restoreKeep.run(
        snap.keepBefore.rating,
        snap.keepBefore.is_favorite,
        snap.keepId
      )
      for (const r of snap.removed) {
        stmts.restoreStatus.run(r.id)
        for (const ai of r.albumItems) {
          stmts.albumInsert.run(ai.album_id, r.id, ai.position, ai.added_at)
        }
        for (const tagId of r.tagIds) {
          stmts.tagInsert.run(r.id, tagId)
        }
        for (const faceId of r.faceIds) {
          stmts.faceRestore.run(r.id, faceId)
        }
      }
    })
    tx(snapshot)
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
  // Photos géolocalisées dans une bounding box (filtré par les filtres grille aussi)
  ipcMain.handle('photos:withGeo', (_e: Electron.IpcMainInvokeEvent, { bbox, minStars, typeFilter }: { bbox: BoundingBox; minStars?: number; typeFilter?: 'all' | 'image' | 'video' }) => {
    const conditions = [
      'gps_lat IS NOT NULL AND gps_lon IS NOT NULL',
      'status = \'active\' AND is_hidden = 0',
      'gps_lat >= ? AND gps_lat <= ?',
      'gps_lon >= ? AND gps_lon <= ?'
    ]
    const params: (string | number)[] = [
      bbox.south, bbox.north, bbox.west, bbox.east
    ]
    if (minStars && minStars > 0) {
      conditions.push('rating >= ?')
      params.push(minStars)
    }
    if (typeFilter && typeFilter !== 'all') {
      conditions.push('media_type = ?')
      params.push(typeFilter)
    }
    return getDb()
      .prepare(
        `SELECT id, filename, gps_lat, gps_lon FROM photos
         WHERE ${conditions.join(' AND ')}
         ORDER BY taken_at DESC`
      )
      .all(...params)
  })
  // Géocoding inverse via Nominatim (OpenStreetMap)
  ipcMain.handle(
    'photos:reverseGeocode',
    async (_e, { lat, lon }): Promise<ReverseGeocodeResult | null> => {
      try {
        const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=14&addressdetails=1`
        const resp = await net.fetch(url, {
          headers: { 'User-Agent': 'PicaLibre/2.2.0 (photo manager)' }
        })
        if (!resp.ok) return null
        const data = (await resp.json()) as {
          display_name?: string
          address?: { city?: string; town?: string; village?: string; country?: string }
        }
        if (!data.display_name) return null
        const city = data.address?.city ?? data.address?.town ?? data.address?.village
        return {
          displayName: data.display_name,
          city: city ?? undefined,
          country: data.address?.country ?? undefined
        }
      } catch {
        return null
      }
    }
  )
  /**
   * Détection de voyages/événements : lecture seule, ne propose que —
   * la création réelle des albums est une étape séparée côté renderer
   * qui réutilise albums:create + albums:addPhotos (aucune duplication
   * de logique d'album ici).
   */
  ipcMain.handle('trips:detect', () => detectTrips())

  ipcMain.handle('edits:get', (_e, { photoId }) => getEditState(photoId))
  ipcMain.handle('edits:save', (_e, { photoId, stack, action }) => {
    const s = saveStack(photoId, stack, action)
    return { canUndo: s.canUndo, canRedo: s.canRedo }
  })
  ipcMain.handle('edits:undo', (_e, { photoId }) => undo(photoId))
  ipcMain.handle('edits:redo', (_e, { photoId }) => redo(photoId))

  /**
   * Édition en lot façon Picasa — deux modes :
   *  - « Coller les réglages » : applique tel quel un stack copié depuis une
   *    photo (crop/retouch/redeye exclus côté renderer avant l'appel — un
   *    recadrage ou une retouche localisée n'a pas de sens copié ailleurs).
   *  - « Correction auto » : contraste + couleur calculés INDIVIDUELLEMENT
   *    pour chaque photo (pas une valeur copiée), à partir de sa miniature
   *    1024px déjà en cache (rapide, pas besoin de décoder l'original).
   * Les deux renvoient un instantané « avant » par photo pour permettre
   * l'annulation groupée (façon Picasa, même mécanisme que les autres
   * actions destructives).
   */
  ipcMain.handle('edits:batchApply', (_e, { photoIds, stack, action }) => {
    const before: Array<{ photoId: number; prevStack: EditStack }> = []
    for (const id of photoIds as number[]) {
      before.push({ photoId: id, prevStack: getEditState(id).stack })
      saveStack(id, stack, action)
    }
    return { before }
  })

  ipcMain.handle('edits:batchAutoFix', async (_e, { photoIds }) => {
    const db = getDb()
    const before: Array<{ photoId: number; prevStack: EditStack }> = []
    const failed: number[] = []
    for (const id of photoIds as number[]) {
      const row = db.prepare('SELECT hash_xxh3 FROM photos WHERE id = ?').get(id) as
        | { hash_xxh3: string }
        | undefined
      if (!row) continue
      const cachePath = join(thumbsCacheDir(), row.hash_xxh3.slice(0, 2), `${row.hash_xxh3}_1024.webp`)
      try {
        const { data, info } = await sharp(cachePath)
          .removeAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true })
        const { black, white } = computeAutoContrast(data, 3)
        const { r, g, b } = computeAutoColor(data, 3)
        const prevStack = getEditState(id).stack
        before.push({ photoId: id, prevStack })
        let next = upsertOp(prevStack, { type: 'levels', params: { black, white } })
        next = upsertOp(next, { type: 'wb', params: { r, g, b } })
        saveStack(id, next, 'auto_fix_lot')
      } catch (err) {
        console.error('[batchAutoFix] échec photoId=', id, (err as Error).message)
        failed.push(id)
      }
    }
    return { before, failed }
  })

  ipcMain.handle('edits:undoBatch', (_e, before) => {
    for (const b of before as Array<{ photoId: number; prevStack: EditStack }>) {
      saveStack(b.photoId, b.prevStack, 'undo_lot')
    }
  })

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

  // Rescan léger automatique au démarrage (hors modes de test headless) :
  // jusqu'ici, seul le watcher de fichiers démarrait tout seul — si une
  // miniature échouait une fois (ex. vignette vidéo jamais générée) ou si
  // des fichiers étaient ajoutés pendant que l'app était fermée, rien ne
  // relançait jamais le pipeline sans action explicite de l'utilisateur.
  const isTestMode = [
    'PICALIBRE_TEST_SCAN',
    'PICALIBRE_TEST_WEBGL',
    'PICALIBRE_TEST_RELOCATE',
    'PICALIBRE_TEST_IMPORT',
    'PICALIBRE_TEST_BENCH',
    'PICALIBRE_TEST_WEBSYNC',
    'PICALIBRE_TEST_MENU',
    'PICALIBRE_TEST_GEO_SCREENSHOT',
    'PICALIBRE_TEST_SCREENSHOT',
    'PICALIBRE_TEST_SCREENSHOT_GRID',
    'PICALIBRE_TEST_SCREENSHOT_COMPARE',
    'PICALIBRE_TEST_RENAME',
    'PICALIBRE_TEST_VIDEO_PLAYBACK',
    'PICALIBRE_TEST_VIDEO_FEATURES',
    'PICALIBRE_TEST_EDITOR_TABS',
    'PICALIBRE_TEST_MAP_LIGHTBOX',
    'PICALIBRE_TEST_GRID_REMOUNT',
    'PICALIBRE_TEST_SLIDESHOW',
    'PICALIBRE_TEST_FOLDER_REMOVE',
    'PICALIBRE_TEST_LIGHTBOX_CONTRAST',
    'PICALIBRE_TEST_BATCHEDIT',
    'PICALIBRE_TEST_TRASH',
    'PICALIBRE_TEST_TRIPS',
    'PICALIBRE_TEST_MAP'
  ].some((k) => !!process.env[k])
  if (!isTestMode) {
    const hasRoots = getDb().prepare('SELECT 1 FROM scan_roots LIMIT 1').get()
    if (hasRoots) {
      console.log('[startup] rescan léger automatique')
      startScan(mainWindow)
    }
  }

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

  // Mode capture CARTE : scanne, ouvre la vue Carte, capture, quitte.
  const geoShotDir = process.env.PICALIBRE_TEST_GEO_SCREENSHOT
  if (geoShotDir) {
    getDb().prepare('INSERT OR IGNORE INTO scan_roots (path) VALUES (?)').run(geoShotDir)
    startScan(mainWindow)
    setTimeout(async () => {
      const clicked = await mainWindow.webContents.executeJavaScript(
        `(() => {
          const el = [...document.querySelectorAll('aside div')].find(d => d.textContent.includes('Carte'))
          if (el) { el.click(); return true }
          return false
        })()`
      )
      console.log('[geo-test] clic Carte:', clicked)
      setTimeout(async () => {
        const probe = await mainWindow.webContents.executeJavaScript(
          `(() => ({
            leafletContainer: !!document.querySelector('.leaflet-container'),
            markerCount: document.querySelectorAll('.leaflet-marker-icon, .marker-cluster').length,
            tilesLoaded: document.querySelectorAll('.leaflet-tile-loaded, .leaflet-tile').length,
            errorText: document.body.textContent.includes('hors ligne') || document.body.textContent.includes('connexion') ? 'message offline présent' : null
          }))()`
        )
        console.log('[geo-test] probe:', JSON.stringify(probe))
        const img = await mainWindow.webContents.capturePage()
        await writeFile(join(app.getPath('temp'), 'picalibre-geo.png'), img.toPNG())
        console.log('[geo-test] capture écrite')
        exitTest(0)
      }, 5000)
    }, 6000)
  }

  // Test headless : la Lightbox ouverte depuis la Carte doit passer AU-DESSUS
  // de la carte (bug signalé : z-index trop bas, photo cachée derrière).
  // PICALIBRE_TEST_MAP_LIGHTBOX=<dossier>
  const mapLightboxDir = process.env.PICALIBRE_TEST_MAP_LIGHTBOX
  if (mapLightboxDir) {
    getDb().prepare('INSERT OR IGNORE INTO scan_roots (path) VALUES (?)').run(mapLightboxDir)
    startScan(mainWindow)
    const t0m = Date.now()
    const ivm = setInterval(async () => {
      const q = (sql: string): number => (getDb().prepare(sql).get() as { c: number }).c
      const photos = q('SELECT COUNT(*) c FROM photos')
      const thumbs = q('SELECT COUNT(*) c FROM thumbnails')
      if ((photos > 0 && thumbs >= photos * 2) || Date.now() - t0m > 60000) {
        clearInterval(ivm)
        const db = getDb()
        const first = db
          .prepare("SELECT id FROM photos WHERE status='active' ORDER BY id LIMIT 1")
          .get() as { id: number } | undefined
        if (!first) {
          exitTest(1)
          return
        }
        // Géolocaliser manuellement (pas besoin d'EXIF GPS pour ce test)
        db.prepare('UPDATE photos SET gps_lat = ?, gps_lon = ? WHERE id = ?').run(
          48.8566,
          2.3522,
          first.id
        )
        await mainWindow.webContents.executeJavaScript(
          `(() => { const el = [...document.querySelectorAll('aside div')].find(d => d.textContent.includes('Carte')); if (el) el.click(); })()`
        )
        await new Promise((r) => setTimeout(r, 3000))
        await mainWindow.webContents.executeJavaScript(
          `(() => { const m = document.querySelector('.leaflet-marker-icon'); if (m) m.dispatchEvent(new MouseEvent('click', { bubbles: true })); })()`
        )
        await new Promise((r) => setTimeout(r, 1500))
        const probe = await mainWindow.webContents.executeJavaScript(
          `(() => {
            const lightbox = document.querySelector('img[src*="thumb://library/1024"], img[src*="thumb://library/orig"]')
            if (!lightbox) return { lightboxFound: false }
            const rect = lightbox.getBoundingClientRect()
            const cx = rect.left + rect.width / 2
            const cy = rect.top + rect.height / 2
            const topElement = document.elementFromPoint(cx, cy)
            // La Lightbox doit être l'élément (ou un ancêtre direct) réellement
            // au sommet à cet endroit, pas un élément de la carte Leaflet
            const isLeafletOnTop = !!(topElement && topElement.closest('.leaflet-container') && !topElement.closest('img'))
            return {
              lightboxFound: true,
              lightboxZIndex: getComputedStyle(lightbox.closest('div[style*="position: fixed"]') || lightbox).zIndex,
              topElementTag: topElement ? topElement.tagName : null,
              topElementIsMapNotPhoto: isLeafletOnTop,
              topElementIsLightboxImg: topElement === lightbox
            }
          })()`
        )
        console.log('[map-lightbox-test]', JSON.stringify(probe))

        // Vérification directe de la couleur CSS calculée (pas de l'analyse
        // de pixels) sur la barre d'aide du bas de la Lightbox — AVANT
        // d'ouvrir l'éditeur, qui remplace tout le DOM de la Lightbox
        const footerProbe = await mainWindow.webContents.executeJavaScript(
          `(() => {
            const bars = [...document.querySelectorAll('div')].filter(d =>
              d.children.length === 0 && d.textContent.includes('Échap') && d.textContent.includes('fermer')
            )
            if (bars.length === 0) return { found: false }
            const bar = bars[bars.length - 1]
            const style = getComputedStyle(bar)
            return {
              found: true,
              text: bar.textContent,
              color: style.color,
              backgroundColor: style.backgroundColor,
              fontSize: style.fontSize
            }
          })()`
        )
        console.log('[map-lightbox-test] footer CSS:', JSON.stringify(footerProbe))

        // Ouvrir l'éditeur depuis la Lightbox (scénario signalé : la carte
        // reprenait le premier plan à l'ouverture de l'éditeur)
        await mainWindow.webContents.executeJavaScript(
          `(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('Éditer')); if (b) b.click(); })()`
        )
        await new Promise((r) => setTimeout(r, 1000))
        const editorProbe = await mainWindow.webContents.executeJavaScript(
          `(() => {
            const canvas = document.querySelector('main canvas[style*="cursor"]') || document.querySelector('aside + main canvas')
            const editorAside = [...document.querySelectorAll('aside')].find(a => a.textContent.includes('Bibliothèque'))
            if (!editorAside) return { editorFound: false }
            const rect = editorAside.getBoundingClientRect()
            const cx = rect.left + rect.width / 2
            const cy = rect.top + 20
            const topElement = document.elementFromPoint(cx, cy)
            const isMapOnTop = !!(topElement && topElement.closest('.leaflet-container'))
            return {
              editorFound: true,
              topElementIsMap: isMapOnTop,
              topElementInEditor: !!(topElement && topElement.closest('aside')?.textContent.includes('Bibliothèque'))
            }
          })()`
        )
        console.log('[map-lightbox-test] editor:', JSON.stringify(editorProbe))
        console.log('[map-lightbox-test] TERMINÉ')
        exitTest(0)
      }
    }, 500)
  }


  // Capture de la grille pure (QA visuelle) : PICALIBRE_TEST_SCREENSHOT_GRID=<dossier>
  // Aucune navigation ni double-clic — juste la vue par défaut (Chronologie)
  // une fois le scan terminé, pour vérifier visuellement le rendu des
  // vignettes (chevauchement, recadrage, superposition…).
  const shotGridDir = process.env.PICALIBRE_TEST_SCREENSHOT_GRID
  if (shotGridDir) {
    getDb().prepare('INSERT OR IGNORE INTO scan_roots (path) VALUES (?)').run(shotGridDir)
    startScan(mainWindow)
    const t0 = Date.now()
    const iv = setInterval(async () => {
      const q = (sql: string): number => (getDb().prepare(sql).get() as { c: number }).c
      const photos = q('SELECT COUNT(*) c FROM photos')
      const thumbs = q('SELECT COUNT(*) c FROM thumbnails')
      const ready = photos > 0 && thumbs >= photos * 2
      if (ready || Date.now() - t0 > 60000) {
        clearInterval(iv)
        // Sélectionner le dossier dans la barre latérale — sur un profil
        // neuf, aucune vue n'est active par défaut (comportement normal,
        // pas un bug : « Sélectionne un dossier ou un album »).
        await mainWindow.webContents.executeJavaScript(
          `(() => { const el = [...document.querySelectorAll('aside div')].find(d => d.textContent.includes('Chronologie')); if (el) el.click(); })()`
        )
        // Laisse le temps au canvas de peindre les miniatures fraîchement prêtes
        setTimeout(async () => {
          const dom = await mainWindow.webContents.executeJavaScript(
            `(() => {
              const figures = document.querySelectorAll('main figure')
              const canvases = document.querySelectorAll('main figure canvas')
              const mainText = document.querySelector('main')?.textContent?.slice(0, 300)
              const asideHeaders = [...document.querySelectorAll('aside > div')].map(d => d.textContent?.slice(0, 40))
              const errorBanner = document.body.textContent?.includes('Erreur')
              return { figures: figures.length, canvases: canvases.length, mainText, asideHeaders, errorBanner, bodyLen: document.body.textContent.length }
            })()`
          )
          console.log('[grid-shot] DOM:', JSON.stringify(dom))
          const img = await mainWindow.webContents.capturePage()
          const shotOut = join(app.getPath('temp'), 'picalibre-grid.png')
          await writeFile(shotOut, img.toPNG())
          console.log('[grid-shot] photos=', photos, 'thumbs=', thumbs, 'écrit:', shotOut)
          exitTest(0)
        }, 1500)
      }
    }, 500)
  }

  // Capture du côte-à-côte de l'éditeur (QA visuelle) :
  // PICALIBRE_TEST_SCREENSHOT_COMPARE=<dossier>
  // Ouvre l'éditeur sur la 1re photo, applique un filtre N&B (changement
  // visuel évident), active le côte-à-côte, puis capture.
  const shotCompareDir = process.env.PICALIBRE_TEST_SCREENSHOT_COMPARE
  if (shotCompareDir) {
    getDb().prepare('INSERT OR IGNORE INTO scan_roots (path) VALUES (?)').run(shotCompareDir)
    startScan(mainWindow)
    const t0c = Date.now()
    const ivc = setInterval(async () => {
      const q = (sql: string): number => (getDb().prepare(sql).get() as { c: number }).c
      const photos = q('SELECT COUNT(*) c FROM photos')
      const thumbs = q('SELECT COUNT(*) c FROM thumbnails')
      const ready = photos > 0 && thumbs >= photos * 2
      if (ready || Date.now() - t0c > 60000) {
        clearInterval(ivc)
        await mainWindow.webContents.executeJavaScript(
          `(() => { const el = [...document.querySelectorAll('aside div')].find(d => d.textContent.includes('Chronologie')); if (el) el.click(); })()`
        )
        setTimeout(async () => {
          // Double-clic sur la 1re vignette → Lightbox, puis Éditer
          await mainWindow.webContents.executeJavaScript(
            `(() => { const im = document.querySelector('main figure canvas'); if (im) im.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })()`
          )
          setTimeout(async () => {
            await mainWindow.webContents.executeJavaScript(
              `(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('Éditer')); if (b) b.click(); })()`
            )
            setTimeout(async () => {
              // Appliquer le filtre N&B (changement visuel net et vérifiable)
              await mainWindow.webContents.executeJavaScript(
                `(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'N&B'); if (b) b.click(); })()`
              )
              setTimeout(async () => {
                // Activer le côte à côte
                await mainWindow.webContents.executeJavaScript(
                  `(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('Comparer côte à côte')); if (b) b.click(); })()`
                )
                setTimeout(async () => {
                  const dom = await mainWindow.webContents.executeJavaScript(
                    `(() => {
                      const canvases = document.querySelectorAll('main canvas')
                      const spans = [...document.querySelectorAll('main span')].filter(s=>s.textContent==='ORIGINAL'||s.textContent==='ÉDITÉ')
                      const rects = spans.map(s => {
                        const canvas = s.parentElement.querySelector('canvas')
                        const r = canvas ? canvas.getBoundingClientRect() : null
                        return { label: s.textContent, rect: r ? {x:r.x,y:r.y,w:r.width,h:r.height} : null }
                      })
                      return { canvasCount: canvases.length, rects }
                    })()`
                  )
                  console.log('[compare-shot] DOM:', JSON.stringify(dom))
                  const img = await mainWindow.webContents.capturePage()
                  const shotOut = join(app.getPath('temp'), 'picalibre-compare.png')
                  await writeFile(shotOut, img.toPNG())
                  console.log('[compare-shot] écrit:', shotOut)
                  exitTest(0)
                }, 800)
              }, 500)
            }, 1000)
          }, 1500)
        }, 1500)
      }
    }, 500)
  }

  // Test headless de la Corbeille : PICALIBRE_TEST_TRASH=<dossier>
  const trashTestDir = process.env.PICALIBRE_TEST_TRASH
  if (trashTestDir) {
    getDb().prepare('INSERT OR IGNORE INTO scan_roots (path) VALUES (?)').run(trashTestDir)
    startScan(mainWindow)
    const t0t = Date.now()
    const ivt = setInterval(async () => {
      const q = (sql: string): number => (getDb().prepare(sql).get() as { c: number }).c
      const photos = q('SELECT COUNT(*) c FROM photos')
      const thumbs = q('SELECT COUNT(*) c FROM thumbnails')
      if ((photos >= 3 && thumbs >= photos * 2) || Date.now() - t0t > 60000) {
        clearInterval(ivt)
        const db = getDb()
        const fs = await import('node:fs/promises')
        const rows = db
          .prepare("SELECT id, filepath, filename FROM photos WHERE status = 'active' ORDER BY id LIMIT 3")
          .all() as Array<{ id: number; filepath: string; filename: string }>
        const ids = rows.map((r) => r.id)
        console.log('[trash-test] photos de départ:', JSON.stringify(rows))

        // 1) Mettre à la corbeille
        const r1 = await mainWindow.webContents.executeJavaScript(
          `window.api.invoke('photos:trash', { photoIds: ${JSON.stringify(ids)} })`
        )
        const statusesAfterTrash = db
          .prepare(`SELECT id, status FROM photos WHERE id IN (${ids.join(',')})`)
          .all()
        console.log('[trash-test] photos:trash résultat:', JSON.stringify(r1), 'statuts:', JSON.stringify(statusesAfterTrash))

        // 2) Vérifier qu'elles apparaissent dans la vue Corbeille et plus
        //    dans la vue dossier normale
        const trashedList = await mainWindow.webContents.executeJavaScript(
          `window.api.invoke('photos:trashed', undefined).then(r => r.map(p => p.id))`
        )
        console.log('[trash-test] vue Corbeille contient:', JSON.stringify(trashedList))
        const stillInFolder = db
          .prepare(
            `SELECT COUNT(*) c FROM photos WHERE id IN (${ids.join(',')}) AND status = 'active'`
          )
          .get() as { c: number }
        console.log('[trash-test] encore actives (doit être 0):', stillInFolder.c)

        // 3) Restaurer le premier, vérifier son retour en 'active'
        const restoreId = ids[0]
        await mainWindow.webContents.executeJavaScript(
          `window.api.invoke('photos:undoTrash', { photoIds: [${restoreId}] })`
        )
        const afterRestore = db.prepare('SELECT status FROM photos WHERE id = ?').get(restoreId) as {
          status: string
        }
        console.log('[trash-test] statut après restauration id=' + restoreId + ':', afterRestore.status)

        // 4) Supprimer définitivement les 2 restantes — vérifier fichier ET
        //    ligne DB réellement absents ensuite, ET miniatures webp du
        //    cache disque supprimées (correctif audit : orphelins)
        const deleteIds = ids.slice(1)
        const cachePathsBefore = deleteIds.flatMap(
          (id) => db.prepare('SELECT cache_path FROM thumbnails WHERE photo_id = ?').all(id) as {
            cache_path: string
          }[]
        )
        console.log('[trash-test] miniatures en cache avant suppression:', cachePathsBefore.length)
        const filesBefore = await Promise.all(
          rows
            .filter((r) => deleteIds.includes(r.id))
            .map(async (r) => ({
              id: r.id,
              existedBefore: await fs
                .access(r.filepath)
                .then(() => true)
                .catch(() => false)
            }))
        )
        console.log('[trash-test] fichiers présents avant suppression définitive:', JSON.stringify(filesBefore))
        const r2 = await mainWindow.webContents.executeJavaScript(
          `window.api.invoke('photos:deleteForever', { photoIds: ${JSON.stringify(deleteIds)} })`
        )
        console.log('[trash-test] photos:deleteForever résultat:', JSON.stringify(r2))
        const filesAfter = await Promise.all(
          rows
            .filter((r) => deleteIds.includes(r.id))
            .map(async (r) => ({
              id: r.id,
              existsAfter: await fs
                .access(r.filepath)
                .then(() => true)
                .catch(() => false)
            }))
        )
        console.log('[trash-test] fichiers présents après suppression définitive (doit être false):', JSON.stringify(filesAfter))
        const rowsAfter = db
          .prepare(`SELECT id FROM photos WHERE id IN (${deleteIds.join(',')})`)
          .all()
        console.log('[trash-test] lignes DB restantes après suppression (doit être []):', JSON.stringify(rowsAfter))
        const cacheGone = await Promise.all(
          cachePathsBefore.map(async (c) => ({
            path: c.cache_path,
            stillThere: await fs
              .access(c.cache_path)
              .then(() => true)
              .catch(() => false)
          }))
        )
        console.log(
          '[trash-test] miniatures webp encore sur disque après suppression (doit être 0):',
          cacheGone.filter((c) => c.stillThere).length
        )

        // 5) Verrou de confidentialité (correctif audit) : une photo masquée
        //    mise à la corbeille ne doit PAS apparaître dans photos:trashed
        //    tant que le verrou est actif, et redevient visible déverrouillée
        const privId = restoreId // la photo restaurée à l'étape 3
        await mainWindow.webContents.executeJavaScript(
          `window.api.invoke('privacy:setPassword', { password: 'test-audit' })`
        )
        await mainWindow.webContents.executeJavaScript(
          `window.api.invoke('photos:setHidden', { photoIds: [${privId}], hidden: true })`
        )
        await mainWindow.webContents.executeJavaScript(
          `window.api.invoke('photos:trash', { photoIds: [${privId}] })`
        )
        await mainWindow.webContents.executeJavaScript(`window.api.invoke('privacy:lock', undefined)`)
        const trashedLocked = await mainWindow.webContents.executeJavaScript(
          `window.api.invoke('photos:trashed', undefined).then(r => r.map(p => p.id))`
        )
        console.log(
          '[trash-test] corbeille VERROUILLÉE — photo masquée visible ? (doit être false):',
          (trashedLocked as number[]).includes(privId)
        )
        await mainWindow.webContents.executeJavaScript(
          `window.api.invoke('privacy:unlock', { password: 'test-audit' })`
        )
        const trashedUnlocked = await mainWindow.webContents.executeJavaScript(
          `window.api.invoke('photos:trashed', undefined).then(r => r.map(p => p.id))`
        )
        console.log(
          '[trash-test] corbeille DÉVERROUILLÉE — photo masquée visible ? (doit être true):',
          (trashedUnlocked as number[]).includes(privId)
        )
        // Défense en profondeur : verrouillé, deleteForever doit refuser la
        // photo masquée même par appel IPC direct
        await mainWindow.webContents.executeJavaScript(`window.api.invoke('privacy:lock', undefined)`)
        const delLocked = await mainWindow.webContents.executeJavaScript(
          `window.api.invoke('photos:deleteForever', { photoIds: [${privId}] })`
        )
        console.log(
          '[trash-test] deleteForever VERROUILLÉ sur photo masquée (deleted doit être 0):',
          JSON.stringify(delLocked)
        )
        const privStill = db.prepare('SELECT COUNT(*) c FROM photos WHERE id = ?').get(privId) as {
          c: number
        }
        console.log('[trash-test] la photo masquée existe toujours (doit être 1):', privStill.c)

        // 6) Durcissement protocole thumb (correctif audit) : verrouillé,
        //    ni la vignette ni l'original d'une photo masquée ne doivent
        //    être servis (403) ; déverrouillé, tout redevient accessible.
        //    Testé via net.fetch côté main : la CSP du renderer interdit de
        //    toute façon fetch() vers thumb: (connect-src), et le contrôle
        //    à valider vit dans le handler du protocole, pas dans le client.
        const thumbLocked = [
          (await net.fetch(`thumb://library/256/${privId}`)).status,
          (await net.fetch(`thumb://library/orig/${privId}`)).status
        ]
        console.log(
          '[trash-test] thumb VERROUILLÉ [vignette, orig] (doit être [403,403]):',
          JSON.stringify(thumbLocked)
        )
        await mainWindow.webContents.executeJavaScript(
          `window.api.invoke('privacy:unlock', { password: 'test-audit' })`
        )
        const thumbUnlocked = [
          (await net.fetch(`thumb://library/256/${privId}`)).status,
          (await net.fetch(`thumb://library/orig/${privId}`)).status
        ]
        console.log(
          '[trash-test] thumb DÉVERROUILLÉ [vignette, orig] (doit être [200,200]):',
          JSON.stringify(thumbUnlocked)
        )

        // 7) Blocage de navigation (correctif audit) : une tentative de
        //    navigation du renderer vers un site externe doit être
        //    neutralisée — l'URL de la fenêtre ne doit pas changer
        const urlBefore = mainWindow.webContents.getURL()
        await mainWindow.webContents.executeJavaScript(
          `new Promise(res => { try { location.href = 'https://example.com/'; } catch {} setTimeout(res, 800) })`
        )
        const urlAfter = mainWindow.webContents.getURL()
        console.log(
          '[trash-test] navigation externe bloquée ? (doit être true):',
          urlBefore === urlAfter
        )

        // 8) Pagination (correctif audit) : la Corbeille contient encore la
        //    photo masquée (déverrouillée à l'étape 6→7 re-verrouillée puis
        //    ici on déverrouille pour la voir) — vérifier LIMIT/OFFSET réels
        await mainWindow.webContents.executeJavaScript(
          `window.api.invoke('privacy:unlock', { password: 'test-audit' })`
        )
        // Remettre les 2 autres photos… déjà supprimées — recréer du contenu
        // de corbeille : remettre la photo masquée + rien d'autre, donc on
        // teste limit=1/offset=0 puis offset=1 (vide)
        const page0 = await mainWindow.webContents.executeJavaScript(
          `window.api.invoke('photos:trashed', { offset: 0, limit: 1 }).then(r => r.length)`
        )
        const page1 = await mainWindow.webContents.executeJavaScript(
          `window.api.invoke('photos:trashed', { offset: 1, limit: 1 }).then(r => r.length)`
        )
        const noPage = await mainWindow.webContents.executeJavaScript(
          `window.api.invoke('photos:trashed', undefined).then(r => r.length)`
        )
        console.log(
          '[trash-test] pagination corbeille [page0, page1, sans-payload] (doit être [1,0,1]):',
          JSON.stringify([page0, page1, noPage])
        )

        // 9) websync (correctif audit) : http distant refusé, https accepté,
        //    http localhost toléré (auto-hébergement + CI)
        const wsHttp = await mainWindow.webContents.executeJavaScript(
          `window.api.invoke('websync:setConfig', { url: 'http://exemple.fr/api', token: 't' })`
        )
        const wsHttps = await mainWindow.webContents.executeJavaScript(
          `window.api.invoke('websync:setConfig', { url: 'https://exemple.fr/api', token: 't' })`
        )
        const wsLocal = await mainWindow.webContents.executeJavaScript(
          `window.api.invoke('websync:setConfig', { url: 'http://localhost:4120', token: 't' })`
        )
        console.log(
          '[trash-test] websync [http distant, https, http localhost] ok? (doit être [false,true,true]):',
          JSON.stringify([wsHttp.ok, wsHttps.ok, wsLocal.ok])
        )

        console.log('[trash-test] TERMINÉ')
        exitTest(0)
      }
    }, 500)
  }

  // Test headless de la vue Carte : PICALIBRE_TEST_MAP=<dossier>
  // Reproduit le bug rapporté : cliquer un cluster zoomait sur des
  // coordonnées arrondies aberrantes et les photos « disparaissaient ».
  const mapTestDir = process.env.PICALIBRE_TEST_MAP
  if (mapTestDir) {
    getDb().prepare('INSERT OR IGNORE INTO scan_roots (path) VALUES (?)').run(mapTestDir)
    startScan(mainWindow)
    const t0m = Date.now()
    const ivm = setInterval(async () => {
      const q = (sql: string): number => (getDb().prepare(sql).get() as { c: number }).c
      const photos = q('SELECT COUNT(*) c FROM photos')
      const thumbs = q('SELECT COUNT(*) c FROM thumbnails')
      if ((photos >= 24 && thumbs >= photos * 2) || Date.now() - t0m > 90000) {
        clearInterval(ivm)
        const geoCount = q('SELECT COUNT(*) c FROM photos WHERE gps_lat IS NOT NULL')
        console.log('[map-test] photos géolocalisées en base:', geoCount)

        // Ouvrir la vue Carte via l'action du menu natif
        mainWindow.webContents.send('menu:action', { action: 'goMap' })
        await new Promise((r) => setTimeout(r, 2500))

        const countMarkers = `(() => ({
          clusters: document.querySelectorAll('.picalibre-map-cluster').length,
          singles: document.querySelectorAll('.picalibre-map-marker').length
        }))()`
        const before = await mainWindow.webContents.executeJavaScript(countMarkers)
        console.log('[map-test] marqueurs AVANT clic [clusters, photos seules]:', JSON.stringify(before))

        // Cliquer le premier cluster (le scénario exact du bug)
        const clicked = await mainWindow.webContents.executeJavaScript(`(() => {
          const c = document.querySelector('.picalibre-map-cluster')
          if (!c) return false
          c.dispatchEvent(new MouseEvent('click', { bubbles: true }))
          return true
        })()`)
        console.log('[map-test] clic sur un cluster effectué:', clicked)

        // Laisser l'animation fitBounds + le debounce moveend (300ms) + la
        // requête bbox se dérouler entièrement
        await new Promise((r) => setTimeout(r, 3000))

        const after = await mainWindow.webContents.executeJavaScript(countMarkers)
        const total = (after as { clusters: number; singles: number })
        console.log('[map-test] marqueurs APRÈS zoom [clusters, photos seules]:', JSON.stringify(after))
        console.log(
          '[map-test] les photos restent visibles après le zoom ? (doit être true):',
          total.clusters + total.singles > 0
        )

        // Second clic si un cluster subsiste — vérifier la stabilité au
        // niveau de zoom suivant aussi
        const clicked2 = await mainWindow.webContents.executeJavaScript(`(() => {
          const c = document.querySelector('.picalibre-map-cluster')
          if (!c) return false
          c.dispatchEvent(new MouseEvent('click', { bubbles: true }))
          return true
        })()`)
        if (clicked2) {
          await new Promise((r) => setTimeout(r, 3000))
          const after2 = await mainWindow.webContents.executeJavaScript(countMarkers)
          const t2 = after2 as { clusters: number; singles: number }
          console.log('[map-test] marqueurs après 2e zoom:', JSON.stringify(after2))
          console.log(
            '[map-test] toujours visibles après 2e zoom ? (doit être true):',
            t2.clusters + t2.singles > 0
          )
        } else {
          console.log('[map-test] plus de cluster après le 1er zoom — photos déjà individuelles')
        }

        console.log('[map-test] TERMINÉ')
        exitTest(0)
      }
    }, 500)
  }

  // Test headless de la détection voyages/événements : PICALIBRE_TEST_TRIPS=<dossier>
  const tripsTestDir = process.env.PICALIBRE_TEST_TRIPS
  if (tripsTestDir) {
    getDb().prepare('INSERT OR IGNORE INTO scan_roots (path) VALUES (?)').run(tripsTestDir)
    startScan(mainWindow)
    const t0p = Date.now()
    const ivp = setInterval(async () => {
      const q = (sql: string): number => (getDb().prepare(sql).get() as { c: number }).c
      const photos = q('SELECT COUNT(*) c FROM photos')
      const thumbs = q('SELECT COUNT(*) c FROM thumbnails')
      if ((photos >= 24 && thumbs >= photos * 2) || Date.now() - t0p > 90000) {
        clearInterval(ivp)
        const db = getDb()
        const withDates = db
          .prepare("SELECT id, taken_at, gps_lat, gps_lon FROM photos WHERE status = 'active' ORDER BY taken_at")
          .all()
        console.log('[trips-test] photos indexées avec taken_at/gps:', JSON.stringify(withDates))

        // 1) Détection — lecture seule, doit proposer 4 groupes (Strasbourg,
        //    Paris, Marseille, sans-GPS) et IGNORER le groupe de 2 photos
        const groups = await mainWindow.webContents.executeJavaScript(
          `window.api.invoke('trips:detect', undefined)`
        )
        console.log('[trips-test] groupes détectés:', JSON.stringify(groups))
        console.log('[trips-test] nombre de groupes (attendu 5):', groups.length)
        console.log(
          '[trips-test] tailles de groupes (attendu [5,4,4,5,4]):',
          JSON.stringify(groups.map((g: { count: number }) => g.count))
        )
        console.log(
          '[trips-test] villes détectées (attendu 4 géocodées dont 2 même zone, 1 null):',
          JSON.stringify(groups.map((g: { city: string | null }) => g.city))
        )

        // Vérifier qu'aucune photo n'a été modifiée par la simple détection
        const stillActiveCount = (
          db.prepare("SELECT COUNT(*) c FROM photos WHERE status = 'active'").get() as { c: number }
        ).c
        console.log('[trips-test] photos encore actives après détection (doit être 24, rien modifié):', stillActiveCount)

        // 2) Création réelle des albums pour les groupes proposés (comme le
        //    fait le bouton « Créer » de l'écran de review, mêmes appels IPC)
        let albumsCreated = 0
        for (const g of groups as Array<{ suggestedName: string; photoIds: number[] }>) {
          const { id } = await mainWindow.webContents.executeJavaScript(
            `window.api.invoke('albums:create', { name: ${JSON.stringify(g.suggestedName)} })`
          )
          await mainWindow.webContents.executeJavaScript(
            `window.api.invoke('albums:addPhotos', { albumId: ${id}, photoIds: ${JSON.stringify(g.photoIds)} })`
          )
          albumsCreated++
        }
        const albumRows = db
          .prepare(
            `SELECT a.id, a.name, COUNT(ai.photo_id) c FROM albums a
             JOIN album_items ai ON ai.album_id = a.id GROUP BY a.id`
          )
          .all()
        console.log('[trips-test] albums créés en base:', JSON.stringify(albumRows))
        console.log('[trips-test] albums créés (attendu 5):', albumsCreated)

        console.log('[trips-test] TERMINÉ')
        exitTest(0)
      }
    }, 500)
  }

  // Test headless du renommage en lot : PICALIBRE_TEST_RENAME=<dossier>
  const renameTestDir = process.env.PICALIBRE_TEST_RENAME
  if (renameTestDir) {
    getDb().prepare('INSERT OR IGNORE INTO scan_roots (path) VALUES (?)').run(renameTestDir)
    startScan(mainWindow)
    const t0r = Date.now()
    const ivr = setInterval(async () => {
      const q = (sql: string): number => (getDb().prepare(sql).get() as { c: number }).c
      const photos = q('SELECT COUNT(*) c FROM photos')
      const thumbs = q('SELECT COUNT(*) c FROM thumbnails')
      if ((photos > 0 && thumbs >= photos * 2) || Date.now() - t0r > 60000) {
        clearInterval(ivr)
        const db = getDb()
        const rows = db
          .prepare("SELECT id, filepath, filename FROM photos WHERE status = 'active' ORDER BY id LIMIT 5")
          .all() as Array<{ id: number; filepath: string; filename: string }>
        const ids = rows.map((r) => r.id)
        console.log('[rename-test] avant:', JSON.stringify(rows))
        const result = await mainWindow.webContents.executeJavaScript(
          `window.api.invoke('photos:batchRename', { photoIds: ${JSON.stringify(ids)}, pattern: 'Test_{n}_{name}', startNumber: 1 })`
        )
        console.log('[rename-test] résultat renommage:', JSON.stringify(result))
        const after = db
          .prepare(`SELECT id, filepath, filename FROM photos WHERE id IN (${ids.join(',')}) ORDER BY id`)
          .all()
        console.log('[rename-test] après (BDD):', JSON.stringify(after))
        // Vérifier sur le disque
        const fs = await import('node:fs/promises')
        for (const r of result.renamed) {
          const exists = await fs
            .access(r.newPath)
            .then(() => true)
            .catch(() => false)
          const oldGone = await fs
            .access(r.oldPath)
            .then(() => false)
            .catch(() => true)
          console.log(`[rename-test] disque id=${r.id} nouveau existe=${exists} ancien absent=${oldGone}`)
        }
        // Annuler
        await mainWindow.webContents.executeJavaScript(
          `window.api.invoke('photos:undoBatchRename', ${JSON.stringify(result.renamed)})`
        )
        const restored = db
          .prepare(`SELECT id, filepath, filename FROM photos WHERE id IN (${ids.join(',')}) ORDER BY id`)
          .all()
        console.log('[rename-test] après annulation (BDD):', JSON.stringify(restored))
        for (const r of result.renamed) {
          const oldExists = await fs
            .access(r.oldPath)
            .then(() => true)
            .catch(() => false)
          console.log(`[rename-test] disque id=${r.id} ancien restauré=${oldExists}`)
        }
        console.log('[rename-test] TERMINÉ')
        exitTest(0)
      }
    }, 500)
  }

  // Test headless de l'édition en lot : PICALIBRE_TEST_BATCHEDIT=<dossier>
  const batchEditDir = process.env.PICALIBRE_TEST_BATCHEDIT
  if (batchEditDir) {
    getDb().prepare('INSERT OR IGNORE INTO scan_roots (path) VALUES (?)').run(batchEditDir)
    startScan(mainWindow)
    const t0b = Date.now()
    const ivb = setInterval(async () => {
      const q = (sql: string): number => (getDb().prepare(sql).get() as { c: number }).c
      const photos = q('SELECT COUNT(*) c FROM photos')
      const thumbs = q('SELECT COUNT(*) c FROM thumbnails')
      if ((photos > 0 && thumbs >= photos * 2) || Date.now() - t0b > 60000) {
        clearInterval(ivb)
        const db = getDb()
        const rows = db
          .prepare("SELECT id FROM photos WHERE status = 'active' ORDER BY id LIMIT 4")
          .all() as Array<{ id: number }>
        const ids = rows.map((r) => r.id)

        // 1) Correction auto en lot
        const autoResult = await mainWindow.webContents.executeJavaScript(
          `window.api.invoke('edits:batchAutoFix', { photoIds: ${JSON.stringify(ids)} })`
        )
        console.log('[batchedit-test] auto-fix:', JSON.stringify(autoResult))
        const afterAuto = db
          .prepare(`SELECT photo_id, current_stack FROM edits WHERE photo_id IN (${ids.join(',')})`)
          .all()
        console.log('[batchedit-test] stacks après auto-fix:', JSON.stringify(afterAuto))

        // 2) Annuler
        await mainWindow.webContents.executeJavaScript(
          `window.api.invoke('edits:undoBatch', ${JSON.stringify(autoResult.before)})`
        )
        const afterUndo = db
          .prepare(`SELECT photo_id, current_stack FROM edits WHERE photo_id IN (${ids.join(',')})`)
          .all()
        console.log('[batchedit-test] stacks après annulation:', JSON.stringify(afterUndo))

        // 3) Coller des réglages (stack fictif : filtre sépia + vignette)
        const pasteResult = await mainWindow.webContents.executeJavaScript(
          `window.api.invoke('edits:batchApply', {
            photoIds: ${JSON.stringify(ids)},
            stack: { version: 1, ops: [
              { type: 'filter', params: { name: 'sepia', intensity: 0.7 } },
              { type: 'vignette', params: { intensity: 0.5 } }
            ] },
            action: 'test_paste'
          })`
        )
        const afterPaste = db
          .prepare(`SELECT photo_id, current_stack FROM edits WHERE photo_id IN (${ids.join(',')})`)
          .all()
        console.log('[batchedit-test] stacks après coller réglages:', JSON.stringify(afterPaste))
        console.log('[batchedit-test] TERMINÉ')
        exitTest(0)
      }
    }, 500)
  }

  // Test headless de LECTURE vidéo réelle (pas juste la génération de
  // vignette) : PICALIBRE_TEST_VIDEO_PLAYBACK=<dossier>
  // Ouvre la Lightbox sur la vidéo et inspecte l'état réel de <video>
  // après une tentative de lecture (error, readyState, dimensions).
  const videoPlaybackDir = process.env.PICALIBRE_TEST_VIDEO_PLAYBACK
  if (videoPlaybackDir) {
    getDb().prepare('INSERT OR IGNORE INTO scan_roots (path) VALUES (?)').run(videoPlaybackDir)
    startScan(mainWindow)
    const t0v = Date.now()
    const ivv = setInterval(async () => {
      const q = (sql: string): number => (getDb().prepare(sql).get() as { c: number }).c
      const photos = q('SELECT COUNT(*) c FROM photos')
      const thumbs = q('SELECT COUNT(*) c FROM thumbnails')
      // Attendre aussi que la phase proxy ait fini de traiter chaque vidéo
      // (fichier _proxy.mp4 OU marqueur _proxy.mp4.skip présent) — sinon le
      // test de lecture peut tomber pile pendant le transcodage.
      const videos = getDb()
        .prepare("SELECT hash_xxh3 FROM photos WHERE media_type='video' AND status='active'")
        .all() as { hash_xxh3: string }[]
      const fsp = await import('node:fs/promises')
      let proxyReady = true
      for (const v of videos) {
        const base = join(thumbsCacheDir(), v.hash_xxh3.slice(0, 2), `${v.hash_xxh3}_proxy.mp4`)
        const has = await fsp
          .access(base)
          .then(() => true)
          .catch(() => false)
        const skipped = await fsp
          .access(base + '.skip')
          .then(() => true)
          .catch(() => false)
        if (!has && !skipped) proxyReady = false
      }
      if ((photos > 0 && thumbs >= photos * 2 && (videos.length === 0 || proxyReady)) || Date.now() - t0v > 60000) {
        clearInterval(ivv)
        await mainWindow.webContents.executeJavaScript(
          `(() => { const el = [...document.querySelectorAll('aside div')].find(d => d.textContent.includes('Chronologie')); if (el) el.click(); })()`
        )
        setTimeout(async () => {
          await mainWindow.webContents.executeJavaScript(
            `(() => { const im = document.querySelector('main figure canvas'); if (im) im.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })()`
          )
          setTimeout(async () => {
            // Tenter la lecture explicitement, attendre un peu, puis inspecter
            const result = await mainWindow.webContents.executeJavaScript(
              `(async () => {
                const v = document.querySelector('video')
                if (!v) return { found: false }
                let playError = null
                try { await v.play() } catch (e) { playError = e.message }
                await new Promise(r => setTimeout(r, 2000))
                return {
                  found: true,
                  readyState: v.readyState,
                  networkState: v.networkState,
                  videoWidth: v.videoWidth,
                  videoHeight: v.videoHeight,
                  currentTime: v.currentTime,
                  paused: v.paused,
                  error: v.error ? { code: v.error.code, message: v.error.message } : null,
                  playError,
                  duration: v.duration
                }
              })()`
            )
            console.log('[video-playback-test] RÉSULTAT:', JSON.stringify(result, null, 2))
            exitTest(0)
          }, 1000)
        }, 1500)
      }
    }, 500)
  }

  // Test headless extraction de frame + découpe vidéo :
  // PICALIBRE_TEST_VIDEO_FEATURES=<dossier>
  const videoFeaturesDir = process.env.PICALIBRE_TEST_VIDEO_FEATURES
  if (videoFeaturesDir) {
    getDb().prepare('INSERT OR IGNORE INTO scan_roots (path) VALUES (?)').run(videoFeaturesDir)
    startScan(mainWindow)
    const t0f = Date.now()
    const ivf = setInterval(async () => {
      const q = (sql: string): number => (getDb().prepare(sql).get() as { c: number }).c
      const photos = q('SELECT COUNT(*) c FROM photos')
      const thumbs = q('SELECT COUNT(*) c FROM thumbnails')
      if ((photos > 0 && thumbs >= photos * 2) || Date.now() - t0f > 60000) {
        clearInterval(ivf)
        const db = getDb()
        const video = db
          .prepare("SELECT id FROM photos WHERE media_type='video' AND status='active' LIMIT 1")
          .get() as { id: number } | undefined
        if (!video) {
          console.log('[video-features-test] aucune vidéo trouvée')
          exitTest(1)
          return
        }

        // 1) Extraction d'image fixe à 2 secondes
        const before = q('SELECT COUNT(*) c FROM photos')
        const extractResult = await mainWindow.webContents.executeJavaScript(
          `window.api.invoke('video:extractFrame', { photoId: ${video.id}, atSeconds: 2 })`
        )
        console.log('[video-features-test] extraction:', JSON.stringify(extractResult))
        // Attendre que le rescan déclenché par extractFrame ajoute la photo
        const t0e = Date.now()
        let after = before
        while (Date.now() - t0e < 15000) {
          await new Promise((r) => setTimeout(r, 500))
          after = q('SELECT COUNT(*) c FROM photos')
          if (after > before) break
        }
        console.log('[video-features-test] photos avant=', before, 'après=', after)

        // 2) Découpe vidéo : définir trim puis vérifier en base
        await mainWindow.webContents.executeJavaScript(
          `window.api.invoke('photos:setTrim', { photoId: ${video.id}, trimStartMs: 1000, trimEndMs: 3000 })`
        )
        const trimRow = db
          .prepare('SELECT trim_start_ms, trim_end_ms FROM photos WHERE id = ?')
          .get(video.id)
        console.log('[video-features-test] trim en base:', JSON.stringify(trimRow))

        // 3) Vérification UI réelle : ouvrir la Lightbox sur la vidéo et
        // contrôler la présence des boutons (dans la VRAIE fenêtre, avec
        // toute l'initialisation de l'app — pas un script autonome).
        await mainWindow.webContents.executeJavaScript(
          `(() => { const el = [...document.querySelectorAll('aside div')].find(d => d.textContent.includes('Chronologie')); if (el) el.click(); })()`
        )
        await new Promise((r) => setTimeout(r, 800))
        await mainWindow.webContents.executeJavaScript(
          `(() => {
            const figs = [...document.querySelectorAll('main figure')]
            const videoFig = figs.find(f => f.textContent.includes('🎬'))
            const c = videoFig ? videoFig.querySelector('canvas') : null
            if (c) c.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
          })()`
        )
        await new Promise((r) => setTimeout(r, 1500))
        const uiState = await mainWindow.webContents.executeJavaScript(
          `(() => ({
            hasVideoTag: !!document.querySelector('video'),
            extractBtn: !!([...document.querySelectorAll('button')].find(b => b.textContent.includes('Extraire cette image'))),
            trimBar: !!([...document.querySelectorAll('span')].find(s => s.textContent.includes('Découpe')))
          }))()`
        )
        console.log('[video-features-test] UI:', JSON.stringify(uiState))

        console.log('[video-features-test] TERMINÉ')
        exitTest(0)
      }
    }, 500)
  }

  // Test headless des onglets de l'éditeur : PICALIBRE_TEST_EDITOR_TABS=<dossier>
  const editorTabsDir = process.env.PICALIBRE_TEST_EDITOR_TABS
  if (editorTabsDir) {
    getDb().prepare('INSERT OR IGNORE INTO scan_roots (path) VALUES (?)').run(editorTabsDir)
    startScan(mainWindow)
    const t0t = Date.now()
    const ivt = setInterval(async () => {
      const q = (sql: string): number => (getDb().prepare(sql).get() as { c: number }).c
      const photos = q('SELECT COUNT(*) c FROM photos')
      const thumbs = q('SELECT COUNT(*) c FROM thumbnails')
      if ((photos > 0 && thumbs >= photos * 2) || Date.now() - t0t > 60000) {
        clearInterval(ivt)
        await mainWindow.webContents.executeJavaScript(
          `(() => { const el = [...document.querySelectorAll('aside div')].find(d => d.textContent.includes('Chronologie')); if (el) el.click(); })()`
        )
        await new Promise((r) => setTimeout(r, 800))
        await mainWindow.webContents.executeJavaScript(
          `(() => { const im = document.querySelector('main figure canvas'); if (im) im.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })()`
        )
        await new Promise((r) => setTimeout(r, 1200))
        await mainWindow.webContents.executeJavaScript(
          `(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('Éditer')); if (b) b.click(); })()`
        )
        await new Promise((r) => setTimeout(r, 1000))

        const countVisibleSliders = `[...document.querySelectorAll('input[type=range]')].length`

        // 1) Onglet par défaut (Réglages) : combien de curseurs visibles ?
        const tuningCount = await mainWindow.webContents.executeJavaScript(countVisibleSliders)
        const hasEffectsGridInTuning = await mainWindow.webContents.executeJavaScript(
          `document.body.textContent.includes('EFFETS AVANCÉS')`
        )

        // 2) Cliquer l'onglet Effets
        await mainWindow.webContents.executeJavaScript(
          `(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Effets'); if (b) b.click(); })()`
        )
        await new Promise((r) => setTimeout(r, 300))
        const effectsTabSliderCount = await mainWindow.webContents.executeJavaScript(countVisibleSliders)
        const hasEffectsGrid = await mainWindow.webContents.executeJavaScript(
          `document.body.textContent.includes('EFFETS AVANCÉS')`
        )
        const hasFiltresContent = await mainWindow.webContents.executeJavaScript(
          `!!([...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Sépia'))`
        )

        // 3) Activer l'effet Flou et vérifier qu'un curseur apparaît
        await mainWindow.webContents.executeJavaScript(
          `(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('🌫 Flou')); if (b) b.click(); })()`
        )
        await new Promise((r) => setTimeout(r, 300))
        const afterActivateBlur = await mainWindow.webContents.executeJavaScript(countVisibleSliders)
        const hasBlurSlider = await mainWindow.webContents.executeJavaScript(
          `document.body.textContent.includes('Flou — Rayon')`
        )

        // 4) Cliquer l'onglet Filtres : vérifier que Effets avancés a disparu
        await mainWindow.webContents.executeJavaScript(
          `(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Filtres'); if (b) b.click(); })()`
        )
        await new Promise((r) => setTimeout(r, 300))
        const hasEffectsInFiltresTab = await mainWindow.webContents.executeJavaScript(
          `document.body.textContent.includes('EFFETS AVANCÉS')`
        )
        const hasSepiaInFiltresTab = await mainWindow.webContents.executeJavaScript(
          `!!([...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Sépia'))`
        )

        console.log(
          '[editor-tabs-test]',
          JSON.stringify({
            tuningCount,
            hasEffectsGridInTuning,
            effectsTabSliderCount,
            hasEffectsGrid,
            hasFiltresContent,
            afterActivateBlur,
            hasBlurSlider,
            hasEffectsInFiltresTab,
            hasSepiaInFiltresTab
          })
        )
        console.log('[editor-tabs-test] TERMINÉ')
        exitTest(0)
      }
    }, 500)
  }

  // Test headless : contraste du texte de la Lightbox en thème clair
  // (bug signalé : texte gris/sombre illisible sur le fond toujours
  // sombre de la Lightbox). PICALIBRE_TEST_LIGHTBOX_CONTRAST=<dossier>
  const lbContrastDir = process.env.PICALIBRE_TEST_LIGHTBOX_CONTRAST
  if (lbContrastDir) {
    getDb().prepare('INSERT OR IGNORE INTO scan_roots (path) VALUES (?)').run(lbContrastDir)
    startScan(mainWindow)
    const t0c = Date.now()
    const ivc = setInterval(async () => {
      const q = (sql: string): number => (getDb().prepare(sql).get() as { c: number }).c
      const photos = q('SELECT COUNT(*) c FROM photos')
      const thumbs = q('SELECT COUNT(*) c FROM thumbnails')
      if ((photos > 0 && thumbs >= photos * 2) || Date.now() - t0c > 60000) {
        clearInterval(ivc)
        const theme = await mainWindow.webContents.executeJavaScript(
          `document.documentElement.dataset.theme || 'light (par défaut)'`
        )
        await mainWindow.webContents.executeJavaScript(
          `(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Passer'); if (b) b.click(); })()`
        )
        await new Promise((r) => setTimeout(r, 300))
        await mainWindow.webContents.executeJavaScript(
          `(() => { const el = [...document.querySelectorAll('aside div')].find(d => d.textContent.includes('Chronologie')); if (el) el.click(); })()`
        )
        await new Promise((r) => setTimeout(r, 800))
        await mainWindow.webContents.executeJavaScript(
          `(() => { const im = document.querySelector('main figure canvas'); if (im) im.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })()`
        )
        await new Promise((r) => setTimeout(r, 1200))
        const colors = await mainWindow.webContents.executeJavaScript(
          `(() => {
            const filenameSpan = [...document.querySelectorAll('span')].find(s => s.style.fontWeight === '600' && /\\.(jpg|jpeg|png)/i.test(s.textContent))
            const counterSpan = [...document.querySelectorAll('span')].find(s => /^\\d+ \\/ \\d+$/.test(s.textContent.trim()))
            const topBar = filenameSpan ? filenameSpan.closest('div') : null
            return {
              filenameFound: !!filenameSpan,
              filenameColor: filenameSpan ? getComputedStyle(filenameSpan).color : null,
              filenameText: filenameSpan ? filenameSpan.textContent : null,
              counterFound: !!counterSpan,
              counterColor: counterSpan ? getComputedStyle(counterSpan).color : null,
              topBarBg: topBar ? getComputedStyle(topBar).backgroundColor : null
            }
          })()`
        )
        console.log('[lightbox-contrast-test] thème:', theme, '—', JSON.stringify(colors))
        console.log('[lightbox-contrast-test] TERMINÉ')
        exitTest(0)
      }
    }, 500)
  }

  // Test headless du bug de grille signalé : dossier → Réglages → retour
  // au dossier → les vignettes se chevauchaient (virtualiseur désynchronisé
  // après démontage/remontage de son conteneur). PICALIBRE_TEST_GRID_REMOUNT=<dossier>
  const gridRemountDir = process.env.PICALIBRE_TEST_GRID_REMOUNT
  if (gridRemountDir) {
    getDb().prepare('INSERT OR IGNORE INTO scan_roots (path) VALUES (?)').run(gridRemountDir)
    startScan(mainWindow)
    const t0g = Date.now()
    const ivg = setInterval(async () => {
      const q = (sql: string): number => (getDb().prepare(sql).get() as { c: number }).c
      const photos = q('SELECT COUNT(*) c FROM photos')
      const thumbs = q('SELECT COUNT(*) c FROM thumbnails')
      if ((photos > 0 && thumbs >= photos * 2) || Date.now() - t0g > 60000) {
        clearInterval(ivg)
        // 1) Aller dans le dossier
        await mainWindow.webContents.executeJavaScript(
          `(() => { const el = [...document.querySelectorAll('aside div')].find(d => d.textContent.includes('Chronologie')); if (el) el.click(); })()`
        )
        await new Promise((r) => setTimeout(r, 800))

        const measureOverlap = `(() => {
          const figs = [...document.querySelectorAll('main figure')]
          const rects = figs.map(f => f.getBoundingClientRect())
          let overlaps = 0
          for (let i = 0; i < rects.length; i++) {
            for (let j = i + 1; j < rects.length; j++) {
              const a = rects[i], b = rects[j]
              const ox = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
              const oy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
              if (ox > 5 && oy > 5) overlaps++
            }
          }
          return { count: figs.length, overlaps }
        })()`

        const before = await mainWindow.webContents.executeJavaScript(measureOverlap)
        console.log('[grid-remount-test] avant (dossier initial):', JSON.stringify(before))

        // 2) Aller dans Réglages (démonte la grille)
        await mainWindow.webContents.executeJavaScript(
          `(() => { const el = [...document.querySelectorAll('aside div')].find(d => d.textContent.includes('Réglages')); if (el) el.click(); })()`
        )
        await new Promise((r) => setTimeout(r, 500))

        // 3) Revenir dans le dossier (remonte la grille)
        await mainWindow.webContents.executeJavaScript(
          `(() => { const el = [...document.querySelectorAll('aside div')].find(d => d.textContent.includes('Chronologie')); if (el) el.click(); })()`
        )
        await new Promise((r) => setTimeout(r, 800))

        const after = await mainWindow.webContents.executeJavaScript(measureOverlap)
        console.log('[grid-remount-test] après (retour au dossier):', JSON.stringify(after))
        console.log('[grid-remount-test] TERMINÉ')
        exitTest(0)
      }
    }, 500)
  }

  // Test headless : retrait d'un sous-dossier, persistance après rescan,
  // annulation. PICALIBRE_TEST_FOLDER_REMOVE=<dossier avec sous-dossiers>
  const folderRemoveDir = process.env.PICALIBRE_TEST_FOLDER_REMOVE
  if (folderRemoveDir) {
    getDb().prepare('INSERT OR IGNORE INTO scan_roots (path) VALUES (?)').run(folderRemoveDir)
    startScan(mainWindow)
    const t0r = Date.now()
    const ivr = setInterval(async () => {
      const q = (sql: string): number => (getDb().prepare(sql).get() as { c: number }).c
      const photos = q('SELECT COUNT(*) c FROM photos')
      const thumbs = q('SELECT COUNT(*) c FROM thumbnails')
      if ((photos > 0 && thumbs >= photos * 2) || Date.now() - t0r > 60000) {
        clearInterval(ivr)
        const db = getDb()
        const allFolders = db
          .prepare("SELECT id, path FROM folders WHERE is_hidden = 0")
          .all() as Array<{ id: number; path: string }>
        const target = allFolders.find((f) => f.path.includes('famille'))
        if (!target) {
          console.log('[folder-remove-test] dossier "famille" introuvable', JSON.stringify(allFolders))
          exitTest(1)
          return
        }
        const before = q(`SELECT COUNT(*) c FROM photos WHERE folder_id = ${target.id} AND status='active'`)
        console.log('[folder-remove-test] photos actives avant retrait:', before)

        // 1) Retirer le dossier
        const removeResult = await mainWindow.webContents.executeJavaScript(
          `window.api.invoke('folders:remove', { folderId: ${target.id} })`
        )
        console.log('[folder-remove-test] résultat retrait:', JSON.stringify(removeResult))
        const afterRemove = q(`SELECT COUNT(*) c FROM photos WHERE folder_id = ${target.id} AND status='active'`)
        const folderHidden = (db.prepare('SELECT is_hidden FROM folders WHERE id = ?').get(target.id) as { is_hidden: number }).is_hidden
        console.log('[folder-remove-test] photos actives après retrait:', afterRemove, '| dossier masqué:', folderHidden)

        // 2) Relancer un scan complet — le dossier ne doit PAS revenir
        await new Promise((resolve) => {
          startScan(mainWindow)
          const check = setInterval(() => {
            // Un rescan de dossiers déjà connus est quasi instantané
          }, 100)
          setTimeout(() => {
            clearInterval(check)
            resolve(null)
          }, 3000)
        })
        const afterRescan = q(`SELECT COUNT(*) c FROM photos WHERE folder_id = ${target.id} AND status='active'`)
        console.log('[folder-remove-test] photos actives après RESCAN:', afterRescan, '(attendu: toujours 0)')

        // 3) Annuler
        await mainWindow.webContents.executeJavaScript(
          `window.api.invoke('folders:undoRemove', { folderId: ${target.id}, photoIds: ${JSON.stringify(removeResult.photoIds)} })`
        )
        const afterUndo = q(`SELECT COUNT(*) c FROM photos WHERE folder_id = ${target.id} AND status='active'`)
        const folderHiddenAfterUndo = (db.prepare('SELECT is_hidden FROM folders WHERE id = ?').get(target.id) as { is_hidden: number }).is_hidden
        console.log('[folder-remove-test] photos actives après ANNULATION:', afterUndo, '| dossier masqué:', folderHiddenAfterUndo)

        console.log('[folder-remove-test] TERMINÉ')
        exitTest(0)
      }
    }, 500)
  }

  // Test headless du diaporama : le transform Ken Burns de la photo qui
  // s'estompe encore ne doit plus sauter au moment où le fondu démarre.
  // PICALIBRE_TEST_SLIDESHOW=<dossier>
  const slideshowDir = process.env.PICALIBRE_TEST_SLIDESHOW
  if (slideshowDir) {
    getDb().prepare('INSERT OR IGNORE INTO scan_roots (path) VALUES (?)').run(slideshowDir)
    startScan(mainWindow)
    const t0s = Date.now()
    const ivs = setInterval(async () => {
      const q = (sql: string): number => (getDb().prepare(sql).get() as { c: number }).c
      const photos = q('SELECT COUNT(*) c FROM photos')
      const thumbs = q('SELECT COUNT(*) c FROM thumbnails')
      if ((photos > 0 && thumbs >= photos * 2) || Date.now() - t0s > 60000) {
        clearInterval(ivs)
        await mainWindow.webContents.executeJavaScript(
          `(() => { const el = [...document.querySelectorAll('aside div')].find(d => d.textContent.includes('Chronologie')); if (el) el.click(); })()`
        )
        await new Promise((r) => setTimeout(r, 800))
        const btnState = await mainWindow.webContents.executeJavaScript(
          `(() => {
            const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('Diaporama'))
            return { found: !!b, disabled: b ? b.disabled : null, text: b ? b.textContent : null }
          })()`
        )
        console.log('[slideshow-test] bouton diaporama:', JSON.stringify(btnState))
        await mainWindow.webContents.executeJavaScript(
          `(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('Diaporama')); if (b) b.click(); })()`
        )
        await new Promise((r) => setTimeout(r, 1500))

        const getActiveTransform = `(() => {
          const imgs = [...document.querySelectorAll('img')].filter(d => d.style && d.style.transform && d.style.opacity === '1')
          if (imgs.length === 0) return null
          return imgs[0].style.transform
        })()`

        const before = await mainWindow.webContents.executeJavaScript(getActiveTransform)
        console.log('[slideshow-test] transform avant next():', before)

        // Déclencher la transition (flèche droite)
        await mainWindow.webContents.executeJavaScript(
          `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))`
        )
        // Deux mesures à des instants différents PENDANT le fondu (600ms) :
        // le calque sortant doit continuer à évoluer (pas figé, pas de
        // saut), preuve que son animation n'est plus interrompue.
        await new Promise((r) => setTimeout(r, 100))
        const t1 = await mainWindow.webContents.executeJavaScript(`(() => {
          const imgs = [...document.querySelectorAll('img')].filter(d => d.style && d.style.transform)
          return imgs.map(d => ({ opacity: d.style.opacity, transform: d.style.transform }))
        })()`)
        await new Promise((r) => setTimeout(r, 300))
        const t2 = await mainWindow.webContents.executeJavaScript(`(() => {
          const imgs = [...document.querySelectorAll('img')].filter(d => d.style && d.style.transform)
          return imgs.map(d => ({ opacity: d.style.opacity, transform: d.style.transform }))
        })()`)
        console.log('[slideshow-test] calques à 100ms:', JSON.stringify(t1))
        console.log('[slideshow-test] calques à 400ms:', JSON.stringify(t2))
        console.log('[slideshow-test] TERMINÉ')
        exitTest(0)
      }
    }, 500)
  }

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
          `(() => { const im = document.querySelector('main figure canvas'); if (im) im.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })()`
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
      } else if (Date.now() - t0 > 120000) {
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
