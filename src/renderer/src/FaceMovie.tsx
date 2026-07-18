import { useCallback, useEffect, useRef, useState } from 'react'
import type { PhotoRow, FaceLite } from '@shared/ipc'

/**
 * Face Movie — diaporama spécial centré sur un visage.
 *
 * Réutilise la logique de Slideshow.tsx mais avec un mode "face focus" :
 * - La caméra zoome sur la bounding box du visage (box_x, box_y, box_w, box_h
 *   normalisés 0-1) au lieu de la photo entière.
 * - Effet Ken Burns adapté : le pan et le zoom restent centrés sur le visage.
 * - Crossfade entre les photos comme le diaporama normal.
 * - Lancé depuis la vue d'une personne (clic sur "Face Movie").
 */

/** Un calque d'image pour le crossfade — deux calques alternent. */
interface SlideLayer {
  photoIndex: number
  loaded: boolean
}

/** Paramètre d'animation Ken Burns prégénéré par photo. */
interface KenBurnsParams {
  startScale: number
  endScale: number
  panX: number // déplacement normalisé -1..1 (relatif au visage)
  panY: number
}

/** Carte photoId → bounding box du visage (normalisée 0-1). */
type FaceBoxMap = Map<number, { x: number; y: number; w: number; h: number }>

/** Génère des paramètres aléatoires mais déterministes pour une photo. */
function generateKenBurns(seed: number): KenBurnsParams {
  let h = seed
  h = (h * 9301 + 49297) % 233280
  const rand1 = h / 233280
  h = (h * 9301 + 49297) % 233280
  const rand2 = h / 233280
  h = (h * 9301 + 49297) % 233280
  const rand3 = h / 233280
  h = (h * 9301 + 49297) % 233280
  const rand4 = h / 233280

  // Zoom plus doux que le slideshow normal car on est déjà zoomé sur le visage
  const zoomIn = rand1 > 0.5
  const startScale = zoomIn ? 1.0 : 1.1
  const endScale = zoomIn ? 1.1 : 1.0

  // Pan d'amplitude réduite pour rester près du visage
  const panX = (rand2 - 0.5) * 0.06
  const panY = (rand3 - 0.5) * 0.06

  return { startScale, endScale, panX, panY }
}

const DEFAULT_DURATION = 5
const CROSSFADE_MS = 600
const MIN_DURATION = 2
const MAX_DURATION = 15

/**
 * Calcule le transform CSS pour l'effet Ken Burns centré sur le visage.
 *
 * Le visage est défini par sa bounding box normalisée (x, y, w, h) dans
 * l'image source. On calcule un transform-origin au centre du visage et
 * un scale de base qui cadre le visage, puis on applique le Ken Burns
 * par-dessus.
 */
function faceFocusTransform(
  kb: KenBurnsParams,
  p: number,
  faceBox: { x: number; y: number; w: number; h: number } | undefined
): string {
  if (!faceBox) {
    // Pas de boîte de visage → fallback: Ken Burns normal centré
    const scale = kb.startScale + (kb.endScale - kb.startScale) * p
    const tx = kb.panX * p * 100
    const ty = kb.panY * p * 100
    return `scale(${scale.toFixed(4)}) translate(${tx.toFixed(2)}%, ${ty.toFixed(2)}%)`
  }

  // Centre du visage en coordonnées normalisées 0-1
  const faceCx = faceBox.x + faceBox.w / 2
  const faceCy = faceBox.y + faceBox.h / 2

  // Scale de base pour que le visage occupe ~60% de l'écran
  // Si le visage fait 30% de la photo (w=0.3), on zoome à ~2x pour qu'il
  // fasse 60% de la vue. Limité pour les très petits visages.
  const baseZoom = Math.min(4, Math.max(1.2, 0.6 / faceBox.w))

  // Ken Burns se superpose au zoom de base
  const kbScale = kb.startScale + (kb.endScale - kb.startScale) * p
  const totalScale = baseZoom * kbScale

  // Pan : amplitude réduite, exprimée en % du conteneur
  const tx = kb.panX * p * 100
  const ty = kb.panY * p * 100

  return `scale(${totalScale.toFixed(4)}) translate(${tx.toFixed(2)}%, ${ty.toFixed(2)}%)`
}

