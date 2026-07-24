/**
 * Pipeline post-scan : Scan → [EXIF] → [Thumbnails] → done
 * Chaque phase émet 'scan:progress' vers le renderer.
 */
import { utilityProcess, BrowserWindow, app } from 'electron'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, unlink, access } from 'node:fs/promises'
import { tmpdir, constants as osConstants, setPriority } from 'node:os'
import { getFfmpegPath, probeVideoInfo } from '../utils/ffmpeg'
import {
  ffmpegTranscodePreset,
  ffmpegTranscodeThreads,
  videoThumbConcurrency
} from '../../shared/perf-profile'
import { runPool } from './pool'
import sharp from 'sharp'
import { getDb } from '../db'
import { extractExifBatch } from './exif'
import { startFaceScan } from './faces'
import { createProgressThrottle, type ProgressSender } from './progress-throttle'
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
    // Throttle partagé par toutes les phases du pipeline (exif/thumbs) :
    // limite à ~10 événements scan:progress par seconde. Flush avant chaque
    // transition de phase et avant 'done' pour garantir le décompte final.
    const progressSender: ProgressSender = createProgressThrottle(win, 100)
    do {
      pending = false
      await exifPhase(win, progressSender)
      progressSender.flush()
      await thumbsPhase(win, progressSender)
      progressSender.flush()
      await videoThumbsPhase(win, progressSender)
      progressSender.flush()
      await videoProxyPhase()
    } while (pending) // relance si un scan est arrivé entre-temps
    progressSender.flush()
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
// Codecs vidéo que Chromium (build Electron standard, sans codecs
// propriétaires) ne décode PAS nativement — vérifié empiriquement :
// erreur DEMUXER_ERROR_NO_SUPPORTED_STREAMS sur une vraie vidéo HEVC.
// H.264/AVC, VP8/VP9 et AV1 sont lus nativement, pas besoin de proxy.
const NEEDS_PROXY_CODECS = new Set(['hevc', 'h265'])

function proxyPathFor(hash: string): string {
  return join(thumbsCacheDir(), hash.slice(0, 2), `${hash}_proxy.mp4`)
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/**
 * Proxy H.264 pour la lecture in-app des vidéos dans un codec non
 * supporté par Chromium (HEVC notamment) — le fichier original reste
 * intact sur disque, seul un proxy mis en cache (par hash, comme les
 * miniatures) est généré pour la balise <video>.
 */
/**
 * Baisse la priorité CPU d'un process ffmpeg de fond (BELOW_NORMAL, mappé
 * nice +10 sous Linux/macOS). Le transcodage et l'extraction de frames sont
 * des tâches d'arrière-plan : elles ne doivent jamais voler des cycles à
 * l'interface, surtout sur petit processeur. Best-effort (EPERM possible).
 */
function deprioritize(proc: ChildProcess): void {
  if (proc.pid == null) return
  try {
    setPriority(proc.pid, osConstants.priority.PRIORITY_BELOW_NORMAL)
  } catch {
    /* non bloquant */
  }
}

async function transcodeToH264(ffmpegPath: string, src: string, dest: string): Promise<void> {
  const tmp = dest + '.part'
  await new Promise<void>((resolve, reject) => {
    // Petite configuration : préréglage veryfast (≈ 2× moins de CPU que
    // fast pour un proxy local un peu plus gros) et un cœur laissé libre
    // pour l'interface via -threads.
    const threads = ffmpegTranscodeThreads()
    const proc = spawn(ffmpegPath, [
      '-y', '-i', src,
      ...(threads > 0 ? ['-threads', String(threads)] : []),
      '-c:v', 'libx264', '-preset', ffmpegTranscodePreset(), '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      '-f', 'mp4',
      tmp
    ])
    deprioritize(proc)
    // Une vidéo peut être longue : timeout généreux (10 min) plutôt que
    // les 20s du frame grab, mais toujours borné pour ne jamais bloquer
    // indéfiniment le pipeline en arrière-plan.
    const killTimer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error('transcodage : timeout (10 min)'))
    }, 600_000)
    proc.on('error', (err) => {
      clearTimeout(killTimer)
      reject(err)
    })
    proc.on('close', (code) => {
      clearTimeout(killTimer)
      code === 0 ? resolve() : reject(new Error(`ffmpeg transcodage ${code}`))
    })
  })
  const { rename } = await import('node:fs/promises')
  await rename(tmp, dest)
}

/**
 * Phase dédiée, séparée de videoThumbsPhase : passe sur TOUTES les vidéos
 * actives (pas seulement celles sans miniature) pour rattraper les
 * bibliothèques scannées avant ce correctif — leurs miniatures existent
 * déjà, elles ne repasseraient jamais par videoThumbsPhase sinon.
 * Marqueur `{hash}_proxy.skip` (fichier vide) pour ne sonder le codec
 * qu'une seule fois par vidéo (évite de re-spawner ffmpeg -i à chaque
 * rescan pour les vidéos déjà en H.264, la grande majorité).
 */
