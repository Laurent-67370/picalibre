/**
 * Import depuis appareil photo / carte SD / dossier réseau.
 * - Parcours récursif de la source
 * - Hash xxh3 de chaque fichier → DOUBLON déjà en bibliothèque = ignoré
 * - Copie vers destination/AAAA-MM (date de prise = mtime), collisions
 *   de noms résolues par suffixe
 * - La destination est ajoutée aux racines de scan puis indexée
 */
import { BrowserWindow } from 'electron'
import { copyFile, mkdir, opendir, stat, open } from 'node:fs/promises'
import { join, extname, basename } from 'node:path'
import { existsSync } from 'node:fs'
import xxhash from 'xxhash-wasm'
import { getDb } from '../db'
import { startScan } from './scanner'

const MEDIA_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.heif', '.avif',
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.3gp', '.mts'
])
const HASH_CHUNK = 4 * 1024 * 1024

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

async function* walk(dir: string): AsyncGenerator<string> {
  let handle
  try {
    handle = await opendir(dir)
  } catch {
    return
  }
  for await (const entry of handle) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.')) yield* walk(full)
    } else if (entry.isFile() && MEDIA_EXT.has(extname(entry.name).toLowerCase())) {
      yield full
    }
  }
}

export interface ImportStats {
  found: number
  copied: number
  skippedDuplicates: number
  errors: number
}

export async function importFromDevice(
  win: BrowserWindow,
  sourceDir: string,
  destDir: string
): Promise<ImportStats> {
  const db = getDb()
  const hashExists = db.prepare('SELECT 1 FROM photos WHERE hash_xxh3 = ? LIMIT 1')
  const stats: ImportStats = { found: 0, copied: 0, skippedDuplicates: 0, errors: 0 }

  // Collecte préalable pour la progression
  const files: string[] = []
  for await (const f of walk(sourceDir)) files.push(f)
  stats.found = files.length

  const progress = (): void =>
    win.webContents.send('import:progress', {
      done: stats.copied + stats.skippedDuplicates + stats.errors,
      total: stats.found,
      copied: stats.copied,
      skipped: stats.skippedDuplicates
    })

  for (const filepath of files) {
    try {
      const st = await stat(filepath)
      const hash = await hashFile(filepath, st.size)
      if (hashExists.get(hash)) {
        stats.skippedDuplicates++
        progress()
        continue
      }
      const d = new Date(st.mtimeMs)
      const sub = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      const targetDir = join(destDir, sub)
      await mkdir(targetDir, { recursive: true })
      let name = basename(filepath)
      let target = join(targetDir, name)
      let n = 1
      while (existsSync(target)) {
        const ext = extname(name)
        target = join(targetDir, `${name.slice(0, -ext.length || undefined)}_${n}${ext}`)
        n++
      }
      await copyFile(filepath, target)
      stats.copied++
    } catch {
      stats.errors++
    }
    progress()
  }

  // Destination indexée (ajoutée aux racines si nécessaire)
  db.prepare(`INSERT OR IGNORE INTO scan_roots (path, mode) VALUES (?, 'watch')`).run(destDir)
  startScan(win, [destDir])
  return stats
}
