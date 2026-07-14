/**
 * ThumbCanvas — remplace <img> par <canvas> pour le rendu des vignettes.
 *
 * Avantages par rapport à <img> :
 * - Pas de layout/reflow DOM pour les images (canvas = taille fixe)
 * - Décodage image off-main-thread possible (createImageBitmap si dispo)
 * - Moins d'éléments DOM = moins de pressure sur React reconciliation
 * - Le canvas peut être réutilisé (clear + redraw) au scroll
 *
 * Conservé de ThumbImg :
 * - Retry exponentiel (500 ms → 1 s → 2 s → 4 s → 8 s, puis abandon)
 * - objectFit cover/contain (calculé manuellement pour le canvas)
 * - Protocole thumb://library/{size}/{photoId}?v={hash}
 * - Cache navigateur immutable (Image() charge depuis le cache)
 * - Lazy loading via la virtualisation TanStack Virtual
 */
import { useCallback, useEffect, useRef } from 'react'

interface ThumbCanvasProps {
  photoId: number
  v?: string
  size?: number
  alt?: string
  style?: React.CSSProperties
  onClick?: (e: React.MouseEvent) => void
  onDoubleClick?: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  loading?: 'lazy' | 'eager'
  fitMode?: 'cover' | 'contain'
}

const MAX_RETRIES = 5

export default function ThumbCanvas({
  photoId,
  v,
  size = 256,
  alt,
  style,
  onClick,
  onDoubleClick,
  onContextMenu,
  loading = 'lazy',
  fitMode = 'cover'
}: ThumbCanvasProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imgRef = useRef<HTMLImageElement | ImageBitmap | null>(null)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attemptRef = useRef(0)
  const sizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 })
  const loadingUrlRef = useRef<string>('')

  const buildSrc = useCallback((attempt: number): string => {
    return `thumb://library/${size}/${photoId}?v=${v ?? ''}${attempt > 0 ? `&_retry=${attempt}` : ''}`
  }, [size, photoId, v])

  /**
   * Dessine l'image chargée sur le canvas en respectant fitMode (cover/contain).
   * Gère le devicePixelRatio pour un rendu net sur écrans HiDPI.
   */
  const draw = useCallback((): void => {
    const canvas = canvasRef.current
    const img = imgRef.current
    const { w, h } = sizeRef.current
    if (!canvas || !img || w === 0 || h === 0) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    const iw = (img as HTMLImageElement).naturalWidth || (img as ImageBitmap).width
    const ih = (img as HTMLImageElement).naturalHeight || (img as ImageBitmap).height
    if (iw === 0 || ih === 0) return

    const containerRatio = w / h
    const imageRatio = iw / ih
    let drawW: number
    let drawH: number
    let drawX: number
    let drawY: number

    if (fitMode === 'cover') {
      if (imageRatio > containerRatio) {
        drawH = h
        drawW = drawH * imageRatio
        drawX = (w - drawW) / 2
        drawY = 0
      } else {
        drawW = w
        drawH = drawW / imageRatio
        drawX = 0
        drawY = (h - drawH) / 2
      }
    } else {
      // contain
      if (imageRatio > containerRatio) {
        drawW = w
        drawH = drawW / imageRatio
        drawX = 0
        drawY = (h - drawH) / 2
      } else {
        drawH = h
        drawW = drawH * imageRatio
        drawX = (w - drawW) / 2
        drawY = 0
      }
    }

    ctx.drawImage(img as CanvasImageSource, drawX * dpr, drawY * dpr, drawW * dpr, drawH * dpr)
  }, [fitMode])

  /**
   * Charge l'image depuis thumb://. Tente createImageBitmap (décodage
   * off-main-thread) si disponible, sinon fallback sur Image().
   * Retry exponentiel en cas d'échec (miniature pas encore prête).
   */
  const loadImage = useCallback((attempt: number): void => {
    const src = buildSrc(attempt)
    loadingUrlRef.current = src

    const onSuccess = (img: HTMLImageElement | ImageBitmap): void => {
      // Ignore si l'URL a changé entre-temps (changement de photo)
      if (loadingUrlRef.current !== src) return
      imgRef.current = img
      draw()
    }

    const onError = (): void => {
      if (loadingUrlRef.current !== src) return
      if (attempt < MAX_RETRIES) {
        const delay = 500 * Math.pow(2, attempt)
        if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
        retryTimerRef.current = setTimeout(() => {
          attemptRef.current = attempt + 1
          loadImage(attempt + 1)
        }, delay)
      }
    }

    // createImageBitmap : décodage hors du main thread (si supporté)
    if (typeof createImageBitmap === 'function') {
      fetch(src)
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          return res.blob()
        })
        .then((blob) => createImageBitmap(blob))
        .then(onSuccess)
        .catch(() => {
          // Fallback sur Image() si createImageBitmap échoue
          const img = new Image()
          img.onload = () => onSuccess(img)
          img.onerror = onError
          img.src = src
        })
    } else {
      const img = new Image()
      img.onload = () => onSuccess(img)
      img.onerror = onError
      img.src = src
    }
  }, [buildSrc, draw])

  // Chargement initial + cleanup
  useEffect(() => {
    attemptRef.current = 0
    loadImage(0)
    return () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
      // Annule le chargement en cours en réinitialisant l'URL
      loadingUrlRef.current = ''
    }
  }, [loadImage])

  // ResizeObserver pour suivre la taille du conteneur et redessiner
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries: ResizeObserverEntry[]) => {
      const entry = entries[0]
      if (entry) {
        sizeRef.current = {
          w: entry.contentRect.width,
          h: entry.contentRect.height
        }
        draw()
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [draw])

  // le prop `loading` est géré par la virtualisation TanStack Virtual
  // (seules les vignettes visibles sont montées) — pas de lazy loading natif
  void loading

  return (
    <div
      ref={containerRef}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e: React.MouseEvent) => {
        e.preventDefault()
        onContextMenu?.(e)
      }}
      style={style}
      role="img"
      aria-label={alt}
    >
      <canvas
        ref={canvasRef}
        style={{ display: 'block', width: '100%', height: '100%' }}
      />
    </div>
  )
}