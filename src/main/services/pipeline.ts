/**
 * Pipeline post-scan : Scan → [EXIF] → [Thumbnails] → done
 * Chaque phase émet 'scan:progress' vers le renderer.
 */
import { utilityProcess, BrowserWindow, app } from 'electron'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { mkdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { getFfmpegPath } from '../utils/ffmpeg'
import sharp from 'sharp'
import { getDb } from '../db'
import { probeDuration } from './movie'
import { extractExifBatch } from './exif'
import { startFaceScan } from './faces'
import type { ThumbResult } from '../../workers/thumb-worker'

let running = false
let pending = false // un autre scan a demandé un pipeline pendant que le 1er tournait

export function thumbsCacheDir(): string {
  return join(app.getPath('userData'), 'cache', 'thumbs')
}

export async function runPostScanPipeline(win: BrowserWindow): Promise<void> {
  // Correctif: file d'attente. Si l'utilisateur ajoute 2 dossiers rapidement,
  // le 2e scan terminait pendant que le 1er pipeline tournait encore →
  // `running` était true → le 2e pipeline était silencieusement ignoré et
  // les miniatures du 2e lot n'étaient jamais générées.
  if (running) {
    pending = true
    return
  }
  running = true
  try {
    do {
      pending = false
      await exifPhase(win)
      await thumbsPhase(win)
      await videoThumbsPhase(win)
    } while (pending) // relance si un scan est arrivé entre-temps
    win.webContents.send('scan:progress', { phase: 'done', filesFound: 0, filesProcessed: 0 })
    win.webContents.send('library:changed', { folderIds: [] })

    // Optimisation 12 : ANALYZE périodique pour optimiser le query planner.
    // Met à jour les statistiques sur la distribution des données dans les
    // tables et index. SQLite utilise ces stats pour choisir les meilleurs
    // plans de requête (index scan vs table scan, ordre des jointures, etc.).
    // Lancé après un scan complet car les données ont potentiellement changé
    // (nouvelles photos, suppressions, mises à jour de mtime/size).
    try {
      const db = getDb()
      const t0 = Date.now()
      db.exec('ANALYZE')
      console.log(`[db] ANALYZE terminé en ${Date.now() - t0} ms`)
    } catch (err) {
      console.error('[db] ANALYZE échoué:', (err as Error).message)
    }

    // Détection de visages en tâche de fond (hors mode test headless)
    if (!process.env.PICALIBRE_TEST_SCAN) void startFaceScan(win)
  } finally {
    running = false
  }
}

/**
 * Miniatures des VIDÉOS : frame à 10 % de la durée (ffmpeg) → sharp 256/1024
 * dans le même cache adressé par hash que les images.
 */
async function videoThumbsPhase(win: BrowserWindow): Promise<void> {
  const db = getDb()
  const items = db
    .prepare(
      `SELECT p.id AS photoId, p.filepath, p.hash_xxh3 AS hash
       FROM photos p
       WHERE p.status = 'active' AND p.media_type = 'video' AND p.hash_xxh3 != ''
         AND NOT EXISTS (
           SELECT 1 FROM thumbnails t WHERE t.photo_id = p.id AND t.size = 256
         )`
    )
    .all() as { photoId: number; filepath: string; hash: string }[]
  if (items.length === 0) return

  const ff = await getFfmpegPath()
  const insertThumb = db.prepare(
    `INSERT OR REPLACE INTO thumbnails (photo_id, size, cache_path) VALUES (?, ?, ?)`
  )
  const updateMeta = db.prepare(
    `UPDATE photos SET width = COALESCE(?, width), height = COALESCE(?, height),
       duration_ms = COALESCE(?, duration_ms) WHERE id = ?`
  )

  let done = 0
  for (const item of items) {
    try {
      const dur = await probeDuration(ff, item.filepath).catch(() => 0)
      const seek = dur > 1 ? (dur * 0.1).toFixed(2) : '0'
      const tmpFrame = join(tmpdir(), `picalibre-vf-${item.photoId}.jpg`)
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(ff, [
          '-y', '-ss', seek, '-i', item.filepath,
          '-frames:v', '1', '-q:v', '3', tmpFrame
        ])
        proc.on('error', reject)
        proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`))))
      })
      const base = sharp(tmpFrame, { failOn: 'none' })
      const meta = await base.metadata()
      for (const size of [256, 1024]) {
        const cachePath = join(thumbsCacheDir(), item.hash.slice(0, 2), `${item.hash}_${size}.webp`)
        await mkdir(join(thumbsCacheDir(), item.hash.slice(0, 2)), { recursive: true })
        await base
          .clone()
          .resize(size, size, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 82 })
          .toFile(cachePath)
        insertThumb.run(item.photoId, size, cachePath)
      }
      updateMeta.run(
        meta.width ?? null,
        meta.height ?? null,
        dur > 0 ? Math.round(dur * 1000) : null,
        item.photoId
      )
      await unlink(tmpFrame).catch(() => {})
    } catch (err) {
      console.error('[video-thumb]', item.filepath, (err as Error).message)
    }
    done++
    win.webContents.send('scan:progress', {
      phase: 'thumbs',
      filesFound: items.length,
      filesProcessed: done
    })
  }
}

async function exifPhase(win: BrowserWindow): Promise<void> {
  const targets = getDb()
    .prepare(
      `SELECT id, filepath FROM photos
       WHERE status = 'active' AND taken_at IS NULL`
    )
    .all() as { id: number; filepath: string }[]
  if (targets.length === 0) return

  await extractExifBatch(targets, (done, total) => {
    win.webContents.send('scan:progress', {
      phase: 'exif',
      filesFound: total,
      filesProcessed: done
    })
  })
}

function thumbsPhase(win: BrowserWindow): Promise<void> {
  const db = getDb()
  const items = db
    .prepare(
      `SELECT p.id AS photoId, p.filepath, p.hash_xxh3 AS hash
       FROM photos p
       WHERE p.status = 'active' AND p.media_type = 'image' AND p.hash_xxh3 != ''
         AND NOT EXISTS (
           SELECT 1 FROM thumbnails t WHERE t.photo_id = p.id AND t.size = 256
         )`
    )
    .all() as { photoId: number; filepath: string; hash: string }[]
  if (items.length === 0) return Promise.resolve()

  const insertThumb = db.prepare(
    `INSERT OR REPLACE INTO thumbnails (photo_id, size, cache_path) VALUES (?, ?, ?)`
  )
  const updateDims = db.prepare(
    `UPDATE photos SET width = COALESCE(?, width), height = COALESCE(?, height) WHERE id = ?`
  )

  return new Promise((resolve) => {
    const worker = utilityProcess.fork(join(__dirname, 'thumb-worker.js'))
    worker.postMessage({ type: 'thumbs', items, cacheDir: thumbsCacheDir() })

    worker.on('message', (msg: any) => {
      switch (msg.type) {
        case 'thumb-batch': {
          const tx = db.transaction((results: ThumbResult[]) => {
            for (const r of results) {
              insertThumb.run(r.photoId, r.size, r.cachePath)
              if (r.size === 256) updateDims.run(r.width ?? null, r.height ?? null, r.photoId)
            }
          })
          tx(msg.results)
          break
        }
        case 'thumb-progress':
          win.webContents.send('scan:progress', {
            phase: 'thumbs',
            filesFound: msg.total,
            filesProcessed: msg.done
          })
          break
        case 'thumbs-done':
        case 'error':
          if (msg.type === 'error') console.error('[thumbs]', msg.message)
          worker.kill()
          resolve()
          break
      }
    })
  })
}
