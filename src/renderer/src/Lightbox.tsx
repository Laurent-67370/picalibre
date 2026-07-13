/**
 * Lightbox — visionneuse plein écran.
 * Clic simple = sélection dans la grille ; double-clic = ici.
 *
 * - ← / → : navigation (boutons + clavier), Échap : fermer, E : éditer
 * - Molette : zoom continu (jusqu'à 5×) centré sous le curseur
 * - Double-clic : bascule ajusté ↔ 100 % (pixels réels, via thumb://library/orig)
 * - Glisser : déplacement dans l'image zoomée
 * - Notation ★ directe, bouton Éditer, compteur position/total
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PhotoRow, RendererApi } from '@shared/ipc'

declare global {
  interface Window {
    api: RendererApi
  }
}

export default function Lightbox({
  photos,
  index,
  onIndexChange,
  onClose,
  onEdit,
  onRate
}: {
  photos: PhotoRow[]
  index: number
  onIndexChange: (i: number) => void
  onClose: () => void
  onEdit: (photo: PhotoRow) => void
  onRate: (photoId: number, rating: number) => void
}): JSX.Element | null {
  const photo = photos[index]
  const [zoom, setZoom] = useState(1) // 1 = ajusté à l'écran
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [fullLoaded, setFullLoaded] = useState(false)
  const imgRef = useRef<HTMLImageElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null)

  const reset = useCallback(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
    setFullLoaded(false)
  }, [])

  const go = useCallback(
    (delta: number) => {
      const next = index + delta
      if (next >= 0 && next < photos.length) {
        reset()
        onIndexChange(next)
      }
    },
    [index, photos.length, onIndexChange, reset]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') go(-1)
      else if (e.key === 'ArrowRight') go(1)
      else if (e.key.toLowerCase() === 'e' && photo) onEdit(photo)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go, onClose, onEdit, photo])

  if (!photo) return null

  /** Échelle correspondant au 100 % (pixels réels / taille affichée en fit). */
  const scale100 = (): number => {
    const img = imgRef.current
    if (!img || !img.naturalWidth) return 2.5
    const fitW = img.getBoundingClientRect().width / zoom
    return Math.max(1.2, img.naturalWidth / fitW)
  }

  const clampPan = (p: { x: number; y: number }, z: number): { x: number; y: number } => {
    const img = imgRef.current
    const box = boxRef.current
    if (!img || !box) return p
    const r = img.getBoundingClientRect()
    const maxX = Math.max(0, (r.width - box.clientWidth) / 2 + 40)
    const maxY = Math.max(0, (r.height - box.clientHeight) / 2 + 40)
    void z
    return { x: Math.min(maxX, Math.max(-maxX, p.x)), y: Math.min(maxY, Math.max(-maxY, p.y)) }
  }

  const onWheel = (e: React.WheelEvent): void => {
    e.preventDefault()
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
    const next = Math.min(5, Math.max(1, zoom * factor))
    if (next > 1.01 && !fullLoaded) setFullLoaded(true) // charge l'original dès qu'on zoome
    if (next <= 1.01) {
      reset()
      setFullLoaded(fullLoaded) // garde l'original si déjà chargé
      setZoom(1)
      setPan({ x: 0, y: 0 })
    } else {
      setZoom(next)
      setPan((p) => clampPan(p, next))
    }
  }

  const onDoubleClick = (): void => {
    if (zoom > 1.01) {
      setZoom(1)
      setPan({ x: 0, y: 0 })
    } else {
      setFullLoaded(true)
      setZoom(scale100())
    }
  }

  const onMouseDown = (e: React.MouseEvent): void => {
    if (zoom <= 1.01) return
    drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }
  }
  const onMouseMove = (e: React.MouseEvent): void => {
    if (!drag.current) return
    setPan(
      clampPan(
        { x: drag.current.px + (e.clientX - drag.current.x), y: drag.current.py + (e.clientY - drag.current.y) },
        zoom
      )
    )
  }
  const endDrag = (): void => {
    drag.current = null
  }

  const src = fullLoaded
    ? `thumb://library/orig/${photo.id}`
    : `thumb://library/1024/${photo.id}?v=${photo.hash_xxh3}`

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: '#0b1220f2',
        zIndex: 90,
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      {/* Barre du haut */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 16px',
          background: '#0f172a',
          borderBottom: '1px solid #334155'
        }}
      >
        <button onClick={onClose} title="Fermer (Échap)">
          ← Bibliothèque
        </button>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{photo.filename}</span>
        <span style={{ fontSize: 12, color: '#94a3b8' }}>
          {index + 1} / {photos.length}
        </span>
        <span style={{ fontSize: 14, letterSpacing: 2, cursor: 'pointer', userSelect: 'none' }}>
          {[1, 2, 3, 4, 5].map((n) => (
            <span
              key={n}
              onClick={() => onRate(photo.id, photo.rating === n ? 0 : n)}
              style={{ color: n <= photo.rating ? '#f5c518' : '#475569' }}
            >
              ★
            </span>
          ))}
        </span>
        <span style={{ flex: 1 }} />
        {zoom > 1.01 && (
          <span style={{ fontSize: 12, color: '#94a3b8' }}>{Math.round(zoom * 100)} % — glisser pour naviguer</span>
        )}
        <button className="primary" onClick={() => onEdit(photo)} title="Ouvrir dans l'éditeur (E)">
          ✎ Éditer
        </button>
      </div>

      {/* Image */}
      <div
        ref={boxRef}
        onWheel={onWheel}
        onDoubleClick={onDoubleClick}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
        style={{
          flex: 1,
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: zoom > 1.01 ? (drag.current ? 'grabbing' : 'grab') : 'zoom-in',
          position: 'relative'
        }}
      >
        <img
          ref={imgRef}
          src={src}
          alt={photo.filename}
          draggable={false}
          style={{
            maxWidth: '96%',
            maxHeight: '96%',
            objectFit: 'contain',
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transition: drag.current ? 'none' : 'transform 0.12s ease',
            userSelect: 'none',
            boxShadow: '0 8px 40px #000a'
          }}
        />
        {/* Flèches */}
        {index > 0 && (
          <button
            onClick={() => go(-1)}
            style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', fontSize: 20, padding: '14px 16px', borderRadius: 12 }}
            title="Précédente (←)"
          >
            ‹
          </button>
        )}
        {index < photos.length - 1 && (
          <button
            onClick={() => go(1)}
            style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)', fontSize: 20, padding: '14px 16px', borderRadius: 12 }}
            title="Suivante (→)"
          >
            ›
          </button>
        )}
      </div>

      <div style={{ textAlign: 'center', fontSize: 11, color: '#64748b', padding: '6px 0', background: '#0f172a' }}>
        Molette : zoom · Double-clic : 100 % · ← → : naviguer · E : éditer · Échap : fermer
      </div>
    </div>
  )
}
