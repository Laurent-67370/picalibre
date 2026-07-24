/**
 * Service worker PicaLibre Web — la galerie devient une PWA installable
 * et consultable hors-ligne.
 *
 * Stratégies par type de ressource :
 * - App shell (HTML, manifest, icônes) : cache-first, mis à jour en
 *   arrière-plan (stale-while-revalidate) — l'app s'ouvre instantanément
 *   même sans réseau.
 * - Miniatures /thumb/{hash}/{size}.webp : cache-first pur — adressées par
 *   hash de contenu, donc immuables par construction. Cache borné (LRU
 *   approximatif par ordre d'insertion) pour respecter les quotas mobiles,
 *   Safari iOS étant le plus strict.
 * - API /api/* (GET) : network-first avec repli sur la dernière réponse en
 *   cache — hors-ligne, on revoit la dernière liste chargée.
 *
 * Incrémenter VERSION invalide les caches shell/API au prochain déploiement
 * (les miniatures, immuables, survivent aux versions).
 */
const VERSION = 'v1'
const SHELL_CACHE = `picalibre-shell-${VERSION}`
const API_CACHE = `picalibre-api-${VERSION}`
const THUMB_CACHE = 'picalibre-thumbs' // volontairement non versionné

/** Nombre max de miniatures conservées hors-ligne (~25 Mo de WebP 256 px). */
const THUMB_LIMIT = 2000
/** Nombre max de réponses API en cache — chaque combinaison de filtres et
 *  de pagination crée une entrée distincte, sans borne le cache grossirait
 *  indéfiniment au fil des mois. */
const API_LIMIT = 200

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && k !== API_CACHE && k !== THUMB_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  )
})

/** Éviction FIFO du cache de miniatures : keys() rend l'ordre d'insertion. */
async function trimThumbCache() {
  const cache = await caches.open(THUMB_CACHE)
  const keys = await cache.keys()
  if (keys.length <= THUMB_LIMIT) return
  for (const key of keys.slice(0, keys.length - THUMB_LIMIT)) {
    await cache.delete(key)
  }
}

async function thumbCacheFirst(request) {
  const cached = await caches.match(request, { cacheName: THUMB_CACHE })
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok) {
    const cache = await caches.open(THUMB_CACHE)
    await cache.put(request, response.clone())
    // Pas de await : l'éviction peut se faire après la réponse
    trimThumbCache()
  }
  return response
}

/** Même éviction FIFO que les miniatures, pour le cache API. */
async function trimApiCache() {
  const cache = await caches.open(API_CACHE)
  const keys = await cache.keys()
  if (keys.length <= API_LIMIT) return
  for (const key of keys.slice(0, keys.length - API_LIMIT)) {
    await cache.delete(key)
  }
}

async function apiNetworkFirst(request) {
  try {
    const response = await fetch(request)
    if (response.ok) {
      const cache = await caches.open(API_CACHE)
      await cache.put(request, response.clone())
      trimApiCache()
    }
    return response
  } catch (err) {
    const cached = await caches.match(request, { cacheName: API_CACHE })
    if (cached) return cached
    throw err
  }
}

async function shellStaleWhileRevalidate(request) {
  const cached = await caches.match(request, { cacheName: SHELL_CACHE })
  const refresh = fetch(request)
    .then(async (response) => {
      if (response.ok) {
        const cache = await caches.open(SHELL_CACHE)
        await cache.put(request, response.clone())
      }
      return response
    })
    .catch(() => null)
  return cached || refresh.then((r) => r || Response.error())
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  // On ne gère que la même origine : la galerie et son API sont servies
  // par le même serveur Express (pas de CORS configuré côté serveur).
  if (url.origin !== self.location.origin) return

  if (url.pathname.startsWith('/thumb/')) {
    event.respondWith(thumbCacheFirst(request))
  } else if (url.pathname.startsWith('/api/')) {
    event.respondWith(apiNetworkFirst(request))
  } else if (request.mode === 'navigate' || SHELL_ASSETS.some((a) => url.pathname.endsWith(a.slice(1)))) {
    event.respondWith(shellStaleWhileRevalidate(request))
  }
})
