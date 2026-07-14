/**
 * Préchargement prédictif des miniatures (Optimisation 11).
 *
 * Au scroll, identifie les photoIds des N prochaines lignes qui ne sont
 * pas encore visibles et pré-décode leurs miniatures en arrière-plan
 * via le Web Worker. Les ImageBitmap résultants sont insérés dans le
 * cache LRU (thumb-cache.ts) pour qu'ils soient dessinés instantanément
 * quand la ligne devient visible.
 *
 * Contraintes :
 * - Limite à ~20 miniatures en avance (PREFETCH_LIMIT)
 * - Priorise les lignes les plus proches du viewport
 * - Ne pré-décode que les miniatures absentes du cache (évite le travail inutile)
 * - Réutilise le Web Worker existant de ThumbCanvas (shared singleton)
 * - Debounce du scroll pour éviter de lancer le préchargement à chaque pixel
 */

import { thumbCache } from './thumb-cache'

/**
 * Type partiel d'une ligne de grille — suffisant pour extraire les photoIds.
 * Correspond au type GridRow de App.tsx mais sans importer tout App.tsx
 * pour éviter une dépendance circulaire.
 */
interface PrefetchableRow {
  kind: 'header' | 'photos'
  items?: { p: { id: number; hash_xxh3?: string } }[]
}

/** Nombre maximum de miniatures à pré-décoder en avance. */
const PREFETCH_LIMIT = 20

/** Taille de miniature utilisée par la grille (doit correspondre à ThumbCanvas). */
const THUMB_SIZE = 256

/** Worker partagé pour le décodage off-main-thread. */
let prefetchWorker: Worker | null = null
let prefetchWorkerFailed = false

/**
 * Initialise (ou réutilise) le Web Worker de décodage.
 * Partagé avec ThumbCanvas via un singleton module-level.
 */
function getPrefetchWorker(): Worker | null {
  if (prefetchWorkerFailed) return null
  if (prefetchWorker) return prefetchWorker
  try {
    prefetchWorker = new Worker(new URL('./thumb-decoder.worker.ts', import.meta.url), {
      type: 'module'
    })
    prefetchWorker.onerror = (): void => {
      console.warn('[prefetch] Web Worker indisponible, préchargement désactivé')
      prefetchWorkerFailed = true
      prefetchWorker = null
    }
  } catch {
    prefetchWorkerFailed = true
    return null
  }
  return prefetchWorker
}

/**
 * Ensemble des photoIds actuellement en cours de préchargement.
 * Évite de lancer plusieurs décodages pour la même miniature.
 */
const inFlight = new Set<number>()

/**
 * Pré-décode une miniature et l'insère dans le cache LRU.
 *
 * @param photoId  ID de la photo
 * @param hash     Hash xxh3 pour construire l'URL thumb://
 */
function prefetchThumb(photoId: number, hash: string): void {
  // Déjà dans le cache — rien à faire
  if (thumbCache.has(photoId, THUMB_SIZE)) return
  // Déjà en cours de décodage
  if (inFlight.has(photoId)) return

  const worker = getPrefetchWorker()
  if (!worker || prefetchWorkerFailed) return

  const url = `thumb://library/${THUMB_SIZE}/${photoId}?v=${hash}`
  inFlight.add(photoId)

  const handler = (e: MessageEvent<{ bitmap?: ImageBitmap; error?: string; url: string }>): void => {
    if (e.data.url !== url) return // réponse obsolète
    worker.removeEventListener('message', handler)
    inFlight.delete(photoId)

    if (e.data.bitmap) {
      // Insère dans le cache LRU — sera disponible immédiatement quand
      // ThumbCanvas tentera de charger cette miniature
      thumbCache.set(photoId, THUMB_SIZE, e.data.bitmap)
    }
    // En cas d'erreur, on supprime simplement de inFlight (retry au prochain scroll)
  }

  worker.addEventListener('message', handler)
  worker.postMessage({ url })
}

/**
 * Lance le préchargement prédictif des miniatures pour les N prochaines lignes.
 *
 * @param gridRows      Toutes les lignes de la grille virtualisée
 * @param visibleStart  Index de la première ligne visible
 * @param visibleCount  Nombre de lignes visibles
 */
export function prefetchUpcomingThumbs(
  gridRows: PrefetchableRow[],
  visibleStart: number,
  visibleCount: number
): void {
  // Calcule l'index de la première ligne non-visible (après le viewport)
  const firstHidden = visibleStart + visibleCount
  if (firstHidden >= gridRows.length) return

  let prefetched = 0
  // Parcourt les lignes après le viewport, en priorisant les plus proches
  for (let i = firstHidden; i < gridRows.length && prefetched < PREFETCH_LIMIT; i++) {
    const row = gridRows[i]
    if (!row || row.kind !== 'photos' || !row.items) continue

    for (const item of row.items) {
      if (prefetched >= PREFETCH_LIMIT) break
      const hash = item.p.hash_xxh3 ?? ''
      if (hash === '') continue // miniature pas encore générée
      prefetchThumb(item.p.id, hash)
      prefetched++
    }
  }
}

/**
 * Préchargement prédictif bidirectionnel : pré-décode aussi les lignes
 * au-dessus du viewport (utile quand l'utilisateur scroll vers le haut).
 *
 * @param gridRows      Toutes les lignes de la grille virtualisée
 * @param visibleStart  Index de la première ligne visible
 * @param visibleCount  Nombre de lignes visibles
 */
export function prefetchBidirectionalThumbs(
  gridRows: PrefetchableRow[],
  visibleStart: number,
  visibleCount: number
): void {
  // Lignes après le viewport (scroll vers le bas)
  const firstHidden = visibleStart + visibleCount
  let prefetched = 0

  // Intercale les lignes avant et après le viewport pour couvrir les deux
  // directions de scroll. On alterne : 1 ligne après, 1 ligne avant, etc.
  const afterLimit = Math.min(gridRows.length, firstHidden + 10)
  const beforeLimit = Math.max(0, visibleStart - 10)

  for (let offset = 1; prefetched < PREFETCH_LIMIT; offset++) {
    let foundAny = false

    // Ligne après le viewport
    const afterIdx = firstHidden - 1 + offset
    if (afterIdx < afterLimit) {
      const row = gridRows[afterIdx]
      if (row && row.kind === 'photos' && row.items) {
        for (const item of row.items) {
          if (prefetched >= PREFETCH_LIMIT) break
          const hash = item.p.hash_xxh3 ?? ''
          if (hash === '') continue
          prefetchThumb(item.p.id, hash)
          prefetched++
          foundAny = true
        }
      }
    }

    // Ligne avant le viewport
    const beforeIdx = visibleStart - offset
    if (beforeIdx >= beforeLimit) {
      const row = gridRows[beforeIdx]
      if (row && row.kind === 'photos' && row.items) {
        for (const item of row.items) {
          if (prefetched >= PREFETCH_LIMIT) break
          const hash = item.p.hash_xxh3 ?? ''
          if (hash === '') continue
          prefetchThumb(item.p.id, hash)
          prefetched++
          foundAny = true
        }
      }
    }

    if (!foundAny && afterIdx >= afterLimit && beforeIdx < beforeLimit) break
  }
}

/**
 * Nettoyage : ferme le Worker et vide les ensembles en cours.
 * À appeler lors du démontage du composant.
 */
export function cleanupPrefetch(): void {
  if (prefetchWorker) {
    prefetchWorker.terminate()
    prefetchWorker = null
  }
  inFlight.clear()
}