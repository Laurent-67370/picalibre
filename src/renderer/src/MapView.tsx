import { useCallback, useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { BoundingBox, GpsPhoto, GridFilters, ReverseGeocodeResult, RendererApi } from '@shared/ipc'

declare global {
  interface Window {
    api: RendererApi
  }
}

// ─── Clustering manuel simple (regroupe les marqueurs proches) ───────────────
interface Cluster {
  lat: number
  lon: number
  photos: GpsPhoto[]
}

function clusterPhotos(photos: GpsPhoto[], zoom: number): Cluster[] {
  // Granularité de regroupement : FINE quand on zoome, GROSSIÈRE en vue
  // monde. L'ancienne formule (10^(5-precision)) était inversée : en
  // zoomant, l'arrondi devenait de plus en plus grossier (10° près à
  // zoom 12 !), toutes les photos fusionnaient en un cluster positionné
  // sur des coordonnées aberrantes, et le zoom-clic partait si loin des
  // vraies photos que la bounding box ne les contenait plus → elles
  // « disparaissaient ». Ici : zoom 2 → 0,1° (~11 km), zoom ≥ 8 →
  // 0,0001° (~11 m), photos quasi co-localisées uniquement.
  const precision = Math.min(4, Math.max(1, Math.floor(zoom / 2)))
  const factor = Math.pow(10, precision)
  const map = new Map<string, Cluster>()

  for (const p of photos) {
    const latKey = Math.round(p.gps_lat * factor) / factor
    const lonKey = Math.round(p.gps_lon * factor) / factor
    const key = `${latKey},${lonKey}`
    let cluster = map.get(key)
    if (!cluster) {
      cluster = { lat: latKey, lon: lonKey, photos: [] }
      map.set(key, cluster)
    }
    cluster.photos.push(p)
  }

  // Position affichée = barycentre RÉEL des photos du cluster, pas la clé
  // arrondie — le marqueur tombe au milieu des photos, et le zoom-clic
  // reste centré sur elles.
  for (const c of map.values()) {
    c.lat = c.photos.reduce((s, p) => s + p.gps_lat, 0) / c.photos.length
    c.lon = c.photos.reduce((s, p) => s + p.gps_lon, 0) / c.photos.length
  }

  return Array.from(map.values())
}

// ─── Icône marqueur personnalisée (thumbnail) ───────────────────────────────
function makePhotoIcon(photoId: number, filename: string): L.DivIcon {
  return L.divIcon({
    className: 'picalibre-map-marker',
    html: `<div class="map-marker-inner" title="${filename.replace(/"/g, '&quot;')}"
      style="background-image:url('thumb://library/256/${photoId}')"></div>`,
    iconSize: [40, 40],
    iconAnchor: [20, 20]
  })
}

function makeClusterIcon(count: number): L.DivIcon {
  const size = Math.min(60, 30 + Math.floor(count / 5) * 4)
  return L.divIcon({
    className: 'picalibre-map-cluster',
    html: `<div class="map-cluster-inner">${count}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2]
  })
}

// ─── Composant principal ────────────────────────────────────────────────────
export interface MapViewProps {
  trayIds: number[]
  filters: GridFilters
  onPhotoClick: (photoId: number) => void
  onGeotagged: () => void
}

export default function MapView({
  trayIds,
  filters,
  onPhotoClick,
  onGeotagged
}: MapViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const layerRef = useRef<L.LayerGroup | null>(null)
  const trayRef = useRef(trayIds)
  const filtersRef = useRef(filters)
  const onPhotoClickRef = useRef(onPhotoClick)
  trayRef.current = trayIds
  filtersRef.current = filters
  onPhotoClickRef.current = onPhotoClick

  const [count, setCount] = useState(0)
  const [flash, setFlash] = useState('')
  const [online, setOnline] = useState(navigator.onLine)
  const [placeName, setPlaceName] = useState<string | null>(null)
  const [loadingPlace, setLoadingPlace] = useState(false)

  // ── Chargement des marqueurs dans la bounding box visible ─────────────────
  const loadMarkers = useCallback(async (): Promise<void> => {
    const map = mapRef.current
    const layer = layerRef.current
    if (!map || !layer) return

    const bounds = map.getBounds()
    const bbox: BoundingBox = {
      south: bounds.getSouth(),
      west: bounds.getWest(),
      north: bounds.getNorth(),
      east: bounds.getEast()
    }

    const f = filtersRef.current
    const photos: GpsPhoto[] = await window.api.invoke('photos:withGeo', {
      bbox,
      minStars: f.minStars,
      typeFilter: f.typeFilter,
      sortMode: f.sortMode
    })
    setCount(photos.length)

    layer.clearLayers()
    const zoom = map.getZoom()
    const clusters = clusterPhotos(photos, zoom)

    for (const cluster of clusters) {
      if (cluster.photos.length === 1) {
        const p = cluster.photos[0]
        const marker = L.marker([p.gps_lat, p.gps_lon], { icon: makePhotoIcon(p.id, p.filename) })
        marker.on('click', () => {
          onPhotoClickRef.current(p.id)
        })
        marker.addTo(layer)
      } else {
        const clusterMarker = L.marker([cluster.lat, cluster.lon], {
          icon: makeClusterIcon(cluster.photos.length)
        })
        clusterMarker.on('click', () => {
          // Cadre la vue sur les photos RÉELLES du cluster (avec marge) au
          // lieu de zoomer aveuglément sur son centre : quelle que soit leur
          // dispersion, elles restent toutes dans la bounding box après le
          // zoom, donc toujours renvoyées par la requête — plus de
          // « disparition ». Si le cluster est insécable (photos
          // co-localisées) et qu'on est déjà au zoom max, ouvrir la
          // première photo.
          const b = L.latLngBounds(cluster.photos.map((p) => [p.gps_lat, p.gps_lon]))
          if (zoom >= 16 && map.getBounds().contains(b)) {
            onPhotoClickRef.current(cluster.photos[0].id)
            return
          }
          map.fitBounds(b.pad(0.3), { maxZoom: 17, animate: true })
        })
        clusterMarker.addTo(layer)
      }
    }
  }, [])

  // ── Géocoding inverse du centre de la carte ───────────────────────────────
  const reverseGeocode = useCallback(async (lat: number, lon: number): Promise<void> => {
    setLoadingPlace(true)
    try {
      const result: ReverseGeocodeResult | null = await window.api.invoke(
        'photos:reverseGeocode',
        { lat, lon }
      )
      setPlaceName(result ? (result.city ?? result.displayName) : null)
    } catch {
      setPlaceName(null)
    } finally {
      setLoadingPlace(false)
    }
  }, [])

  // ── Initialisation de la carte Leaflet ────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return

    const map = L.map(containerRef.current, {
      center: [46.6, 2.4], // France par défaut
      zoom: 5,
      zoomControl: true,
      attributionControl: true
    })

    // Tuiles OpenStreetMap
    const tileLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
      crossOrigin: true
    })
    tileLayer.addTo(map)

    // Fallback offline : si les tuiles ne chargent pas
    tileLayer.on('tileerror', () => {
      setOnline(false)
    })

    const layer = L.layerGroup().addTo(map)
    mapRef.current = map
    layerRef.current = layer

    // Chargement initial des marqueurs
    map.whenReady(() => {
      void loadMarkers()
    })

    // Rechargement des marqueurs quand la carte bouge (debounce)
    let moveTimer: ReturnType<typeof setTimeout> | null = null
    map.on('moveend', () => {
      if (moveTimer) clearTimeout(moveTimer)
      moveTimer = setTimeout(() => {
        void loadMarkers()
        const c = map.getCenter()
        void reverseGeocode(c.lat, c.lng)
      }, 300)
    })

    // Géotag manuel : clic sur la carte = positionner les photos du bac
    map.on('click', async (e: L.LeafletMouseEvent) => {
      const ids = trayRef.current
      if (ids.length === 0) return
      await window.api.invoke('photos:setGps', {
        photoIds: ids,
        lat: Math.round(e.latlng.lat * 1e6) / 1e6,
        lon: Math.round(e.latlng.lng * 1e6) / 1e6
      })
      setFlash(`📍 ${ids.length} photo(s) géotaguée(s)`)
      setTimeout(() => setFlash(''), 2500)
      await loadMarkers()
      onGeotagged()
    })

    // Détection online/offline
    const onOnline = (): void => {
      setOnline(true)
      tileLayer.redraw()
    }
    const onOffline = (): void => setOnline(false)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)

    return () => {
      if (moveTimer) clearTimeout(moveTimer)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      map.remove()
      mapRef.current = null
      layerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Rechargement quand les filtres changent ───────────────────────────────
  useEffect(() => {
    if (mapRef.current) {
      void loadMarkers()
    }
  }, [filters, loadMarkers])

  return (
    <div style={{ position: 'relative', flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      {/* Fallback offline */}
      {!online && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            background: '#181b20ee',
            padding: '20px 30px',
            borderRadius: 8,
            fontSize: 15,
            zIndex: 1000,
            textAlign: 'center',
            border: '1px solid #36404a'
          }}
        >
          📡 Pas de connexion internet
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
            Les tuiles de carte nécessitent une connexion. Les marqueurs restent visibles.
          </div>
        </div>
      )}

      {/* Conteneur Leaflet */}
      <div ref={containerRef} style={{ flex: 1, minHeight: 0 }} />

      {/* Overlay info */}
      <div
        style={{
          position: 'absolute',
          top: 10,
          left: 10,
          background: '#181b20e6',
          padding: '8px 12px',
          borderRadius: 6,
          fontSize: 13,
          maxWidth: 340,
          zIndex: 500,
          pointerEvents: 'none'
        }}
      >
        <div>🗺 {count} photo(s) géolocalisée(s) dans la zone visible</div>
        {placeName && (
          <div style={{ opacity: 0.8, marginTop: 2 }}>📍 {placeName}</div>
        )}
        {loadingPlace && (
          <div style={{ opacity: 0.5, marginTop: 2 }}>… localisation</div>
        )}
        <div style={{ opacity: 0.6, marginTop: 4 }}>
          {trayIds.length > 0
            ? `Clique sur la carte pour géotaguer les ${trayIds.length} photo(s) du bac.`
            : 'Clique sur un marqueur pour ouvrir la photo.'}
        </div>
        {flash && <div style={{ color: '#7ee787', marginTop: 4 }}>{flash}</div>}
      </div>

      {/* Bouton recentrer */}
      <button
        onClick={() => {
          if (mapRef.current) {
            void loadMarkers()
            const map = mapRef.current
            // Ajuster la vue pour voir tous les marqueurs si possible
            const bounds = L.latLngBounds([])
            map.eachLayer((layer) => {
              if (layer instanceof L.Marker) {
                const ll = layer.getLatLng()
                bounds.extend(ll)
              }
            })
            if (bounds.isValid()) {
              map.fitBounds(bounds, { padding: [80, 80], maxZoom: 12 })
            }
          }
        }}
        style={{
          position: 'absolute',
          bottom: 20,
          right: 10,
          zIndex: 500,
          background: '#181b20e6',
          border: '1px solid #36404a',
          borderRadius: 6,
          padding: '6px 10px',
          fontSize: 13,
          cursor: 'pointer',
          color: '#c9d1d9'
        }}
      >
        🎯 Recentrer
      </button>
    </div>
  )
}