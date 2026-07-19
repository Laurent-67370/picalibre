/**
 * Import depuis appareil photo / carte SD / dossier réseau.
 * - Parcours récursif de la source
 * - Hash xxh3 de chaque fichier → DOUBLON déjà en bibliothèque = ignoré
 * - Copie vers destination/AAAA-MM (date de prise = mtime), collisions
 *   de noms résolues par suffixe
 * - La destination est ajoutée aux racines de scan puis indexée
 */
import { BrowserWindow } from 'electron'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { join, basename, extname } from 'node:path'
import { existsSync } from 'node:fs'
import { getDb } from '../db'
import { hashFile, walk } from '../utils/hash-walk'
import { startScan } from './scanner'

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
  return importFileList(win, files, destDir)
}

/** Importe une liste explicite de fichiers (drag & drop depuis l'explorateur). */
export async function importFileList(
  win: BrowserWindow,
  files: string[],
  destDir: string
): Promise<ImportStats> {
  const db = getDb()
  const hashExists = db.prepare('SELECT 1 FROM photos WHERE hash_xxh3 = ? LIMIT 1')
  const stats: ImportStats = { found: 0, copied: 0, skippedDuplicates: 0, errors: 0 }
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
