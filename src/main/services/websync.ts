/**
 * WebSyncService — pousse miniatures + métadonnées (jamais les originaux)
 * vers une instance PicaLibre Web (VPS). Incrémental : seules les photos
 * nouvelles ou dont le hash de miniature a changé sont renvoyées.
 */
import { createReadStream } from 'node:fs'
import { getDb } from '../db'
import { safeStorage } from 'electron'
import type { BrowserWindow } from 'electron'

export interface WebSyncConfig {
  url: string
  token: string
}

export interface WebSyncProgress {
  phase: 'checking' | 'metadata' | 'thumbnails' | 'done' | 'error'
  done: number
  total: number
  message?: string
}

/**
 * Chiffrement au repos du token WebSync via safeStorage (Electron).
 *
 * safeStorage s'appuie sur le trousseau de l'OS (Keychain macOS, DPAPI
 * Windows, libsecret/Linux). Le token est stocké chiffré dans settings.websync_token
 * — un dump SQLite ne suffit plus pour le récupérer.
 *
 * Helpers `encryptToken` / `decryptToken` gèrent le cas où safeStorage n'est
 * pas disponible (tête-à-tête CLI, sandbox) : on logue un avertissement et
 * on retombe sur le stockage clair pour ne pas bloquer l'app, mais le chemin
 * nominal (app graphique packagée) est toujours chiffré.
 */
function safeStorageAvailable(): boolean {
  return typeof safeStorage !== 'undefined' && safeStorage.isEncryptionAvailable()
}

function encryptToken(token: string): string {
  if (!safeStorageAvailable()) {
    console.warn('[websync] safeStorage indisponible — token stocké en clair (fallback).')
    return token
  }
  const buf = safeStorage.encryptString(token)
  // On encode en base64 pour stockage en TEXT SQLite.
  return buf.toString('base64')
}

function decryptToken(stored: string): string {
  if (!stored) return stored
  // Heuristique : un token chiffré est une chaîne base64 potentiellement
  // longue ; un token clair est généralement court. On tente safeStorage
  // d'abord ; si ça échoue (ou si la valeur n'était pas chiffrée), on
  // retourne la valeur brute — rétrocompatible avec les tokens existants.
  if (!safeStorageAvailable()) return stored
  try {
    const buf = Buffer.from(stored, 'base64')
    return safeStorage.decryptString(buf)
  } catch {
    // Probablement un token hérité non chiffré : on retourne tel quel.
    return stored
  }
}

function getConfig(): WebSyncConfig | null {
  const db = getDb()
  const url = (db.prepare("SELECT value FROM settings WHERE key='websync_url'").get() as { value: string } | undefined)?.value
  const tokenRaw = (db.prepare("SELECT value FROM settings WHERE key='websync_token'").get() as { value: string } | undefined)?.value
  if (!url || !tokenRaw) return null
  const token = decryptToken(tokenRaw)
  return url && token ? { url: url.replace(/\/$/, ''), token } : null
}

export function setConfig(cfg: WebSyncConfig): { ok: boolean; error?: string } {
  // Durcissement (audit) : le token part dans l'en-tête de chaque requête —
  // en http clair il serait lisible par n'importe quel équipement du
  // réseau. https obligatoire, à l'exception de localhost (auto-hébergement
  // sur la même machine, le trafic ne quitte pas l'hôte).
  try {
    const u = new URL(cfg.url)
    const isLocalhost = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1'
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocalhost)) {
      return { ok: false, error: 'URL en https obligatoire (http accepté uniquement pour localhost).' }
    }
  } catch {
    return { ok: false, error: 'URL invalide.' }
  }
  const db = getDb()
  const set = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
  set.run('websync_url', cfg.url.replace(/\/$/, ''))
  set.run('websync_token', encryptToken(cfg.token))
  return { ok: true }
}

export function getConfigForUi(): WebSyncConfig | null {
  return getConfig()
}

