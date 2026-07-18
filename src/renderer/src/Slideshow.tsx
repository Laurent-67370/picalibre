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
 *
 * Chaque calque porte SA PROPRE animation (kenBurns + startTime) — ni
 * l'un ni l'autre ne dépend d'un état partagé. Le fondu (crossfade)
 * n'est qu'un changement d'opacité ; le mouvement (zoom/pan) de chaque
 * calque continue sans interruption qu'il soit actif ou en train de
 * s'estomper, exactement comme un vrai diaporama Ken Burns à deux
 * calques (Picasa, iPhoto…). Avant cette refonte, un seul état
 * kenBurns/progress était partagé entre les deux calques et le calque
 * inactif retombait à `scale(1)` dès qu'il cessait d'être actif — un
 * saut visible juste au moment où le fondu démarrait.
 */

/** Un calque d'image pour le crossfade — deux calques alternent, chacun
 * avec sa propre animation, indépendante de l'autre calque. */
interface SlideLayer {
  photoIndex: number
  loaded: boolean
  kenBurns: KenBurnsParams
  startTime: number // performance.now() du démarrage de CE calque
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
const CROSSFADE_MS = 600 // durée du fondu (opacité uniquement)
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
  const [, forceRender] = useState(0) // force un re-render à chaque frame (rAF)

  // Deux calques pour le crossfade, chacun avec sa propre animation
  const [layers, setLayers] = useState<SlideLayer[]>([
    {
      photoIndex: 0,
      loaded: false,
      kenBurns: generateKenBurns(photos[0]?.id ?? 0),
      startTime: performance.now()
    },
    { photoIndex: -1, loaded: false, kenBurns: generateKenBurns(0), startTime: 0 }
  ])
  const [activeLayer, setActiveLayer] = useState(0) // 0 ou 1

  const rafRef = useRef<number>(0)
  const indexRef = useRef(0)
  const playingRef = useRef(true)
  const durationRef = useRef(DEFAULT_DURATION)
  const activeLayerRef = useRef(0)
  const layersRef = useRef(layers)
  const advancingRef = useRef(false) // anti-rebond (rAF + flèche simultanées)

  indexRef.current = index
  playingRef.current = playing
  durationRef.current = duration
  activeLayerRef.current = activeLayer
  layersRef.current = layers

  const next = useCallback(
    (delta: number) => {
      const n = photos.length
      if (n === 0) return
      const newIndex = (indexRef.current + delta + n) % n
      const nextLayerIdx = activeLayerRef.current === 0 ? 1 : 0
      const now = performance.now()

      // Le nouveau calque démarre SA PROPRE animation immédiatement — il
      // commence à zoomer/panoramiquer dès qu'il devient actif, sans
      // attendre la fin du fondu. Le calque sortant garde le sien intact
      // (kenBurns/startTime jamais touchés ici) : il continue son
      // mouvement sans interruption pendant qu'il s'estompe.
      setLayers((prev) => {
        const updated = [...prev]
        updated[nextLayerIdx] = {
          photoIndex: newIndex,
          loaded: false,
          kenBurns: generateKenBurns(photos[newIndex]?.id ?? 0),
          startTime: now
        }
        return updated
      })
      setActiveLayer(nextLayerIdx)
      setIndex(newIndex)
    },
    [photos]
  )

  // Boucle d'animation : force un re-render chaque frame (chaque calque
  // recalcule sa propre progression à partir de son propre startTime, voir
  // layerProgress()) et déclenche l'avance automatique quand le calque
  // actif a fini sa durée.
  useEffect(() => {
    const tick = (): void => {
      forceRender((t) => (t + 1) % 1_000_000)
      if (playingRef.current && !advancingRef.current) {
        const active = layersRef.current[activeLayerRef.current]
        const elapsed = (performance.now() - active.startTime) / 1000
        if (elapsed >= durationRef.current) {
          advancingRef.current = true
          next(1)
          // Laisse une frame se dérouler avant de réarmer, pour ne pas
          // redéclencher next() plusieurs fois sur la même transition.
          requestAnimationFrame(() => {
            advancingRef.current = false
          })
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }
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

  if (photos.length === 0) return <></>

  /** Calcule le style transform pour l'effet Ken Burns. */
  const kenBurnsTransform = (kb: KenBurnsParams, p: number): string => {
    const scale = kb.startScale + (kb.endScale - kb.startScale) * p
    const tx = kb.panX * p * 100 // en % de la taille d'image
    const ty = kb.panY * p * 100
    return `scale(${scale.toFixed(4)}) translate(${tx.toFixed(2)}%, ${ty.toFixed(2)}%)`
  }

  /** Progression 0..1 propre à CE calque, indépendante de l'autre. */
  const layerProgress = (layer: SlideLayer): number => {
    const elapsed = (performance.now() - layer.startTime) / 1000
    return Math.min(1, Math.max(0, elapsed / durationRef.current))
  }

  const currentPhoto = photos[index]
  const displayProgress = layerProgress(layers[activeLayer])

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
        zIndex: 1010,
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
          transform: kenBurnsTransform(layers[0].kenBurns, layerProgress(layers[0])),
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
          transform: kenBurnsTransform(layers[1].kenBurns, layerProgress(layers[1])),
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
            width: `${displayProgress * 100}%`,
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
