import { useCallback, useEffect, useRef, useState } from 'react'
import type { PhotoRow } from '@shared/ipc'

/** Diaporama plein écran : fondu, lecture auto, flèches, Échap. */
export default function Slideshow({
  photos,
  onClose
}: {
  photos: PhotoRow[]
  onClose: () => void
}): JSX.Element {
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [fade, setFade] = useState(true)
  const timer = useRef<ReturnType<typeof setInterval>>()

  const go = useCallback(
    (delta: number) => {
      setFade(false)
      setTimeout(() => {
        setIndex((i) => (i + delta + photos.length) % photos.length)
        setFade(true)
      }, 180)
    },
    [photos.length]
  )

  useEffect(() => {
    clearInterval(timer.current)
    if (playing) timer.current = setInterval(() => go(1), 4000)
    return () => clearInterval(timer.current)
  }, [playing, go])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowRight') go(1)
      if (e.key === 'ArrowLeft') go(-1)
      if (e.key === ' ') setPlaying((p) => !p)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go, onClose])

  if (photos.length === 0) return <></>
  const photo = photos[index]

  return (
    <div
      onClick={() => setPlaying((p) => !p)}
      style={{
        position: 'fixed',
        inset: 0,
        background: '#000',
        zIndex: 200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer'
      }}
    >
      <img
        src={`thumb://library/1024/${photo.id}`}
        alt={photo.filename}
        style={{
          maxWidth: '100%',
          maxHeight: '100%',
          objectFit: 'contain',
          opacity: fade ? 1 : 0,
          transition: 'opacity 0.18s ease'
        }}
      />
      <div
        style={{
          position: 'absolute',
          bottom: 16,
          left: 0,
          right: 0,
          textAlign: 'center',
          fontSize: 13,
          color: '#fffa',
          textShadow: '0 1px 4px #000'
        }}
      >
        {playing ? '▶' : '⏸'} {index + 1}/{photos.length} — {photo.filename} · Espace : pause ·
        ←/→ : naviguer · Échap : quitter
      </div>
    </div>
  )
}
