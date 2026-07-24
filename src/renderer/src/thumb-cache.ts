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

import { isLowSpecRenderer } from './low-spec'

interface CacheEntry {
  bitmap: ImageBitmap
  /** Date d'accès pour le LRU — mis à jour à chaque get(). */
  lastAccess: number
  /** Empreinte mémoire estimée du bitmap décodé (largeur × hauteur × 4). */
  bytes: number
}

/** Empreinte RGBA non compressée d'un ImageBitmap décodé. */
function bitmapBytes(bitmap: ImageBitmap): number {
  return bitmap.width * bitmap.height * 4
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
  bytes: number
  maxBytes: number
}

/** Budget mémoire par défaut si non précisé (bitmaps décodés, RGBA). */
const DEFAULT_MAX_BYTES = 96 * 1024 * 1024

export class ThumbLRUCache {
  private readonly maxEntries: number
  /** Budget en octets des bitmaps décodés — borne RÉELLE de l'empreinte
   *  mémoire, là où maxEntries seul laissait le cache grossir jusqu'à
   *  ~130 Mo (500 × 256 px RGBA) quelle que soit la machine. */
  private readonly maxBytes: number
  private totalBytes = 0
  private readonly map: Map<string, CacheEntry> = new Map()
  private hits = 0
  private misses = 0

  constructor(maxEntries: number = DEFAULT_MAX_ENTRIES, maxBytes: number = DEFAULT_MAX_BYTES) {
    this.maxEntries = maxEntries
    this.maxBytes = maxBytes
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
    const existing = this.map.get(key)
    if (existing) {
      this.totalBytes -= existing.bytes
      this.map.delete(key)
    }

    const bytes = bitmapBytes(bitmap)
    this.map.set(key, { bitmap, lastAccess: Date.now(), bytes })
    this.totalBytes += bytes

    // Éviction LRU : supprime les entrées les plus anciennes, en gardant
    // AUSSI l'empreinte mémoire totale sous le budget maxBytes (une borne en
    // nombre d'entrées seule ne dit rien de la RAM réellement consommée).
    while (this.map.size > this.maxEntries || (this.totalBytes > this.maxBytes && this.map.size > 1)) {
      const oldest = this.map.keys().next()
      if (oldest.done) break
      const oldestKey = oldest.value
      const evicted = this.map.get(oldestKey)
      if (evicted) {
        this.totalBytes -= evicted.bytes
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
      this.totalBytes -= entry.bytes
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
    this.totalBytes = 0
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
      maxEntries: this.maxEntries,
      bytes: this.totalBytes,
      maxBytes: this.maxBytes
    }
  }
}

/** Instance globale — partagée par tous les ThumbCanvas.
 *  Limite 500 entrées : sur un écran 4K (~60 vignettes visibles), couvre
 *  ~8 écrans de scroll au lieu de ~3 avec 200.
 *  Budget mémoire : 96 Mo de bitmaps décodés, réduit à 48 Mo sur petite
 *  configuration (≤ 4 cœurs ou deviceMemory ≤ 4) — c'est lui, pas le nombre
 *  d'entrées, qui borne réellement la RAM du renderer. */
export const thumbCache = new ThumbLRUCache(
  500,
  isLowSpecRenderer() ? 48 * 1024 * 1024 : 96 * 1024 * 1024
)