/**
 * Calcule le transform-origin pour qu'il pointe vers le centre du visage.
 * Les coordonnées sont en % de l'image affichée (object-fit: contain).
 */
function faceTransformOrigin(
  faceBox: { x: number; y: number; w: number; h: number } | undefined
): string {
  if (!faceBox) return 'center center'
  const cxPct = (faceBox.x + faceBox.w / 2) * 100
  const cyPct = (faceBox.y + faceBox.h / 2) * 100
  return `${cxPct.toFixed(2)}% ${cyPct.toFixed(2)}%`
}

export default function FaceMovie({
  photos,
  faces,
  onClose
}: {
  photos: PhotoRow[]
  faces: FaceLite[]
  onClose: () => void
}): JSX.Element {
  // Construire la map photoId → faceBox au montage
  const faceBoxMap = useRef<FaceBoxMap>(new Map())
  if (faceBoxMap.current.size === 0 && faces.length > 0) {
    for (const f of faces) {
      // Prendre le premier visage par photo (le plus confiant est déjà trié
      // côté SQL, mais faces:byPerson trie par confiance ASC — on veut le
      // plus confiant, donc on garde le dernier vu si doublon)
      faceBoxMap.current.set(f.photo_id, {
        x: f.bbox_x,
        y: f.bbox_y,
        w: f.bbox_w,
        h: f.bbox_h
      })
    }
  }

  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [duration, setDuration] = useState(DEFAULT_DURATION)
  const [progress, setProgress] = useState(0)
  const [kenBurns, setKenBurns] = useState<KenBurnsParams>(() =>
    generateKenBurns(photos[0]?.id ?? 0)
  )

  const [layers, setLayers] = useState<SlideLayer[]>([
    { photoIndex: 0, loaded: false },
    { photoIndex: -1, loaded: false }
  ])
  const [activeLayer, setActiveLayer] = useState(0)

  const rafRef = useRef<number>(0)
  const startTimeRef = useRef<number>(0)
  const transitioningRef = useRef<boolean>(false)
  const indexRef = useRef(0)
  const playingRef = useRef(true)
  const durationRef = useRef(DEFAULT_DURATION)

  indexRef.current = index
  playingRef.current = playing
  durationRef.current = duration

  const next = useCallback(
    (delta: number) => {
      const n = photos.length
      if (n === 0) return
      const newIndex = (indexRef.current + delta + n) % n
      setKenBurns(generateKenBurns(photos[newIndex]?.id ?? 0))
      setProgress(0)
      startTimeRef.current = performance.now()
      transitioningRef.current = true

      const nextLayer = activeLayer === 0 ? 1 : 0
      setLayers((prev) => {
        const updated = [...prev]
        updated[nextLayer] = { photoIndex: newIndex, loaded: false }
        return updated
      })

      setTimeout(() => {
        setActiveLayer(nextLayer)
        setIndex(newIndex)
        transitioningRef.current = false
      }, CROSSFADE_MS)
    },
    [photos, activeLayer]
  )

  // Boucle d'animation
  useEffect(() => {
    const tick = (now: number): void => {
      if (playingRef.current && !transitioningRef.current) {
        const elapsed = (now - startTimeRef.current) / 1000
        const dur = durationRef.current
        const p = Math.min(1, elapsed / dur)
        setProgress(p)

        if (p >= 1) {
          startTimeRef.current = now
          next(1)
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    startTimeRef.current = performance.now()
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [next])

  // Clavier
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight') next(1)
      else if (e.key === 'ArrowLeft') next(-1)
      else if (e.key === ' ') {
        e.preventDefault()
        setPlaying((p) => !p)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [next, onClose])

  // Reset timer quand on change la durée
  useEffect(() => {
    startTimeRef.current = performance.now()
    setProgress(0)
  }, [duration])

  if (photos.length === 0) return <></>

  const currentPhoto = photos[index]
  const currentFaceBox = faceBoxMap.current.get(currentPhoto?.id ?? -1)

  const renderLayer = (layerIdx: number): JSX.Element => {
    const layer = layers[layerIdx]
    const isActive = activeLayer === layerIdx && layer.loaded
    const photoIdx = layer.photoIndex
    const photo = photoIdx >= 0 ? photos[photoIdx] : null
    const faceBox = photo ? faceBoxMap.current.get(photo.id) : undefined

    return (
      <img
        src={
          photo
            ? `thumb://library/1024/${photo.id}?v=${photo.hash_xxh3}`
            : ''
        }
        alt=""
        onLoad={() =>
          setLayers((prev) => {
            const updated = [...prev]
            updated[layerIdx] = { ...updated[layerIdx], loaded: true }
            return updated
          })
        }
        style={{
          position: 'absolute',
          maxWidth: '100%',
          maxHeight: '100%',
          objectFit: 'contain' as const,
          opacity: isActive ? 1 : 0,
          transition: `opacity ${CROSSFADE_MS}ms ease-in-out`,
          transform: isActive
            ? faceFocusTransform(kenBurns, progress, faceBox)
            : 'scale(1)',
          transformOrigin: faceTransformOrigin(faceBox),
          willChange: 'transform, opacity'
        }}
      />
    )
  }

  return (
    <div
      onClick={(e) => {
        if ((e.target as HTMLElement).dataset.slideshowcontrols) return
        setPlaying((p) => !p)
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: '#000',
        zIndex: 1020,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        overflow: 'hidden'
      }}
    >
      {renderLayer(0)}
      {renderLayer(1)}

      {/* Barre de progression */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          height: 3,
          background: '#333333'
        }}
      >
        <div
          style={{
            height: '100%',
            background: 'var(--accent)',
            width: `${progress * 100}%`,
            transition: playing ? 'none' : 'width 0.2s ease'
          }}
        />
      </div>

      {/* Contrôles en bas */}
      <div
        data-slideshowcontrols="true"
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          bottom: 16,
          left: 0,
          right: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 8
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            background: '#000000aa',
            borderRadius: 999,
            padding: '8px 16px',
            backdropFilter: 'blur(8px)'
          }}
        >
          <button
            onClick={() => next(-1)}
            title="Précédente (←)"
            style={{ padding: '6px 12px', fontSize: 16 }}
          >
            ‹
          </button>
          <button
            onClick={() => setPlaying((p) => !p)}
            title="Lecture/Pause (Espace)"
            style={{ padding: '6px 14px', fontSize: 16 }}
          >
            {playing ? '⏸' : '▶'}
          </button>
          <button
            onClick={() => next(1)}
            title="Suivante (→)"
            style={{ padding: '6px 12px', fontSize: 16 }}
          >
            ›
          </button>
          <span
            style={{
              color: '#fffa',
              fontSize: 13,
              textShadow: '0 1px 4px #000',
              userSelect: 'none'
            }}
          >
            {index + 1}/{photos.length}
          </span>
          <span
            style={{
              color: '#fffa',
              fontSize: 12,
              textShadow: '0 1px 4px #000',
              userSelect: 'none',
              maxWidth: 300,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            🎬 Face Movie — {currentPhoto?.filename}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span
              style={{
                fontSize: 11,
                color: '#94a3b8',
                userSelect: 'none'
              }}
            >
              Durée
            </span>
            <input
              type="range"
              min={MIN_DURATION}
              max={MAX_DURATION}
              step={1}
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              style={{ width: 80, padding: 0 }}
            />
            <span
              style={{
                fontSize: 11,
                color: '#94a3b8',
                userSelect: 'none',
                minWidth: 30
              }}
            >
              {duration}s
            </span>
          </span>
          <button
            onClick={onClose}
            title="Quitter (Échap)"
            style={{ padding: '6px 12px', fontSize: 13 }}
          >
            ✕
          </button>
        </div>
        <div
          style={{
            fontSize: 11,
            color: '#94a3b8',
            textShadow: '0 1px 4px #000',
            userSelect: 'none'
          }}
        >
          Face Movie · Espace : pause · ← → : naviguer · Échap : quitter
        </div>
      </div>
    </div>
  )
}