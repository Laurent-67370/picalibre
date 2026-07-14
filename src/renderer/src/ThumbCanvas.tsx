/**
 * ThumbCanvas — remplace <img> par <canvas> pour le rendu des vignettes.
 *
 * Avantages par rapport à <img> :
 * - Pas de layout/reflow DOM pour les images (canvas = taille fixe)
 * - Décodage image off-main-thread via Web Worker (createImageBitmap)
 * - Moins d'éléments DOM = moins de pressure sur React reconciliation
 * - Le canvas peut être réutilisé (clear + redraw) au scroll
 *
 * Conservé de ThumbImg :
 * - Retry exponentiel (500 ms → 1 s → 2 s → 4 s → 8 s, puis abandon)
 * - objectFit cover/contain (calculé manuellement pour le canvas)
 * - Protocole thumb://library/{size}/{photoId}?v={hash}
 * - Cache navigateur immutable (Image() charge depuis le cache)
 * - Lazy loading via la virtualisation TanStack Virtual
 *
 * Optimisation 8 : Web Worker pour le décodage des miniatures.
 * Le worker reçoit l'URL thumb://, fait fetch + createImageBitmap, et
 * renvoie l'ImageBitmap au main thread (transférable, zero-copy).
 * Si le protocole thumb:// n'est pas accessible depuis le worker, on
 * bascule sur createImageBitmap + requestIdleCallback dans le main thread.
 */
import { useCallback, useEffect, useRef } from 'react'
import { thumbCache } from './thumb-cache'

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

/** Web Worker pour le décodage off-main-thread. */
let thumbWorker: Worker | null = null
let workerFailed = false

function getThumbWorker(): Worker | null {
  if (workerFailed) return null
  if (thumbWorker) return thumbWorker
  try {
    thumbWorker = new Worker(new URL('./thumb-decoder.worker.ts', import.meta.url), {
      type: 'module'
    })
    thumbWorker.onerror = (): void => {
      console.warn('[ThumbCanvas] Web Worker indisponible, fallback requestIdleCallback')
      workerFailed = true
      thumbWorker = null
    }
  } catch {
    workerFailed = true
    return null
  }
  return thumbWorker
}

/** requestIdleCallback — non standard sur tous les navigateurs, polyfill minimal. */
type IdleCallbackHandle = number
interface IdleDeadline {
  timeRemaining: () => number
  didTimeout: boolean
}
type IdleCallback = (deadline: IdleDeadline) => void
const _ric: typeof requestIdleCallback | undefined =
  typeof requestIdleCallback === 'function' ? requestIdleCallback : undefined
const _cic: typeof cancelIdleCallback | undefined =
  typeof cancelIdleCallback === 'function' ? cancelIdleCallback : undefined

function requestIdleCallbackCompat(cb: IdleCallback): IdleCallbackHandle {
  if (_ric) return _ric(cb)
  return setTimeout((): void => cb({ timeRemaining: () => 50, didTimeout: false }), 0) as unknown as IdleCallbackHandle
}

function cancelIdleCallbackCompat(handle: IdleCallbackHandle): void {
  if (_cic) return _cic(handle)
  clearTimeout(handle)
}

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
  const idleHandleRef = useRef<IdleCallbackHandle | null>(null)
  const workerRequestUrlRef = useRef<string>('')

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
   * Charge l'image depuis thumb://.
   * Tente d'abord le cache LRU (ImageBitmap déjà décodé).
   * Puis tente le Web Worker (décodage off-main-thread).
   * Si le worker échoue (protocole custom inaccessible), fallback sur
   * createImageBitmap + requestIdleCallback dans le main thread.
   * Retry exponentiel en cas d'échec (miniature pas encore prête).
   */
  const loadImage = useCallback((attempt: number): void => {
    const src = buildSrc(attempt)
    loadingUrlRef.current = src

    const onSuccess = (img: HTMLImageElement | ImageBitmap): void => {
      // Ignore si l'URL a changé entre-temps (changement de photo)
      if (loadingUrlRef.current !== src) return

      // Stocke dans le cache LRU si c'est un ImageBitmap
      if (img instanceof ImageBitmap) {
        thumbCache.set(photoId, size, img)
      }

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

    // 1. Vérifier le cache LRU en mémoire
    const cached = thumbCache.get(photoId, size)
    if (cached) {
      imgRef.current = cached
      draw()
      return
    }

    // 2. Tenter le Web Worker pour le décodage off-main-thread
    const worker = getThumbWorker()
    if (worker && !workerFailed) {
      const handler = (e: MessageEvent<{ bitmap?: ImageBitmap; error?: string; url: string }>): void => {
        if (e.data.url !== src) return // réponse d'une requête obsolète
        worker.removeEventListener('message', handler)

        if (e.data.bitmap) {
          onSuccess(e.data.bitmap)
        } else {
          // Le worker n'a pas pu accéder à thumb:// — fallback main thread
          fallbackMainThreadDecode(src, onSuccess, onError)
        }
      }
      worker.addEventListener('message', handler)
      workerRequestUrlRef.current = src
      worker.postMessage({ url: src })
      return
    }

    // 3. Fallback : createImageBitmap + requestIdleCallback dans le main thread
    fallbackMainThreadDecode(src, onSuccess, onError)
  }, [buildSrc, draw, photoId, size])

  /**
   * Fallback main thread : fetch blob + createImageBitmap avec requestIdleCallback
   * pour éviter de bloquer le main thread pendant le décodage.
   */
  const fallbackMainThreadDecode = useCallback((
    src: string,
    onSuccess: (img: HTMLImageElement | ImageBitmap) => void,
    onError: () => void
  ): void => {
    const doDecode = (): void => {
      if (typeof createImageBitmap === 'function') {
        fetch(src)
          .then((res: Response) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            return res.blob()
          })
          .then((blob: Blob) => createImageBitmap(blob))
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
    }

    // Programme le décodage pendant une période d'inactivité du main thread
    if (idleHandleRef.current) cancelIdleCallbackCompat(idleHandleRef.current)
    idleHandleRef.current = requestIdleCallbackCompat((): void => {
      idleHandleRef.current = null
      doDecode()
    })
  }, [])

  // Chargement initial + cleanup
  useEffect(() => {
    attemptRef.current = 0
    loadImage(0)
    return () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
      if (idleHandleRef.current) {
        cancelIdleCallbackCompat(idleHandleRef.current)
        idleHandleRef.current = null
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