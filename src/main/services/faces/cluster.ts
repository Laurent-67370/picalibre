/**
 * Clustering incrémental des visages — module 100 % pur (testable en Node).
 *
 * Principe (voir docs/ARCHITECTURE.md §6) :
 *  - chaque visage détecté fournit un embedding (Float32Array, ~1024-d avec
 *    le modèle faceres de Human) ;
 *  - on le compare aux CENTROÏDES des personnes existantes (similarité
 *    cosinus) ;
 *  - au-dessus du seuil → rattachement à la personne la plus proche
 *    (assignment 'auto') et mise à jour du centroïde (moyenne incrémentale) ;
 *  - en dessous → nouveau cluster anonyme ("Personne N").
 */

export const SIMILARITY_THRESHOLD = 0.55

export interface PersonCentroid {
  id: number
  centroid: Float32Array
  count: number
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export function bestMatch(
  embedding: Float32Array,
  persons: PersonCentroid[],
  threshold: number = SIMILARITY_THRESHOLD
): { personId: number; similarity: number } | null {
  let best: { personId: number; similarity: number } | null = null
  for (const p of persons) {
    const sim = cosine(embedding, p.centroid)
    if (sim >= threshold && (!best || sim > best.similarity)) {
      best = { personId: p.id, similarity: sim }
    }
  }
  return best
}

/** Moyenne incrémentale : nouveau centroïde après ajout d'un embedding. */
export function mergeCentroid(
  centroid: Float32Array,
  count: number,
  embedding: Float32Array
): Float32Array {
  const n = Math.min(centroid.length, embedding.length) || embedding.length
  const out = new Float32Array(embedding.length)
  for (let i = 0; i < embedding.length; i++) {
    const c = i < n ? centroid[i] : 0
    out[i] = (c * count + embedding[i]) / (count + 1)
  }
  return out
}

// --- Sérialisation BLOB SQLite ↔ Float32Array ---
export function f32ToBlob(a: Float32Array): Uint8Array {
  return new Uint8Array(a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength))
}

export function blobToF32(buf: Uint8Array): Float32Array {
  const copy = new Uint8Array(buf) // aligne l'offset
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4))
}
