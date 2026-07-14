/**
 * DBService — SEUL point d'accès à SQLite (processus main uniquement).
 * better-sqlite3 est synchrone : les écritures se font par transactions
 * groupées pour ne jamais bloquer plus de quelques ms.
 */
import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'node:path'
import type { ScannedFile } from '../../workers/scan-worker'
import migration001 from './migrations/001_init.sql?raw'
import migration002 from './migrations/002_faces_scanned.sql?raw'
import migration003 from './migrations/003_timeline.sql?raw'
import migration004 from './migrations/004_perf_indexes.sql?raw'
import migration005 from './migrations/005_web_sync.sql?raw'
import migration006 from './migrations/006_fts_triggers.sql?raw'
import migration007 from './migrations/007_fts_folder_column.sql?raw'
import migration008 from './migrations/008_gps_columns.sql?raw'

/** Migrations embarquées dans le bundle (import Vite ?raw) — ordre croissant. */
const MIGRATIONS: Array<{ version: number; sql: string }> = [
  { version: 1, sql: migration001 },
  { version: 2, sql: migration002 },
  { version: 3, sql: migration003 },
  { version: 4, sql: migration004 },
  { version: 5, sql: migration005 },
  { version: 6, sql: migration006 },
  { version: 7, sql: migration007 },
  { version: 8, sql: migration008 }
]

let db: Database.Database

export function initDb(): Database.Database {
  const dbPath = join(app.getPath('userData'), 'library.db')
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')
  db.pragma('cache_size = -65536') // 64 Mo de cache de pages
  db.pragma('temp_store = MEMORY')
  db.pragma('mmap_size = 268435456') // 256 Mo en mmap : lectures sans syscall
  runMigrations()
  return db
}

function runMigrations(): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`)
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r: any) => r.version)
  )
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue
    const apply = db.transaction(() => {
      db.exec(m.sql)
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(m.version)
    })
    apply()
    console.log(`[db] migration ${m.version} appliquée`)
  }
}

export function getDb(): Database.Database {
  return db
}

/** Carte (filepath → size/mtime) des fichiers connus, pour le rescan incrémental.
 *  @deprecated Préférer getKnownFilesForRoots() qui ne charge que les fichiers
 *  d'une partition, réduisant l'empreinte mémoire de 50-100 Mo sur les grosses
 *  bibliothèques (500k+ photos). */
export function getKnownFiles(): Record<string, { size: number; mtime: number }> {
  const rows = db
    .prepare(`SELECT filepath, file_size AS size, file_mtime AS mtime FROM photos WHERE status != 'trashed'`)
    .all() as { filepath: string; size: number; mtime: number }[]
  const map: Record<string, { size: number; mtime: number }> = {}
  for (const r of rows) map[r.filepath] = { size: r.size, mtime: r.mtime }
  return map
}

/**
 * Carte (filepath → size/mtime) filtrée par racines de scan.
 *
 * Au lieu de charger toute la table photos en mémoire (50-100 Mo pour 500k
 * photos), cette fonction ne sélectionne que les fichiers dont le chemin
 * commence par l'une des racines de la partition. Chaque worker du scan
 * multi-worker ne reçoit ainsi que les fichiers connus de sa partition,
 * réduisant d'autant l'empreinte mémoire et la taille du message IPC.
 *
 * @param roots  Racines de scan de la partition (ex: ["/photos/vacances"])
 * @param shallow Si true, ne retourner que les fichiers directement dans roots[]
 *                (pas les sous-dossiers) — utilisé par le worker « shallow ».
 */
export function getKnownFilesForRoots(
  roots: string[],
  shallow: boolean
): Record<string, { size: number; mtime: number }> {
  if (roots.length === 0) return {}

  // Détecter le séparateur de chemin depuis les racines (les chemins viennent
  // tous de la même plateforme). Aucun de ces caractères n'est un joker LIKE.
  const sep = roots[0].includes('\\') ? '\\' : '/'

  // Construit les conditions LIKE parameterisées — une par racine.
  // shallow: filepath LIKE 'root/%' AND filepath NOT LIKE 'root/%/%'
  // recursif: filepath LIKE 'root/%'
  const cond = shallow
    ? '(filepath LIKE ? AND filepath NOT LIKE ?)'
    : 'filepath LIKE ?'
  const conditions = roots.map(() => cond).join(' OR ')

  // Construit les paramètres dans le même ordre que les conditions.
  const params: string[] = []
  for (const r of roots) {
    params.push(`${r}${sep}%`)
    if (shallow) params.push(`${r}${sep}%${sep}%`)
  }

  const rows = db
    .prepare(
      `SELECT filepath, file_size AS size, file_mtime AS mtime
       FROM photos
       WHERE status != 'trashed' AND (${conditions})`
    )
    .all(...params) as { filepath: string; size: number; mtime: number }[]

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
