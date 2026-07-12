/**
 * Pipeline post-scan : Scan → [EXIF] → [Thumbnails] → done
 * Chaque phase émet 'scan:progress' vers le renderer.
 */
import { utilityProcess, BrowserWindow, app } from 'electron'
import { join } from 'node:path'
import { getDb } from '../db'
import { extractExifBatch } from './exif'
import { startFaceScan } from './faces'
import type { ThumbResult } from '../../workers/thumb-worker'

let running = false

export function thumbsCacheDir(): string {
  return join(app.getPath('userData'), 'cache', 'thumbs')
}

export async function runPostScanPipeline(win: BrowserWindow): Promise<void> {
  if (running) return
  running = true
  try {
    await exifPhase(win)
    await thumbsPhase(win)
    win.webContents.send('scan:progress', { phase: 'done', filesFound: 0, filesProcessed: 0 })
    win.webContents.send('library:changed', { folderIds: [] })
    // Détection de visages en tâche de fond (hors mode test headless)
    if (!process.env.PICALIBRE_TEST_SCAN) void startFaceScan(win)
  } finally {
    running = false
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
