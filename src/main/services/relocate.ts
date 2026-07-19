/**
 * Migration de bibliothèque : après déplacement des fichiers vers un nouveau
 * disque/dossier, on RELIE par hash + taille — sans jamais perdre albums,
 * tags, visages ni éditions (tout est rattaché à photo_id, qui ne change pas).
 *
 * 1. Pré-passe : les photos 'active' dont le fichier a disparu → 'missing'
 * 2. Parcours de la nouvelle racine ; seuls les fichiers dont la TAILLE
 *    correspond à une photo manquante sont hashés (économie massive)
 * 3. hash identique → filepath/folder mis à jour, statut 'active'
 */
import { BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { getDb } from '../db'
import { hashFile, walk } from '../utils/hash-walk'

export interface RelocateStats {
  markedMissing: number
  relinked: number
  stillMissing: number
}

export async function relocateLibrary(
  win: BrowserWindow,
  newRoot: string
): Promise<RelocateStats> {
  const db = getDb()

  // 1. Pré-passe : détecter les fichiers disparus
  const actives = db
    .prepare(`SELECT id, filepath FROM photos WHERE status = 'active'`)
    .all() as { id: number; filepath: string }[]
  let markedMissing = 0
  const markMissing = db.prepare(`UPDATE photos SET status = 'missing' WHERE id = ?`)
  const tx1 = db.transaction(() => {
    for (const p of actives) {
      if (!existsSync(p.filepath)) {
        markMissing.run(p.id)
        markedMissing++
      }
    }
  })
  tx1()

  // 2. Index taille → photos manquantes (hash calculé seulement si taille candidate)
  const missing = db
    .prepare(
      `SELECT id, hash_xxh3 AS hash, file_size AS size FROM photos WHERE status = 'missing'`
    )
    .all() as { id: number; hash: string; size: number }[]
  const bySize = new Map<number, { id: number; hash: string }[]>()
  for (const m of missing) {
    const arr = bySize.get(m.size) ?? []
    arr.push({ id: m.id, hash: m.hash })
    bySize.set(m.size, arr)
  }

  const folderStmt = db.prepare(
    `INSERT INTO folders (path) VALUES (?)
     ON CONFLICT(path) DO UPDATE SET last_scanned = unixepoch() RETURNING id`
  )
  const relink = db.prepare(
    `UPDATE photos SET filepath = ?, filename = ?, folder_id = ?, file_mtime = ?, status = 'active'
     WHERE id = ?`
  )
  const claimed = new Set<number>()
  let relinked = 0

  for await (const filepath of walk(newRoot)) {
    let st
    try {
      st = await stat(filepath)
    } catch {
      continue
    }
    const candidates = bySize.get(st.size)
    if (!candidates) continue
    const hash = await hashFile(filepath, st.size)
    const match = candidates.find((c) => c.hash === hash && !claimed.has(c.id))
    if (!match) continue
    claimed.add(match.id)
    const folderId = (folderStmt.get(dirname(filepath)) as { id: number }).id
    const sep = filepath.lastIndexOf('/') >= 0 ? '/' : '\\'
    relink.run(
      filepath,
      filepath.slice(filepath.lastIndexOf(sep) + 1),
      folderId,
      Math.floor(st.mtimeMs / 1000),
      match.id
    )
    relinked++
  }

  // La nouvelle racine rejoint les racines surveillées
  db.prepare(`INSERT OR IGNORE INTO scan_roots (path, mode) VALUES (?, 'watch')`).run(newRoot)
  win.webContents.send('library:changed', { folderIds: [] })

  return { markedMissing, relinked, stillMissing: missing.length - relinked }
}
