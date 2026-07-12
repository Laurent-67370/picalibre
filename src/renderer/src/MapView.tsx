import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { GpsPhoto, RendererApi } from '@shared/ipc'

declare global {
  interface Window {
    api: RendererApi
  }
}

const OSM_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors'
    }
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }]
}

export default function MapView({
  trayIds,
  onGeotagged
}: {
  trayIds: number[]
  onGeotagged: () => void
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const markersRef = useRef<maplibregl.Marker[]>([])
  const trayRef = useRef(trayIds)
  trayRef.current = trayIds
  const [count, setCount] = useState(0)
  const [flash, setFlash] = useState('')

  const loadMarkers = async (): Promise<void> => {
    const map = mapRef.current
    if (!map) return
    const photos: GpsPhoto[] = await window.api.invoke('photos:withGps', undefined)
    setCount(photos.length)
    markersRef.current.forEach((m) => m.remove())
    markersRef.current = []
    const bounds = new maplibregl.LngLatBounds()
    for (const p of photos) {
      const el = document.createElement('div')
      el.title = p.filename
      el.style.cssText = `width:34px;height:34px;border-radius:50%;border:2px solid #fff;
        box-shadow:0 1px 6px #0009;cursor:pointer;background:#1e2126 center/cover;
        background-image:url("thumb://library/256/${p.id}")`
      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([p.gps_lon, p.gps_lat])
        .addTo(map)
      markersRef.current.push(marker)
      bounds.extend([p.gps_lon, p.gps_lat])
    }
    if (photos.length > 0) map.fitBounds(bounds, { padding: 80, maxZoom: 12 })
  }

  useEffect(() => {
    if (!containerRef.current) return
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: OSM_STYLE,
      center: [7.7, 48.6], // Alsace par défaut 😉
      zoom: 5
    })
    map.addControl(new maplibregl.NavigationControl(), 'top-right')
    mapRef.current = map

    map.on('load', loadMarkers)

    // Géotag manuel : clic sur la carte = positionner les photos du bac
    map.on('click', async (e) => {
      const ids = trayRef.current
      if (ids.length === 0) return
      await window.api.invoke('photos:setGps', {
        photoIds: ids,
        lat: Math.round(e.lngLat.lat * 1e6) / 1e6,
        lon: Math.round(e.lngLat.lng * 1e6) / 1e6
      })
      setFlash(`📍 ${ids.length} photo(s) géotaguée(s)`)
      setTimeout(() => setFlash(''), 2500)
      await loadMarkers()
      onGeotagged()
    })

    return () => {
      markersRef.current.forEach((m) => m.remove())
      map.remove()
      mapRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      <div
        style={{
          position: 'absolute',
          top: 10,
          left: 10,
          background: '#181b20e6',
          padding: '8px 12px',
          borderRadius: 6,
          fontSize: 13,
          maxWidth: 320,
          zIndex: 5
        }}
      >
        🗺 {count} photo(s) géolocalisée(s)
        <div style={{ opacity: 0.7, marginTop: 4 }}>
          {trayIds.length > 0
            ? `Clique sur la carte pour géotaguer les ${trayIds.length} photo(s) du bac.`
            : 'Ajoute des photos au bac puis clique la carte pour les géotaguer.'}
        </div>
        {flash && <div style={{ color: '#7ee787', marginTop: 4 }}>{flash}</div>}
      </div>
    </div>
  )
}