async function api<T>(cfg: WebSyncConfig, path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(cfg.url + path, {
    ...opts,
    headers: { ...(opts.headers as Record<string, string>), Authorization: `Bearer ${cfg.token}` }
  })
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`)
  return res.json() as Promise<T>
}

export async function testConnection(cfg: WebSyncConfig): Promise<{ ok: boolean; message: string }> {
  try {
    const c = await api<{ libraryName: string; photoCount: number }>(cfg, '/api/config')
    return { ok: true, message: `Connecté — « ${c.libraryName} », ${c.photoCount} photo(s) déjà synchronisée(s)` }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}

interface SyncRow {
  id: number
  hash_xxh3: string
  filename: string
  folder_path: string
  media_type: string
  taken_at: number | null
  width: number | null
  height: number | null
  rating: number
  caption: string | null
  gps_lat: number | null
  gps_lon: number | null
  tags: string | null
  albums: string | null
  cache_256: string | null
  cache_1024: string | null
  synced_hash: string | null
}

const BATCH_SIZE = 100

export async function runWebSync(
  win: BrowserWindow,
  onProgress: (p: WebSyncProgress) => void
): Promise<void> {
  const cfg = getConfig()
  if (!cfg) {
    onProgress({ phase: 'error', done: 0, total: 0, message: 'Synchronisation non configurée' })
    return
  }
  const db = getDb()

  onProgress({ phase: 'checking', done: 0, total: 0 })

  const rows = db
    .prepare(
      `SELECT
         p.id, p.hash_xxh3, p.filename, f.path AS folder_path, p.media_type,
         p.taken_at, p.width, p.height, p.rating, p.caption, p.gps_lat, p.gps_lon,
         (SELECT GROUP_CONCAT(t.name) FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.photo_id = p.id) AS tags,
         (SELECT GROUP_CONCAT(a.name) FROM album_items ai JOIN albums a ON a.id = ai.album_id WHERE ai.photo_id = p.id) AS albums,
         t256.cache_path AS cache_256, t1024.cache_path AS cache_1024,
         ws.synced_hash
       FROM photos p
       JOIN folders f ON f.id = p.folder_id
       LEFT JOIN thumbnails t256 ON t256.photo_id = p.id AND t256.size = 256
       LEFT JOIN thumbnails t1024 ON t1024.photo_id = p.id AND t1024.size = 1024
       LEFT JOIN web_sync ws ON ws.photo_id = p.id
       WHERE p.status = 'active' AND p.is_hidden = 0 AND p.hash_xxh3 != ''`
    )
    .all() as SyncRow[]

  const pending = rows.filter((r) => r.synced_hash !== r.hash_xxh3 && r.cache_256)
  const total = pending.length
  if (total === 0) {
    onProgress({ phase: 'done', done: 0, total: 0, message: 'Déjà à jour' })
    return
  }

  const markSynced = db.prepare(
    `INSERT INTO web_sync (photo_id, synced_hash, synced_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(photo_id) DO UPDATE SET synced_hash = excluded.synced_hash, synced_at = unixepoch()`
  )

  // 1. Quelles miniatures le serveur a-t-il déjà (dédup, reprise après coupure) ?
  const hashesToCheck = [...new Set(pending.map((r) => r.hash_xxh3))]
  let present = new Set<string>()
  try {
    const r = await api<{ present: string[] }>(cfg, '/api/sync/thumb-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashes: hashesToCheck })
    })
    present = new Set(r.present)
  } catch (err) {
    onProgress({ phase: 'error', done: 0, total, message: (err as Error).message })
    return
  }

  // 2. Miniatures manquantes
  onProgress({ phase: 'thumbnails', done: 0, total })
  let done = 0
  const toUpload = pending.filter((r) => !present.has(r.hash_xxh3))
  for (const row of toUpload) {
    for (const [size, path] of [
      ['256', row.cache_256],
      ['1024', row.cache_1024]
    ] as const) {
      if (!path) continue
      try {
        await fetch(`${cfg.url}/api/sync/thumb/${row.hash_xxh3}/${size}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/octet-stream' },
          // @ts-expect-error Node fetch accepte un flux Node en body via duplex
          body: createReadStream(path),
          duplex: 'half'
        })
      } catch (err) {
        console.error('[websync] échec upload miniature', row.filename, err)
      }
    }
    done++
    if (done % 5 === 0 || done === toUpload.length) {
      onProgress({ phase: 'thumbnails', done, total: toUpload.length })
    }
  }

  // 3. Métadonnées par lots
  onProgress({ phase: 'metadata', done: 0, total: pending.length })
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE)
    const items = batch.map((r) => ({
      id: r.id,
      hash: r.hash_xxh3,
      filename: r.filename,
      folder_path: r.folder_path,
      media_type: r.media_type,
      taken_at: r.taken_at,
      width: r.width,
      height: r.height,
      rating: r.rating,
      caption: r.caption,
      gps_lat: r.gps_lat,
      gps_lon: r.gps_lon,
      tags: r.tags ?? '',
      albums: r.albums ?? ''
    }))
    try {
      await api(cfg, '/api/sync/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items })
      })
      const tx = db.transaction((rs: SyncRow[]) => {
        for (const r of rs) markSynced.run(r.id, r.hash_xxh3)
      })
      tx(batch)
    } catch (err) {
      onProgress({ phase: 'error', done: i, total: pending.length, message: (err as Error).message })
      return
    }
    onProgress({ phase: 'metadata', done: Math.min(i + BATCH_SIZE, pending.length), total: pending.length })
  }

  onProgress({ phase: 'done', done: pending.length, total: pending.length })
}
