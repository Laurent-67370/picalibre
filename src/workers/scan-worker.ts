/**
 * ScanWorker — exécuté dans un utilityProcess Electron (Node pur).
 *
 * Protocole (process.parentPort) :
 *   ← { type: 'scan', roots: string[], knownFiles: Record<filepath, mtime> }
 *   → { type: 'batch', files: ScannedFile[] }        (lots de 200)
 *   → { type: 'progress', filesFound, filesProcessed, currentPath }
 *   → { type: 'done', stats }
 *
 * Stratégie : un fichier déjà connu dont (size, mtime) n'a pas changé
 * n'est PAS re-hashé — c'est ce qui rend les rescans quasi instantanés.
 */
import { opendir, stat, open } from 'node:fs/promises'
import { join, extname } from 'node:path'
import xxhash from 'xxhash-wasm'

const IMAGE_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.heif', '.avif'
])
const VIDEO_EXT = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.3gp', '.mts'])
const IGNORED_DIRS = new Set(['node_modules', '.git', '.thumbnails', '@eaDir', '.picalibre'])

const BATCH_SIZE = 200
const HASH_CHUNK = 4 * 1024 * 1024 // 4 Mo

export interface ScannedFile {
  filepath: string
  folder: string
  filename: string
  mediaType: 'image' | 'video'
  size: number
  mtime: number
  hash: string | null // null = inchangé, pas re-hashé
}

interface ScanRequest {
  type: 'scan'
  roots: string[]
  knownFiles: Record<string, { size: number; mtime: number }>
}

const port = (process as any).parentPort
const send = (msg: unknown) => port.postMessage(msg)

let hasher: Awaited<ReturnType<typeof xxhash>> | null = null

async function hashFile(filepath: string, size: number): Promise<string> {
  if (!hasher) hasher = await xxhash()
  const h = hasher.create64()
  const fh = await open(filepath, 'r')
  try {
    const buf = Buffer.allocUnsafe(Math.min(HASH_CHUNK, size || 1))
    let pos = 0
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos)
      if (bytesRead <= 0) break
      h.update(buf.subarray(0, bytesRead))
      pos += bytesRead
    }
  } finally {
    await fh.close()
  }
  return h.digest().toString(16).padStart(16, '0')
}

function mediaTypeOf(ext: string): 'image' | 'video' | null {
  if (IMAGE_EXT.has(ext)) return 'image'
  if (VIDEO_EXT.has(ext)) return 'video'
  return null
}

async function* walk(dir: string): AsyncGenerator<string> {
  let handle
  try {
    handle = await opendir(dir)
  } catch {
    return // permissions, dossier disparu…
  }
  for await (const entry of handle) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && !IGNORED_DIRS.has(entry.name)) {
        yield* walk(full)
      }
    } else if (entry.isFile()) {
      yield full
    }
  }
}

async function runScan(req: ScanRequest): Promise<void> {
  let filesFound = 0
  let filesProcessed = 0
  let unchanged = 0
  let batch: ScannedFile[] = []

  const flush = () => {
    if (batch.length > 0) {
      send({ type: 'batch', files: batch })
      batch = []
    }
  }

  for (const root of req.roots) {
    for await (const filepath of walk(root)) {
      const ext = extname(filepath).toLowerCase()
      const mediaType = mediaTypeOf(ext)
      if (!mediaType) continue
      filesFound++

      let st
      try {
        st = await stat(filepath)
      } catch {
        continue
      }
      const mtime = Math.floor(st.mtimeMs / 1000)
      const known = req.knownFiles[filepath]
      const isUnchanged = known && known.size === st.size && known.mtime === mtime

      let hash: string | null = null
      if (isUnchanged) {
        unchanged++
      } else {
        try {
          hash = await hashFile(filepath, st.size)
        } catch {
          continue
        }
      }

      const sep = filepath.lastIndexOf('/') >= 0 ? '/' : '\\'
      const idx = filepath.lastIndexOf(sep)
      batch.push({
        filepath,
        folder: filepath.slice(0, idx),
        filename: filepath.slice(idx + 1),
        mediaType,
        size: st.size,
        mtime,
        hash
      })

      filesProcessed++
      if (batch.length >= BATCH_SIZE) flush()
      if (filesProcessed % 500 === 0) {
        send({ type: 'progress', filesFound, filesProcessed, currentPath: filepath })
      }
    }
  }
  flush()
  send({ type: 'done', stats: { filesFound, filesProcessed, unchanged } })
}

port.on('message', (e: { data: ScanRequest }) => {
  if (e.data?.type === 'scan') {
    runScan(e.data).catch((err: Error) =>
      send({ type: 'error', message: err.message, stack: err.stack })
    )
  }
})
