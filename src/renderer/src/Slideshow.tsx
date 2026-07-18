import { useCallback, useEffect, useRef, useState } from 'react'
import type { PhotoRow } from '@shared/ipc'

/**
 * Diaporama plein écran avec transitions Ken Burns.
 *
 * - Effet Ken Burns : zoom et pan progressif sur chaque photo
 * - Transitions fondus (crossfade) entre les photos
 * - Durée configurable par photo (5 s par défaut)
 * - Lecture/pause, navigation manuelle (flèches gauche/droite, espace)
 * - Utilise les miniatures 1024px (thumb://library/1024/{photoId})
 * - Parcourt les photos actuellement filtrées (celles dans la grille)
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
  panX: number // déplacement normalisé -1..1
  panY: number
}

/** Génère des paramètres aléatoires mais déterministes pour une photo. */
function generateKenBurns(seed: number): KenBurnsParams {
  // Hash simple pour seed déterministe
  let h = seed
  h = (h * 9301 + 49297) % 233280
  const rand1 = h / 233280
  h = (h * 9301 + 49297) % 233280
  const rand2 = h / 233280
  h = (h * 9301 + 49297) % 233280
  const rand3 = h / 233280
  h = (h * 9301 + 49297) % 233280
  const rand4 = h / 233280

  // Zoom de 1.0→1.15 ou 1.15→1.0 (direction aléatoire)
  const zoomIn = rand1 > 0.5
  const startScale = zoomIn ? 1.0 : 1.15
  const endScale = zoomIn ? 1.15 : 1.0

  // Pan direction aléatoire, amplitude modérée
  const panX = (rand2 - 0.5) * 0.12
  const panY = (rand3 - 0.5) * 0.12

  return { startScale, endScale, panX, panY }
}

const DEFAULT_DURATION = 5 // secondes par photo
const CROSSFADE_MS = 600 // durée du fondu
const MIN_DURATION = 2
const MAX_DURATION = 15

export default function Slideshow({
  photos,
  onClose
}: {
  photos: PhotoRow[]
  onClose: () => void
}): JSX.Element {
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [duration, setDuration] = useState(DEFAULT_DURATION)
  const [progress, setProgress] = useState(0) // 0..1 progression dans la photo courante
  const [kenBurns, setKenBurns] = useState<KenBurnsParams>(() => generateKenBurns(photos[0]?.id ?? 0))

  // Deux calques pour le crossfade
  const [layers, setLayers] = useState<SlideLayer[]>([
    { photoIndex: 0, loaded: false },
    { photoIndex: -1, loaded: false }
  ])
  const [activeLayer, setActiveLayer] = useState(0) // 0 ou 1

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

      // Crossfade : charger la nouvelle image sur l'autre calque
      const nextLayer = activeLayer === 0 ? 1 : 0
      setLayers((prev) => {
        const updated = [...prev]
        updated[nextLayer] = { photoIndex: newIndex, loaded: false }
        return updated
      })

      // Après le crossfade, basculer le calque actif
      setTimeout(() => {
        setActiveLayer(nextLayer)
        setIndex(newIndex)
        transitioningRef.current = false
      }, CROSSFADE_MS)
    },
    [photos, activeLayer]
  )

  // Boucle d'animation : Ken Burns + progression + auto-advance
  useEffect(() => {
    const tick = (now: number): void => {
      if (playingRef.current && !transitioningRef.current) {
        const elapsed = (now - startTimeRef.current) / 1000
        const dur = durationRef.current
        const p = Math.min(1, elapsed / dur)
        setProgress(p)

        if (p >= 1) {
          // Auto-advance
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

  /** Calcule le style transform pour l'effet Ken Burns. */
  const kenBurnsTransform = (kb: KenBurnsParams, p: number): string => {
    const scale = kb.startScale + (kb.endScale - kb.startScale) * p
    const tx = kb.panX * p * 100 // en % de la taille d'image
    const ty = kb.panY * p * 100
    return `scale(${scale.toFixed(4)}) translate(${tx.toFixed(2)}%, ${ty.toFixed(2)}%)`
  }

  const currentPhoto = photos[index]

  return (
    <div
      onClick={(e) => {
        // Clic sur la zone image = play/pause, mais pas sur les contrôles
        if ((e.target as HTMLElement).dataset.slideshowcontrols) return
        setPlaying((p) => !p)
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: '#000',
        zIndex: 200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        overflow: 'hidden'
      }}
    >
      {/* Calque 0 */}
      <img
        src={
          layers[0].photoIndex >= 0
            ? `thumb://library/1024/${photos[layers[0].photoIndex].id}?v=${photos[layers[0].photoIndex].hash_xxh3}`
            : ''
        }
        alt=""
        onLoad={() =>
          setLayers((prev) => {
            const updated = [...prev]
            updated[0] = { ...updated[0], loaded: true }
            return updated
          })
        }
        style={{
          position: 'absolute',
          maxWidth: '100%',
          maxHeight: '100%',
          objectFit: 'contain' as const,
          opacity: activeLayer === 0 && layers[0].loaded ? 1 : 0,
          transition: `opacity ${CROSSFADE_MS}ms ease-in-out`,
          transform: activeLayer === 0 ? kenBurnsTransform(kenBurns, progress) : 'scale(1)',
          transformOrigin: 'center center',
          willChange: 'transform, opacity'
        }}
      />
      {/* Calque 1 */}
      <img
        src={
          layers[1].photoIndex >= 0
            ? `thumb://library/1024/${photos[layers[1].photoIndex].id}?v=${photos[layers[1].photoIndex].hash_xxh3}`
            : ''
        }
        alt=""
        onLoad={() =>
          setLayers((prev) => {
            const updated = [...prev]
            updated[1] = { ...updated[1], loaded: true }
            return updated
          })
        }
        style={{
          position: 'absolute',
          maxWidth: '100%',
          maxHeight: '100%',
          objectFit: 'contain' as const,
          opacity: activeLayer === 1 && layers[1].loaded ? 1 : 0,
          transition: `opacity ${CROSSFADE_MS}ms ease-in-out`,
          transform: activeLayer === 1 ? kenBurnsTransform(kenBurns, progress) : 'scale(1)',
          transformOrigin: 'center center',
          willChange: 'transform, opacity'
        }}
      />

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
          <span style={{ color: '#fffa', fontSize: 13, textShadow: '0 1px 4px #000', userSelect: 'none' }}>
            {index + 1}/{photos.length}
          </span>
          <span style={{ color: '#fffa', fontSize: 12, textShadow: '0 1px 4px #000', userSelect: 'none', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {currentPhoto?.filename}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 11, color: '#94a3b8', userSelect: 'none' }}>Durée</span>
            <input
              type="range"
              min={MIN_DURATION}
              max={MAX_DURATION}
              step={1}
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              style={{ width: 80, padding: 0 }}
            />
            <span style={{ fontSize: 11, color: '#94a3b8', userSelect: 'none', minWidth: 30 }}>
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
          Espace : pause · ← → : naviguer · Échap : quitter · Clic : play/pause
        </div>
      </div>
    </div>
  )
}