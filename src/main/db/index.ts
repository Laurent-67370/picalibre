/**
 * DBService — SEUL point d'accès à SQLite (processus main uniquement).
 * better-sqlite3 est synchrone : les écritures se font par transactions
 * groupées pour ne jamais bloquer plus de quelques ms.
 */
import Database from 'better-sqlite3'
import { app } from 'electron'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ScannedFile } from '../../workers/scan-worker'

let db: Database.Database

export function initDb(migrationsDir: string): Database.Database {
  const dbPath = join(app.getPath('userData'), 'library.db')
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')
  runMigrations(migrationsDir)
  return db
}

function runMigrations(dir: string): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`)
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r: any) => r.version)
  )
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    const version = parseInt(file.split('_')[0], 10)
    if (applied.has(version)) continue
    const sql = readFileSync(join(dir, file), 'utf-8')
    const apply = db.transaction(() => {
      db.exec(sql)
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version)
    })
    apply()
    console.log(`[db] migration ${file} appliquée`)
  }
}

export function getDb(): Database.Database {
  return db
}

/** Carte (filepath → size/mtime) des fichiers connus, pour le rescan incrémental. */
export function getKnownFiles(): Record<string, { size: number; mtime: number }> {
  const rows = db
    .prepare(`SELECT filepath, file_size AS size, file_mtime AS mtime FROM photos WHERE status != 'trashed'`)
    .all() as { filepath: string; size: number; mtime: number }[]
  const map: Record<string, { size: number; mtime: number }> = {}
  for (const r of rows) map[r.filepath] = { size: r.size, mtime: r.mtime }
  return map
}

/** Upsert d'un lot de fichiers scannés. Retourne les IDs des dossiers touchés. */
export function upsertScannedBatch(files: ScannedFile[]): number[] {
  const folderStmt = db.prepare(
    `INSERT INTO folders (path) VALUES (?)
     ON CONFLICT(path) DO UPDATE SET last_scanned = unixepoch()
     RETURNING id`
  )
  const photoStmt = db.prepare(
    `INSERT INTO photos (folder_id, filename, filepath, media_type, hash_xxh3, file_size, file_mtime)
     VALUES (@folderId, @filename, @filepath, @mediaType, @hash, @size, @mtime)
     ON CONFLICT(filepath) DO UPDATE SET
       hash_xxh3  = CASE WHEN excluded.hash_xxh3 != '' THEN excluded.hash_xxh3 ELSE photos.hash_xxh3 END,
       file_size  = excluded.file_size,
       file_mtime = excluded.file_mtime,
       status     = 'active'`
  )
  const touched = new Set<number>()
  const tx = db.transaction((batch: ScannedFile[]) => {
    for (const f of batch) {
      const folderId = (folderStmt.get(f.folder) as { id: number }).id
      touched.add(folderId)
      photoStmt.run({
        folderId,
        filename: f.filename,
        filepath: f.filepath,
        mediaType: f.mediaType,
        hash: f.hash ?? '',
        size: f.size,
        mtime: f.mtime
      })
    }
  })
  tx(files)
  return [...touched]
}
