/**
 * ThumbWorker — utilityProcess dédié aux miniatures (sharp/libvips).
 *
 * Protocole (process.parentPort) :
 *   ← { type: 'thumbs', items: ThumbItem[], cacheDir: string }
 *   → { type: 'thumb-batch', results: ThumbResult[] }   (lots de 50)
 *   → { type: 'thumb-progress', done, total }
 *   → { type: 'thumbs-done', stats }
 *
 * Cache adressé par HASH de contenu (pas par chemin) :
 *   {cacheDir}/{h2}/{hash}_{size}.webp
 * → déplacer un fichier ne régénère jamais sa miniature.
 */
import sharp from 'sharp'
import { mkdir, access, unlink } from 'node:fs/promises'
import { join, dirname, extname } from 'node:path'
import { cpus, tmpdir } from 'node:os'
import { exiftool } from 'exiftool-vendored'

const SIZES = [256, 1024] as const
const QUALITY = 82
const CONCURRENCY = Math.max(2, (cpus().length || 4) - 1)
const RESULT_BATCH = 50

// Extensions RAW et PSD qui peuvent nécessiter un fallback exiftool
// quand sharp/libvips ne sait pas décoder le fichier directement.
const RAW_PSD_EXT = new Set([
  '.cr2', '.nef', '.arw', '.raf', '.orf', '.dng', '.psd'
])

export interface ThumbItem {
  photoId: number
  filepath: string
  hash: string
}

export interface ThumbResult {
  photoId: number
  size: number
  cachePath: string
  width?: number
  height?: number
  ok: boolean
  error?: string
}

const port = (process as any).parentPort
const send = (m: unknown) => port.postMessage(m)

function cachePathFor(cacheDir: string, hash: string, size: number): string {
  return join(cacheDir, hash.slice(0, 2), `${hash}_${size}.webp`)
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/**
 * Fallback exiftool : extrait la preview JPEG embarquée des fichiers RAW
 * et PSD quand sharp/libvips ne peut pas décoder le fichier directement.
 * - extractJpgFromRaw : JPEG embarqué dans les RAW (CR2, NEF, ARW…)
 * - extractPreview : preview JPEG pour PSD et certains RAW avec preview
 * Retourne un chemin temporaire vers le JPEG extrait, ou null si échec.
 */
async function extractEmbeddedPreview(filepath: string, photoId: number): Promise<string | null> {
  const tmpFile = join(tmpdir(), `picalibre-prev-${photoId}-${Date.now()}.jpg`)
  try {
    await exiftool.extractJpgFromRaw(filepath, tmpFile)
    return tmpFile
  } catch {
    // JpgFromRaw non disponible → essayer PreviewImage (PSD, certains RAW)
  }
  try {
    await exiftool.extractPreview(filepath, tmpFile)
    return tmpFile
  } catch {
    // les deux méthodes ont échoué
  }
  await unlink(tmpFile).catch(() => {})
  return null
}

async function processItem(item: ThumbItem, cacheDir: string): Promise<ThumbResult[]> {
  const out: ThumbResult[] = []
  const ext = extname(item.filepath).toLowerCase()
  const needsFallback = RAW_PSD_EXT.has(ext)

  let sourcePath = item.filepath
  let tmpPreview: string | null = null

  try {
    // .rotate() sans argument applique l'orientation EXIF
    let base = sharp(sourcePath, { failOn: 'none' }).rotate()
    let meta: sharp.Metadata
    try {
      meta = await base.metadata()
    } catch (metaErr) {
      // sharp/libvips ne sait pas du tout décoder ce format (RAW propriétaire,
      // PSD sans plugin) : il lève une exception ici plutôt que de renvoyer
      // {width: undefined}. C'est le cas RÉEL le plus fréquent pour RAW/PSD
      // avec la distribution npm standard de sharp (sans libvips-raw/psd).
      if (!needsFallback) throw metaErr
      meta = {} as sharp.Metadata
    }

    // Si sharp ne peut pas lire les dimensions (exception ci-dessus, ou objet
    // vide silencieux selon la version de libvips), c'est qu'il ne supporte
    // pas ce format → fallback exiftool pour extraire la preview embarquée
    if ((!meta.width || !meta.height) && needsFallback) {
      tmpPreview = await extractEmbeddedPreview(sourcePath, item.photoId)
      if (tmpPreview) {
        sourcePath = tmpPreview
        base = sharp(sourcePath, { failOn: 'none' }).rotate()
        meta = await base.metadata()
      }
    }

    for (const size of SIZES) {
      const cachePath = cachePathFor(cacheDir, item.hash, size)
      if (!(await exists(cachePath))) {
        await mkdir(dirname(cachePath), { recursive: true })
        await base
          .clone()
          .resize(size, size, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: QUALITY })
          .toFile(cachePath)
      }
      out.push({
        photoId: item.photoId,
        size,
        cachePath,
        width: meta.width,
        height: meta.height,
        ok: true
      })
    }
  } catch (err) {
    out.push({
      photoId: item.photoId,
      size: 0,
      cachePath: '',
      ok: false,
      error: (err as Error).message
    })
  } finally {
    // Nettoyer le fichier temporaire de la preview exiftool
    if (tmpPreview) await unlink(tmpPreview).catch(() => {})
  }
  return out
}

async function run(items: ThumbItem[], cacheDir: string): Promise<void> {
  let done = 0
  let failed = 0
  let pending: ThumbResult[] = []

  const flush = () => {
    if (pending.length > 0) {
      send({ type: 'thumb-batch', results: pending })
      pending = []
    }
  }

  // Pool de concurrence simple
  const queue = [...items]
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()
      if (!item) break
      let results = await processItem(item, cacheDir)
      if (results.some((r) => !r.ok)) {
        // Retry unique : les échecs sharp/libvips observés sont parfois
        // transitoires (contention CPU/mémoire sous charge, cf. le pipeline
        // vidéo qui traite le même genre de fichiers en parallèle). Sans ce
        // retry, un item raté était compté (stats.failed) mais jamais
        // rejoué ni logué — silencieusement absent du résultat final.
        const err = results.find((r) => !r.ok)?.error
        console.error(`[thumb-worker] échec photoId=${item.photoId} (nouvelle tentative) :`, err)
        results = await processItem(item, cacheDir)
        if (results.some((r) => !r.ok)) {
          failed++
          console.error(
            `[thumb-worker] échec définitif photoId=${item.photoId} :`,
            results.find((r) => !r.ok)?.error
          )
        }
      }
      pending.push(...results.filter((r) => r.ok))
      if (pending.length >= RESULT_BATCH) flush()
      done++
      if (done % 100 === 0) send({ type: 'thumb-progress', done, total: items.length })
    }
  })
  await Promise.all(workers)
  flush()
  send({ type: 'thumbs-done', stats: { total: items.length, done, failed } })
}

port.on('message', (e: { data: { type: string; items: ThumbItem[]; cacheDir: string } }) => {
  if (e.data?.type === 'thumbs') {
    run(e.data.items, e.data.cacheDir).catch((err: Error) =>
      send({ type: 'error', message: err.message })
    )
  }
})
