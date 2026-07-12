/**
 * Gestion manuelle des clusters de visages — fusion, scission, confirmation.
 * Module "core" : la DB est INJECTÉE (pattern privacy-core) → testable en Node
 * pur avec une base en mémoire, sans electron.
 */
import type { Database } from 'better-sqlite3'
import { blobToF32, f32ToBlob } from './cluster'

/** Moyenne exacte des embeddings des visages d'une personne (recalcul fiable). */
export function recomputeCentroid(db: Database, personId: number): void {
  const rows = db
    .prepare('SELECT embedding FROM faces WHERE person_id = ?')
    .all(personId) as { embedding: Uint8Array }[]
  if (rows.length === 0) {
    db.prepare('DELETE FROM persons WHERE id = ?').run(personId)
    return
  }
  const first = blobToF32(rows[0].embedding)
  const sum = new Float64Array(first.length)
  for (const r of rows) {
    const e = blobToF32(r.embedding)
    for (let i = 0; i < sum.length; i++) sum[i] += e[i] ?? 0
  }
  const mean = new Float32Array(sum.length)
  for (let i = 0; i < sum.length; i++) mean[i] = sum[i] / rows.length
  db.prepare('UPDATE persons SET centroid = ?, face_count = ? WHERE id = ?').run(
    f32ToBlob(mean),
    rows.length,
    personId
  )
}

/**
 * Fusionne des personnes dans une cible : visages re-rattachés, nom conservé
 * (cible prioritaire, sinon premier nom trouvé), centroïde recalculé sur les
 * embeddings réels, sources supprimées.
 */
export function mergePersons(db: Database, targetId: number, sourceIds: number[]): void {
  const sources = sourceIds.filter((id) => id !== targetId)
  if (sources.length === 0) return
  const tx = db.transaction(() => {
    // Conserver un nom si la cible n'en a pas
    const target = db.prepare('SELECT name FROM persons WHERE id = ?').get(targetId) as
      | { name: string | null }
      | undefined
    if (!target) throw new Error(`Personne cible ${targetId} introuvable`)
    if (!target.name) {
      for (const sid of sources) {
        const s = db.prepare('SELECT name FROM persons WHERE id = ?').get(sid) as
          | { name: string | null }
          | undefined
        if (s?.name) {
          db.prepare('UPDATE persons SET name = ? WHERE id = ?').run(s.name, targetId)
          break
        }
      }
    }
    const ph = sources.map(() => '?').join(',')
    db.prepare(`UPDATE faces SET person_id = ? WHERE person_id IN (${ph})`).run(
      targetId,
      ...sources
    )
    db.prepare(`DELETE FROM persons WHERE id IN (${ph})`).run(...sources)
    recomputeCentroid(db, targetId)
  })
  tx()
}

/**
 * Scission : détache des visages vers une NOUVELLE personne anonyme.
 * Les centroïdes des personnes d'origine et de la nouvelle sont recalculés ;
 * une personne d'origine vidée est supprimée. Retourne l'id créé (ou null si
 * aucun visage valide).
 */
export function splitFaces(db: Database, faceIds: number[]): number | null {
  if (faceIds.length === 0) return null
  let newId: number | null = null
  const tx = db.transaction(() => {
    const ph = faceIds.map(() => '?').join(',')
    const origins = (
      db
        .prepare(
          `SELECT DISTINCT person_id FROM faces WHERE id IN (${ph}) AND person_id IS NOT NULL`
        )
        .all(...faceIds) as { person_id: number }[]
    ).map((r) => r.person_id)

    const row = db
      .prepare('INSERT INTO persons (centroid, face_count) VALUES (NULL, 0) RETURNING id')
      .get() as { id: number }
    newId = row.id

    db.prepare(
      `UPDATE faces SET person_id = ?, assignment = 'auto' WHERE id IN (${ph})`
    ).run(newId, ...faceIds)

    recomputeCentroid(db, newId)
    for (const pid of origins) recomputeCentroid(db, pid)
  })
  tx()
  return newId
}

/** Confirme des rattachements (suggestion validée par l'utilisateur). */
export function confirmFaces(db: Database, faceIds: number[]): void {
  if (faceIds.length === 0) return
  const ph = faceIds.map(() => '?').join(',')
  db.prepare(`UPDATE faces SET assignment = 'confirmed' WHERE id IN (${ph})`).run(...faceIds)
}

/**
 * Rejette des rattachements : "ce n'est pas cette personne".
 * Les visages sont détachés vers une nouvelle personne anonyme (comme une
 * scission) et marqués 'rejected' vis-à-vis de leur ancien cluster.
 */
export function rejectFaces(db: Database, faceIds: number[]): number | null {
  const newId = splitFaces(db, faceIds)
  if (newId != null && faceIds.length > 0) {
    const ph = faceIds.map(() => '?').join(',')
    db.prepare(`UPDATE faces SET assignment = 'rejected' WHERE id IN (${ph})`).run(...faceIds)
  }
  return newId
}

export interface FaceRowLite {
  id: number
  photo_id: number
  bbox_x: number
  bbox_y: number
  bbox_w: number
  bbox_h: number
  confidence: number
  assignment: 'auto' | 'suggested' | 'confirmed' | 'rejected'
}

export function facesByPerson(db: Database, personId: number): FaceRowLite[] {
  return db
    .prepare(
      `SELECT f.id, f.photo_id, f.bbox_x, f.bbox_y, f.bbox_w, f.bbox_h, f.confidence, f.assignment
       FROM faces f
       JOIN photos p ON p.id = f.photo_id
       WHERE f.person_id = ? AND p.status = 'active'
       ORDER BY f.confidence ASC` // les moins sûrs d'abord : ce sont eux à vérifier
    )
    .all(personId) as FaceRowLite[]
}
