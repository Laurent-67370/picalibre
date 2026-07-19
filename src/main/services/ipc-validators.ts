/**
 * Garde-fou runtime pour les canaux IPC d'écriture sensibles.
 *
 * Couche de défense en profondeur : le typage TypeScript (IpcInvokeMap)
 * restreint déjà les payloads à la compilation, mais un renderer compromis
 * peut appeler `window.api.invoke` avec un cast. Ces validateurs rejettent
 * les valeurs hors-domaine AVANT toute écriture en base ou sur disque.
 *
 * Conventions :
 *  - Pas de zod, juste des guards JS natifs (typeof, isFinite, ranges).
 *  - Une validation échouée jette une Error explicite (le handler IPC la
 *    remonte au renderer comme un reject de promesse). On préfère throw
 *    plutôt qu'un retour silencieux : le renderer doit savoir que son
 *    appel a été rejeté pour ne pas croire l'écriture réussie.
 */

/** Valide un payload photos:setRating { photoId: number; rating: number }. */
export function assertSetRating(payload: unknown): asserts payload is {
  photoId: number
  rating: number
} {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('photos:setRating — payload attendu (objet)')
  }
  const p = payload as { photoId?: unknown; rating?: unknown }
  if (typeof p.photoId !== 'number' || !Number.isInteger(p.photoId) || p.photoId <= 0) {
    throw new Error('photos:setRating — photoId entier positif attendu')
  }
  const r = p.rating
  if (typeof r !== 'number' || !Number.isInteger(r) || r < 0 || r > 5) {
    throw new Error('photos:setRating — rating doit être un entier 0..5')
  }
}

/** Valide un payload photos:setGps { photoIds: number[]; lat: number; lon: number }. */
export function assertSetGps(payload: unknown): asserts payload is {
  photoIds: number[]
  lat: number
  lon: number
} {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('photos:setGps — payload attendu (objet)')
  }
  const p = payload as { photoIds?: unknown; lat?: unknown; lon?: unknown }
  if (
    !Array.isArray(p.photoIds) ||
    p.photoIds.length === 0 ||
    !p.photoIds.every((id) => typeof id === 'number' && Number.isInteger(id) && id > 0)
  ) {
    throw new Error('photos:setGps — photoIds doit être un tableau non vide d\'entiers positifs')
  }
  const lat = p.lat
  const lon = p.lon
  if (
    typeof lat !== 'number' ||
    !Number.isFinite(lat) ||
    lat < -90 ||
    lat > 90
  ) {
    throw new Error('photos:setGps — lat doit être dans [-90, 90]')
  }
  if (
    typeof lon !== 'number' ||
    !Number.isFinite(lon) ||
    lon < -180 ||
    lon > 180
  ) {
    throw new Error('photos:setGps — lon doit être dans [-180, 180]')
  }
}

/** Valide un payload scanRoots:add { path: string; mode?: 'watch' | 'once' }. */
export function assertScanRootAdd(payload: unknown): asserts payload is {
  path: string
  mode?: 'watch' | 'once'
} {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('scanRoots:add — payload attendu (objet)')
  }
  const p = payload as { path?: unknown; mode?: unknown }
  if (typeof p.path !== 'string' || p.path.trim().length === 0) {
    throw new Error('scanRoots:add — path (chaîne non vide) attendu')
  }
  // Refus des traversées de répertoire parent : un chemin contenant '..'
  // comme segment serait suspect (tentative de remonter au-delà d'une racine).
  // On tolère '..' au milieu d'un nom de fichier légitime ? Non — sur POSIX,
  // '..' comme segment est une traversée ; on rejette donc tout '..' segmenté.
  const segments = p.path.split(/[\\/]/)
  if (segments.some((seg) => seg === '..')) {
    throw new Error('scanRoots:add — segment ".." interdit dans le path')
  }
  if (p.mode !== undefined && p.mode !== 'watch' && p.mode !== 'once') {
    throw new Error('scanRoots:add — mode doit être "watch" ou "once"')
  }
}