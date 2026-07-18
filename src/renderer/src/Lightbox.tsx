/**
 * Lightbox — visionneuse plein écran.
 * Clic simple = sélection dans la grille ; double-clic = ici.
 *
 * - ← / → : navigation (boutons + clavier), Échap : fermer, E : éditer (images)
 * - Molette : zoom continu (jusqu'à 5×) centré sous le curseur (images)
 * - Double-clic : bascule ajusté ↔ 100 % (pixels réels, via thumb://library/orig)
 * - Glisser : déplacement dans l'image zoomée
 * - Notation ★ directe, bouton Éditer (images), compteur position/total
 * - Vidéos (media_type='video') : lecteur natif avec contrôles, pas de
 *   zoom/pan/édition — thumb://library/orig/{id} sert le fichier original,
 *   quel que soit le média.
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
  const isVideo = photo?.media_type === 'video'
  const [zoom, setZoom] = useState(1) // 1 = ajusté à l'écran
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [fullLoaded, setFullLoaded] = useState(false)
  const imgRef = useRef<HTMLImageElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null)
  const [extracting, setExtracting] = useState(false)
  const [extractFlash, setExtractFlash] = useState(false)
  const [trimStartMs, setTrimStartMs] = useState<number | null>(photo?.trim_start_ms ?? null)
  const [trimEndMs, setTrimEndMs] = useState<number | null>(photo?.trim_end_ms ?? null)

  // Réinitialise l'état de découpe affiché quand on change de photo
  useEffect(() => {
    setTrimStartMs(photo?.trim_start_ms ?? null)
    setTrimEndMs(photo?.trim_end_ms ?? null)
  }, [photo?.id])

  const saveTrim = (startMs: number | null, endMs: number | null): void => {
    setTrimStartMs(startMs)
    setTrimEndMs(endMs)
    void window.api.invoke('photos:setTrim', {
      photoId: photo.id,
      trimStartMs: startMs,
      trimEndMs: endMs
    })
  }

  // Applique la découpe pendant la lecture : démarre au point de début,
  // revient au début quand le point de fin est atteint (boucle dans la
  // zone découpée) — donne un retour immédiat que la découpe fonctionne,
  // sans jamais toucher au fichier original.
  useEffect(() => {
    const v = videoRef.current
    if (!v || !isVideo) return
    const onLoaded = (): void => {
      if (trimStartMs !== null) v.currentTime = trimStartMs / 1000
    }
    const onTimeUpdate = (): void => {
      if (trimEndMs !== null && v.currentTime >= trimEndMs / 1000) {
        v.currentTime = (trimStartMs ?? 0) / 1000
      }
    }
    v.addEventListener('loadedmetadata', onLoaded)
    v.addEventListener('timeupdate', onTimeUpdate)
    return () => {
      v.removeEventListener('loadedmetadata', onLoaded)
      v.removeEventListener('timeupdate', onTimeUpdate)
    }
  }, [photo?.id, isVideo, trimStartMs, trimEndMs])


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
      else if (e.key.toLowerCase() === 'e' && photo && !isVideo) onEdit(photo)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go, onClose, onEdit, photo, isVideo])

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
    if (isVideo) return
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
    if (isVideo) return
    if (zoom > 1.01) {
      setZoom(1)
      setPan({ x: 0, y: 0 })
    } else {
      setFullLoaded(true)
      setZoom(scale100())
    }
  }

  const onMouseDown = (e: React.MouseEvent): void => {
    if (isVideo || zoom <= 1.01) return
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
        // 1050 : au-dessus de tout le reste de l'app, y compris les
        // overlays de MapView (jusqu'à 1000, bannière « pas de connexion »)
        // et les panneaux/contrôles internes de Leaflet — la Lightbox
        // ouverte depuis la Carte se retrouvait sinon visuellement
        // derrière la carte (z-index 90 auparavant, plus bas que tout).
        zIndex: 1050,
        display: 'flex',
        flexDirection: 'column',
        // Couleur de texte forcée par défaut, quel que soit le thème
        // (clair/sombre) : même cause que le bug de contraste de l'éditeur
        // (2.14.2) — sans ceci, tout texte qui oublie de fixer sa propre
        // couleur hérite de --text, gris FONCÉ en thème clair, sur ce fond
        // sombre = illisible.
        color: '#e2e8f0'
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
          borderBottom: '1px solid #334155',
          color: '#e2e8f0'
        }}
      >
        <button onClick={onClose} title="Fermer (Échap)">
          ← Bibliothèque
        </button>
        <span style={{ fontSize: 14, fontWeight: 600, color: '#e2e8f0' }}>{photo.filename}</span>
        <span style={{ fontSize: 12, color: '#cbd5e1' }}>
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
        {!isVideo && zoom > 1.01 && (
          <span style={{ fontSize: 12, color: '#cbd5e1' }}>{Math.round(zoom * 100)} % — glisser pour naviguer</span>
        )}
        {!isVideo && (
          <button className="primary" onClick={() => onEdit(photo)} title="Ouvrir dans l'éditeur (E)">
            ✎ Éditer
          </button>
        )}
      </div>

      {/* Média : vidéo (lecteur natif) ou image (zoom/pan) */}
      {isVideo ? (
        <>
        <div
          style={{
            flex: 1,
            overflow: 'hidden',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
            background: '#000'
          }}
        >
          <video
            key={photo.id}
            ref={videoRef}
            src={`thumb://library/orig/${photo.id}`}
            controls
            autoPlay
            style={{ maxWidth: '96%', maxHeight: '96%', boxShadow: '0 8px 40px #000a' }}
          />
          <button
            onClick={async () => {
              const v = videoRef.current
              if (!v || extracting) return
              setExtracting(true)
              try {
                await window.api.invoke('video:extractFrame', {
                  photoId: photo.id,
                  atSeconds: v.currentTime
                })
                setExtractFlash(true)
                setTimeout(() => setExtractFlash(false), 2000)
              } catch (err) {
                alert(`Échec de l'extraction : ${(err as Error).message}`)
              } finally {
                setExtracting(false)
              }
            }}
            disabled={extracting}
            style={{ position: 'absolute', top: 14, right: 14, fontSize: 13 }}
            title="Extraire l'image affichée comme nouvelle photo dans la bibliothèque"
          >
            {extracting ? '⏳ Extraction…' : extractFlash ? '✔ Image extraite' : '📷 Extraire cette image'}
          </button>
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
        {/* ---- Découpe (trim) non destructive ---- */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            padding: '8px 0',
            background: '#0f172a',
            fontSize: 12,
            color: '#cbd5e1'
          }}
        >
          <span>✂ Découpe :</span>
          <span>
            {trimStartMs !== null ? (trimStartMs / 1000).toFixed(1) + 's' : 'début'}
            {' → '}
            {trimEndMs !== null ? (trimEndMs / 1000).toFixed(1) + 's' : 'fin'}
          </span>
          <button
            onClick={() => saveTrim(Math.round((videoRef.current?.currentTime ?? 0) * 1000), trimEndMs)}
            title="Marque l'instant actuel comme début de la découpe"
          >
            ⏱ Marquer début
          </button>
          <button
            onClick={() => saveTrim(trimStartMs, Math.round((videoRef.current?.currentTime ?? 0) * 1000))}
            title="Marque l'instant actuel comme fin de la découpe"
          >
            ⏱ Marquer fin
          </button>
          {(trimStartMs !== null || trimEndMs !== null) && (
            <button onClick={() => saveTrim(null, null)} title="Retire la découpe (vidéo intégrale)">
              ↺ Réinitialiser
            </button>
          )}
        </div>
        </>
      ) : (
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
      )}

      <div style={{ textAlign: 'center', fontSize: 12, color: '#cbd5e1', padding: '7px 0', background: '#0f172a' }}>
        {isVideo
          ? '← → : naviguer · Échap : fermer'
          : 'Molette : zoom · Double-clic : 100 % · ← → : naviguer · E : éditer · Échap : fermer'}
      </div>
    </div>
  )
}