async function videoProxyPhase(): Promise<void> {
  const db = getDb()
  const items = db
    .prepare(
      `SELECT id AS photoId, filepath, hash_xxh3 AS hash
       FROM photos WHERE status = 'active' AND media_type = 'video' AND hash_xxh3 != ''`
    )
    .all() as { photoId: number; filepath: string; hash: string }[]
  if (items.length === 0) return

  const ff = await getFfmpegPath()
  for (const item of items) {
    const proxyPath = proxyPathFor(item.hash)
    const skipMarker = proxyPath + '.skip'
    if (await fileExists(proxyPath)) continue
    if (await fileExists(skipMarker)) continue
    try {
      const { codec } = await probeVideoInfo(ff, item.filepath)
      await mkdir(join(thumbsCacheDir(), item.hash.slice(0, 2)), { recursive: true })
      if (codec && NEEDS_PROXY_CODECS.has(codec)) {
        console.log('[video-proxy] transcodage', codec, '→ H.264 :', item.filepath)
        await transcodeToH264(ff, item.filepath, proxyPath)
      } else {
        const { writeFile } = await import('node:fs/promises')
        await writeFile(skipMarker, '')
      }
    } catch (err) {
      console.error('[video-proxy]', item.filepath, (err as Error).message)
    }
  }
}

async function videoThumbsPhase(win: BrowserWindow, progressSender: ProgressSender): Promise<void> {
  const db = getDb()
  const items = db
    .prepare(
      `SELECT p.id AS photoId, p.filepath, p.hash_xxh3 AS hash
       FROM photos p
       WHERE p.status = 'active' AND p.media_type = 'video' AND p.hash_xxh3 != ''
         AND (
           NOT EXISTS (SELECT 1 FROM thumbnails t WHERE t.photo_id = p.id AND t.size = 256)
           OR NOT EXISTS (SELECT 1 FROM thumbnails t WHERE t.photo_id = p.id AND t.size = 1024)
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

  // Parallélisé (audit item 14) : l'extraction d'une image par ffmpeg est
  // courte et surtout I/O ; les traiter une par une faisait payer N ×
  // (spawn + seek + décodage) en série. Pool de 3-4 selon la machine
  // (2 sur petite configuration) — sharp utilise déjà ses propres threads
  // derrière, inutile de saturer.
  const VIDEO_CONCURRENCY =
    Number(process.env.PICALIBRE_VIDEO_CONCURRENCY ?? '') || videoThumbConcurrency()
  let done = 0
  const t0 = Date.now()
  let active = 0
  let peak = 0
  await runPool(items, VIDEO_CONCURRENCY, async (item) => {
    active++
    peak = Math.max(peak, active)
    try {
      const { duration: dur } = await probeVideoInfo(ff, item.filepath).catch(() => ({
        duration: 0,
        codec: null as string | null
      }))
      const seek = dur > 1 ? (dur * 0.1).toFixed(2) : '0'
      const tmpFrame = join(tmpdir(), `picalibre-vf-${item.photoId}.jpg`)
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(ff, [
          '-y', '-ss', seek, '-i', item.filepath,
          '-frames:v', '1', '-q:v', '3', tmpFrame
        ])
        deprioritize(proc)
        const killTimer = setTimeout(() => {
          proc.kill('SIGKILL')
          reject(new Error('ffmpeg timeout (20s) — process tué'))
        }, 20_000)
        proc.on('error', (err) => {
          clearTimeout(killTimer)
          reject(err)
        })
        proc.on('close', (code) => {
          clearTimeout(killTimer)
          code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`))
        })
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
    active--
    progressSender.send({
      phase: 'thumbs',
      filesFound: items.length,
      filesProcessed: done
    })
  })
  if (Object.keys(process.env).some((k) => k.startsWith('PICALIBRE_TEST_'))) {
    console.log(
      `[video-thumbs] ${items.length} vidéo(s) en ${((Date.now() - t0) / 1000).toFixed(2)}s — concurrence ${VIDEO_CONCURRENCY}, pic effectif ${peak}`
    )
  }
}

async function exifPhase(win: BrowserWindow, progressSender: ProgressSender): Promise<void> {
  const targets = getDb()
    .prepare(
      `SELECT id, filepath FROM photos
       WHERE status = 'active' AND taken_at IS NULL`
    )
    .all() as { id: number; filepath: string }[]
  if (targets.length === 0) return

  await extractExifBatch(targets, (done, total) => {
    progressSender.send({
      phase: 'exif',
      filesFound: total,
      filesProcessed: done
    })
  })
}

function thumbsPhase(win: BrowserWindow, progressSender: ProgressSender): Promise<void> {
  const db = getDb()
  const items = db
    .prepare(
      `SELECT p.id AS photoId, p.filepath, p.hash_xxh3 AS hash
       FROM photos p
       WHERE p.status = 'active' AND p.media_type = 'image' AND p.hash_xxh3 != ''
         AND (
           NOT EXISTS (SELECT 1 FROM thumbnails t WHERE t.photo_id = p.id AND t.size = 256)
           OR NOT EXISTS (SELECT 1 FROM thumbnails t WHERE t.photo_id = p.id AND t.size = 1024)
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
          progressSender.send({
            phase: 'thumbs',
            filesFound: msg.total,
            filesProcessed: msg.done
          })
          break
        case 'thumbs-done':
        case 'error':
          if (msg.type === 'error') console.error('[thumbs]', msg.message)
          else if (msg.stats?.failed > 0) {
            console.error('[thumbs] terminé avec échecs :', JSON.stringify(msg.stats))
          }
          worker.kill()
          resolve()
          break
      }
    })
  })
}
