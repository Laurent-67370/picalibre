/**
 * Base miroir — SQLite minimal, uniquement ce que la galerie mobile affiche.
 * Aucun chemin de fichier local, aucun original : juste miniatures + méta.
 */
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.DATA_DIR || join(__dirname, '..', 'data')
mkdirSync(join(DATA_DIR, 'thumbs'), { recursive: true })

const db = new Database(join(DATA_DIR, 'mirror.db'))
db.pragma('journal_mode = WAL')
db.exec(`
  CREATE TABLE IF NOT EXISTS photos (
    id           INTEGER PRIMARY KEY,      -- id côté desktop (clé stable)
    hash         TEXT NOT NULL,
    filename     TEXT NOT NULL,
    folder_path  TEXT NOT NULL,
    media_type   TEXT NOT NULL DEFAULT 'image',
    taken_at     INTEGER,
    width        INTEGER, height INTEGER,
    rating       INTEGER NOT NULL DEFAULT 0,
    caption      TEXT,
    gps_lat      REAL, gps_lon REAL,
    tags         TEXT,                      -- CSV dénormalisé, simple et suffisant ici
    albums       TEXT,
    synced_at    INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_photos_folder ON photos(folder_path);
  CREATE INDEX IF NOT EXISTS idx_photos_taken  ON photos(taken_at DESC);

  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`)

export const upsertPhoto = db.prepare(`
  INSERT INTO photos (id, hash, filename, folder_path, media_type, taken_at, width, height, rating, caption, gps_lat, gps_lon, tags, albums, synced_at)
  VALUES (@id, @hash, @filename, @folder_path, @media_type, @taken_at, @width, @height, @rating, @caption, @gps_lat, @gps_lon, @tags, @albums, unixepoch())
  ON CONFLICT(id) DO UPDATE SET
    hash=excluded.hash, filename=excluded.filename, folder_path=excluded.folder_path,
    media_type=excluded.media_type, taken_at=excluded.taken_at, width=excluded.width, height=excluded.height,
    rating=excluded.rating, caption=excluded.caption, gps_lat=excluded.gps_lat, gps_lon=excluded.gps_lon,
    tags=excluded.tags, albums=excluded.albums, synced_at=unixepoch()
`)

export const deletePhoto = db.prepare('DELETE FROM photos WHERE id = ?')

export function thumbDir() {
  return join(DATA_DIR, 'thumbs')
}

export default db
