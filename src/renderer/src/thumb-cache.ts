/**
 * Cache LRU (Least Recently Used) des ImageBitmap déjà décodées.
 *
 * Quand l'utilisateur scroll back dans la grille, les miniatures déjà vues
 * sont dessinées instantanément depuis ce cache sans re-décodage.
 *
 * Taille max configurable (200 entrées par défaut, ~50 Mo avec des 256px WebP).
 *
 * API :
 * - get(photoId, size) → ImageBitmap | null
 * - set(photoId, size, bitmap)
 * - has(photoId, size) → boolean
 * - evict(photoId, size) — force l'éviction manuelle
 * - clear() — vide tout le cache
 * - stats() → { hits, misses, size, maxEntries }
 */

interface CacheEntry {
  bitmap: ImageBitmap
  /** Date d'accès pour le LRU — mis à jour à chaque get(). */
  lastAccess: number
}

/** Clé de cache : `${photoId}:${size}` */
function makeKey(photoId: number, size: number): string {
  return `${photoId}:${size}`
}

const DEFAULT_MAX_ENTRIES = 200

export interface CacheStats {
  hits: number
  misses: number
  size: number
  maxEntries: number
}

export class ThumbLRUCache {
  private readonly maxEntries: number
  private readonly map: Map<string, CacheEntry> = new Map()
  private hits = 0
  private misses = 0

  constructor(maxEntries: number = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries
  }

  /**
   * Récupère un ImageBitmap du cache.
   * Met à jour lastAccess pour le LRU.
   * Retourne null si absent.
   */
  get(photoId: number, size: number): ImageBitmap | null {
    const key = makeKey(photoId, size)
    const entry = this.map.get(key)
    if (!entry) {
      this.misses++
      return null
    }

    this.hits++

    // Met à jour l'accès LRU : supprime puis ré-insère en fin de Map
    // (Map conserve l'ordre d'insertion en JS)
    this.map.delete(key)
    entry.lastAccess = Date.now()
    this.map.set(key, entry)
    return entry.bitmap
  }

  /**
   * Vérifie si une entrée existe dans le cache sans mettre à jour le LRU.
   */
  has(photoId: number, size: number): boolean {
    return this.map.has(makeKey(photoId, size))
  }

  /**
   * Stocke un ImageBitmap dans le cache.
   * Évince les entrées LRU si la taille max est dépassée.
   */
  set(photoId: number, size: number, bitmap: ImageBitmap): void {
    const key = makeKey(photoId, size)

    // Si déjà présent, met à jour
    if (this.map.has(key)) {
      this.map.delete(key)
    }

    this.map.set(key, { bitmap, lastAccess: Date.now() })

    // Éviction LRU : supprime les entrées les plus anciennes
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next()
      if (oldest.done) break
      const oldestKey = oldest.value
      const evicted = this.map.get(oldestKey)
      if (evicted) {
        // Libère l'ImageBitmap (close() libère la mémoire GPU/décodeur)
        try { evicted.bitmap.close() } catch { /* déjà fermé */ }
      }
      this.map.delete(oldestKey)
    }
  }

  /**
   * Évince manuellement une entrée du cache.
   */
  evict(photoId: number, size: number): void {
    const key = makeKey(photoId, size)
    const entry = this.map.get(key)
    if (entry) {
      try { entry.bitmap.close() } catch { /* déjà fermé */ }
      this.map.delete(key)
    }
  }

  /**
   * Vide entièrement le cache et libère tous les ImageBitmap.
   */
  clear(): void {
    for (const entry of this.map.values()) {
      try { entry.bitmap.close() } catch { /* déjà fermé */ }
    }
    this.map.clear()
  }

  /** Nombre d'entrées actuellement dans le cache. */
  get size(): number {
    return this.map.size
  }

  /**
   * Retourne les statistiques du cache (hits, misses, taille).
   * Utile pour le debug et le monitoring des performances.
   */
  stats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.map.size,
      maxEntries: this.maxEntries
    }
  }
}

/** Instance globale — partagée par tous les ThumbCanvas. */
export const thumbCache = new ThumbLRUCache(200)