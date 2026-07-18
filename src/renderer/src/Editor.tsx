import { useCallback, useEffect, useRef, useState } from 'react'
import type { PhotoRow, RendererApi } from '@shared/ipc'
import {
  ColorOpType,
  EditOp,
  EditStack,
  FilterName,
  RedeyeZone,
  TextOpParams,
  BorderOpParams,
  BorderStyle,
  computeAutoColor,
  computeAutoContrast,
  emptyStack,
  getOp,
  getTextOp,
  getBorderOp,
  getTiltShiftParams,
  getHdrIntensity,
  TiltShiftParams,
  upsertOp
} from '@shared/edit-engine'
import { renderPreview } from './render-canvas'

declare global {
  interface Window {
    api: RendererApi
  }
}

const SLIDERS: Array<{ type: ColorOpType; label: string; min: number; max: number }> = [
  { type: 'fill_light', label: 'Lumière de remplissage', min: 0, max: 1 },
  { type: 'highlights', label: 'Hautes lumières', min: -1, max: 1 },
  { type: 'shadows', label: 'Ombres', min: -1, max: 1 },
  { type: 'contrast', label: 'Contraste', min: -1, max: 1 },
  { type: 'saturation', label: 'Saturation', min: -1, max: 1 },
  { type: 'vibrance', label: 'Vibrance', min: -1, max: 1 },
  { type: 'temperature', label: 'Température', min: -1, max: 1 },
  { type: 'hue', label: 'Teinte', min: -1, max: 1 }
]

const RATIOS: Array<{ label: string; value: number | null }> = [
  { label: 'Libre', value: null },
  { label: '1:1', value: 1 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:2', value: 3 / 2 },
  { label: '16:9', value: 16 / 9 }
]

/**
 * Effets avancés (section « EFFETS AVANCÉS ») : grille de boutons à
 * bascule plutôt que 8 curseurs toujours affichés — chaque effet ne
 * montre son curseur qu'une fois activé (valeur par défaut raisonnable
 * à l'activation, remis à 0 = retiré du stack à la désactivation).
 */
type EffectId =
  | 'blur'
  | 'sharpen'
  | 'vignette'
  | 'softfocus'
  | 'glow'
  | 'orton'
  | 'tiltshift'
  | 'hdr'
  | 'definition'

function isEffectActive(stack: EditStack, id: EffectId): boolean {
  switch (id) {
    case 'blur':
      return (getOp(stack, 'blur')?.params.radius ?? 0) > 0
    case 'sharpen':
      return (getOp(stack, 'sharpen')?.params.amount ?? 0) > 0
    case 'vignette':
      return (getOp(stack, 'vignette')?.params.intensity ?? 0) > 0
    case 'softfocus':
      return (getOp(stack, 'softfocus')?.params.intensity ?? 0) > 0
    case 'glow':
      return (getOp(stack, 'glow')?.params.intensity ?? 0) > 0
    case 'orton':
      return (getOp(stack, 'orton')?.params.intensity ?? 0) > 0
    case 'tiltshift':
      return (getOp(stack, 'tiltshift')?.params.blurRadius ?? 0) > 0
    case 'hdr':
      return (getOp(stack, 'hdr')?.params.intensity ?? 0) > 0
    case 'definition':
      return (getOp(stack, 'definition')?.params.amount ?? 0) > 0
  }
}

function toggleEffect(
  stack: EditStack,
  id: EffectId,
  applyOp: (op: EditOp, action: string) => void
): void {
  const active = isEffectActive(stack, id)
  switch (id) {
    case 'blur':
      applyOp({ type: 'blur', params: { radius: active ? 0 : 5 } }, 'blur')
      break
    case 'sharpen':
      applyOp({ type: 'sharpen', params: { amount: active ? 0 : 0.3 } }, 'sharpen')
      break
    case 'vignette':
      applyOp({ type: 'vignette', params: { intensity: active ? 0 : 0.4 } }, 'vignette')
      break
    case 'softfocus':
      applyOp({ type: 'softfocus', params: { intensity: active ? 0 : 0.4 } }, 'softfocus')
      break
    case 'glow':
      applyOp({ type: 'glow', params: { intensity: active ? 0 : 0.4 } }, 'glow')
      break
    case 'orton':
      applyOp({ type: 'orton', params: { intensity: active ? 0 : 0.4 } }, 'orton')
      break
    case 'tiltshift': {
      const cur =
        getOp(stack, 'tiltshift')?.params ??
        ({ mode: 'radial', focusX: 0.5, focusY: 0.5, focusRadius: 0.2, blurRadius: 0 } as TiltShiftParams)
      applyOp({ type: 'tiltshift', params: { ...cur, blurRadius: active ? 0 : 8 } }, 'tiltshift')
      break
    }
    case 'hdr':
      applyOp({ type: 'hdr', params: { intensity: active ? 0 : 0.4 } }, 'hdr')
      break
    case 'definition':
      applyOp({ type: 'definition', params: { amount: active ? 0 : 0.4 } }, 'definition')
      break
  }
}

interface CropRect {
  x: number
  y: number
  w: number
  h: number
}

type DragMode = 'move' | 'nw' | 'ne' | 'sw' | 'se' | null
type Tool = 'none' | 'white' | 'redeye' | 'retouch'

const FILTERS: Array<{ name: FilterName; label: string }> = [
  { name: 'bw', label: 'N&B' },
  { name: 'sepia', label: 'Sépia' },
  { name: 'warmify', label: 'Réchauffer' },
  { name: 'cool', label: 'Refroidir' },
  { name: 'invert', label: 'Négatif' },
  { name: 'posterize', label: 'Postériser' },
  { name: 'duotone', label: 'Duoton' },
  { name: 'crossprocess', label: 'Cross-process' },
  { name: 'grain', label: 'Grain de film' }
]

export default function Editor({
  photo,
  onClose
}: {
  photo: PhotoRow
  onClose: () => void
}): JSX.Element {
  const [stack, setStack] = useState<EditStack>(emptyStack())
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const [showOriginal, setShowOriginal] = useState(false)
  const [exportMsg, setExportMsg] = useState('')

  // Mode recadrage
  const [cropMode, setCropMode] = useState(false)
  const [cropRect, setCropRect] = useState<CropRect>({ x: 0, y: 0, w: 1, h: 1 })
  const [ratio, setRatio] = useState<number | null>(null)

  // Outils ponctuels
  const [tool, setTool] = useState<Tool>('none')
  const [retouchRadius, setRetouchRadius] = useState(0.03)
  const [pendingDefect, setPendingDefect] = useState<{ x: number; y: number } | null>(null)
  const dragRef = useRef<{ mode: DragMode; startX: number; startY: number; start: CropRect }>({
    mode: null,
    startX: 0,
    startY: 0,
    start: { x: 0, y: 0, w: 1, h: 1 }
  })

  const imgRef = useRef<HTMLImageElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const compareCanvasRef = useRef<HTMLCanvasElement>(null)
  const histRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef(0)
  const saveTimer = useRef<ReturnType<typeof setTimeout>>()

  const stackRef = useRef(stack)
  stackRef.current = stack
  const cropModeRef = useRef(cropMode)
  cropModeRef.current = cropMode
  const showOriginalRef = useRef(showOriginal)
  showOriginalRef.current = showOriginal
  const toolRef = useRef(tool)
  toolRef.current = tool
  // Côte à côte façon Picasa 3 : original et édité affichés simultanément
  // (plutôt que showOriginal, qui bascule entre les deux sur le même canvas —
  // resté inutilisé jusqu'ici, aucun bouton ne l'activait).
  const [compareMode, setCompareMode] = useState(false)
  const compareModeRef = useRef(compareMode)
  compareModeRef.current = compareMode
  const [copiedFlash, setCopiedFlash] = useState(false)
  const [tab, setTab] = useState<'tuning' | 'filtres' | 'effects' | 'texte' | 'cadre'>('tuning')

  // ---------- Rendu ----------
  const drawHistogram = useCallback(() => {
    const canvas = canvasRef.current
    const hist = histRef.current
    if (!canvas || !hist || !canvas.width) return
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const bins = new Uint32Array(256)
    // Échantillonnage 1 pixel sur 4 : suffisant pour un histogramme
    for (let i = 0; i < data.length; i += 16) {
      bins[Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2])]++
    }
    let max = 1
    for (let i = 0; i < 256; i++) if (bins[i] > max) max = bins[i]
    const hctx = hist.getContext('2d')!
    hctx.fillStyle = '#0c0e12'
    hctx.fillRect(0, 0, 256, 64)
    hctx.fillStyle = '#8ea3c0'
    for (let i = 0; i < 256; i++) {
      const h = Math.sqrt(bins[i] / max) * 62
      hctx.fillRect(i, 64 - h, 1, h)
    }
  }, [])

  const scheduleRender = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      const img = imgRef.current
      const canvas = canvasRef.current
      if (!img || !canvas) return
      let s = showOriginalRef.current ? emptyStack() : stackRef.current
      // En mode crop : afficher l'image entière (sans l'op crop) pour placer le cadre
      if (cropModeRef.current) {
        s = { version: 1, ops: s.ops.filter((o) => o.type !== 'crop') }
      }
      renderPreview(img, s, canvas)
      drawHistogram()
      // Côte à côte : le canvas de gauche reste toujours l'original intact,
      // indépendamment de showOriginal (qui n'a plus vraiment de sens une
      // fois le côte-à-côte actif, mais on ne casse rien s'il l'est aussi).
      const compareCanvas = compareCanvasRef.current
      if (compareModeRef.current && compareCanvas) {
        renderPreview(img, emptyStack(), compareCanvas)
      }
    })
  }, [drawHistogram])

  useEffect(() => {
    window.api.invoke('edits:get', { photoId: photo.id }).then((s) => {
      setStack(s.stack)
      setCanUndo(s.canUndo)
      setCanRedo(s.canRedo)
    })
    const img = new Image()
    img.onload = () => {
      imgRef.current = img
      scheduleRender()
    }
    img.src = `thumb://library/1024/${photo.id}?v=${photo.hash_xxh3}`
    return () => cancelAnimationFrame(rafRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo.id])

  useEffect(scheduleRender, [stack, showOriginal, cropMode, compareMode, scheduleRender])

  // ---------- Persistance ----------
  const persist = (next: EditStack, action: string) => {
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      const r = await window.api.invoke('edits:save', { photoId: photo.id, stack: next, action })
      setCanUndo(r.canUndo)
      setCanRedo(r.canRedo)
    }, 400)
  }

  const applyOp = (op: Parameters<typeof upsertOp>[1], action: string) => {
    const next = upsertOp(stackRef.current, op)
    setStack(next)
    persist(next, action)
  }

  const doUndo = async () => {
    const s = await window.api.invoke('edits:undo', { photoId: photo.id })
    setStack(s.stack)
    setCanUndo(s.canUndo)
    setCanRedo(s.canRedo)
  }
  const doRedo = async () => {
    const s = await window.api.invoke('edits:redo', { photoId: photo.id })
    setStack(s.stack)
    setCanUndo(s.canUndo)
    setCanRedo(s.canRedo)
  }
  const doReset = async () => {
    const next = emptyStack()
    setStack(next)
    const r = await window.api.invoke('edits:save', {
      photoId: photo.id,
      stack: next,
      action: 'reset'
    })
    setCanUndo(r.canUndo)
    setCanRedo(r.canRedo)
  }

  const doExport = async () => {
    setExportMsg('Export en cours…')
    const { outPath } = await window.api.invoke('edits:export', {
      photoId: photo.id,
      format: 'jpeg'
    })
    setExportMsg(outPath ? `✅ Exporté : ${outPath}` : '')
  }

  // ---------- Auto-corrections : analyse UNE FOIS, résultat figé dans le DSL ----------
  const analysePixels = (): { data: Uint8ClampedArray; width: number; height: number } | null => {
    const img = imgRef.current
    if (!img) return null
    // Analyse sur la géométrie courante, sans opérations couleur
    const geo: EditStack = {
      version: 1,
      ops: stackRef.current.ops.filter((o) => o.type === 'crop' || o.type === 'straighten')
    }
    const off = document.createElement('canvas')
    renderPreview(img, geo, off)
    const ctx = off.getContext('2d', { willReadFrequently: true })!
    return { data: ctx.getImageData(0, 0, off.width, off.height).data, width: off.width, height: off.height }
  }

  const autoContrast = () => {
    const a = analysePixels()
    if (!a) return
    const { black, white } = computeAutoContrast(a.data, 4)
    applyOp({ type: 'levels', params: { black, white } }, 'auto_contrast')
  }

  const autoColor = () => {
    const a = analysePixels()
    if (!a) return
    const gains = computeAutoColor(a.data, 4)
    applyOp({ type: 'wb', params: gains }, 'auto_color')
  }

  // ---------- Outils ponctuels (pipette, yeux rouges, tampon) ----------
  const canvasPoint = (e: React.MouseEvent): { x: number; y: number } | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const r = canvas.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width
    const y = (e.clientY - r.top) / r.height
    if (x < 0 || x > 1 || y < 0 || y > 1) return null
    return { x, y }
  }

  /** Pipette de blanc : le pixel cliqué doit devenir neutre → gains WB figés dans le DSL. */
  const pickWhite = (pt: { x: number; y: number }) => {
    const a = analysePixels()
    if (!a) return
    const cx = Math.round(pt.x * (a.width - 1))
    const cy = Math.round(pt.y * (a.height - 1))
    let sr = 0
    let sg = 0
    let sb = 0
    let n = 0
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || x >= a.width || y < 0 || y >= a.height) continue
        const i = (y * a.width + x) * 4
        sr += a.data[i]
        sg += a.data[i + 1]
        sb += a.data[i + 2]
        n++
      }
    }
    if (n === 0) return
    const ar = sr / n
    const ag = sg / n
    const ab = sb / n
    const target = 0.299 * ar + 0.587 * ag + 0.114 * ab
    const cl = (x: number): number => Math.round(Math.min(2, Math.max(0.5, x)) * 1000) / 1000
    applyOp(
      {
        type: 'wb',
        params: {
          r: cl(target / Math.max(1, ar)),
          g: cl(target / Math.max(1, ag)),
          b: cl(target / Math.max(1, ab))
        }
      },
      'white_pick'
    )
    setTool('none')
  }

  const redeyeZones = (): RedeyeZone[] => getOp(stackRef.current, 'redeye')?.params.zones ?? []

  const addRedeyeZone = (pt: { x: number; y: number }) => {
    applyOp(
      { type: 'redeye', params: { zones: [...redeyeZones(), { x: pt.x, y: pt.y, r: 0.03 }] } },
      'redeye'
    )
  }

  const removeRedeyeZone = (index: number) => {
    applyOp(
      { type: 'redeye', params: { zones: redeyeZones().filter((_, i) => i !== index) } },
      'redeye'
    )
  }

  const addRetouchStroke = (pt: { x: number; y: number }) => {
    if (!pendingDefect) {
      setPendingDefect(pt)
      return
    }
    const strokes = getOp(stackRef.current, 'retouch')?.params.strokes ?? []
    applyOp(
      {
        type: 'retouch',
        params: {
          strokes: [
            ...strokes,
            { dx: pendingDefect.x, dy: pendingDefect.y, sx: pt.x, sy: pt.y, r: retouchRadius }
          ]
        }
      },
      'retouch'
    )
    setPendingDefect(null)
  }

  const onCanvasClick = (e: React.MouseEvent) => {
    if (cropModeRef.current || toolRef.current === 'none') return
    const pt = canvasPoint(e)
    if (!pt) return
    if (toolRef.current === 'white') pickWhite(pt)
    else if (toolRef.current === 'redeye') addRedeyeZone(pt)
    else if (toolRef.current === 'retouch') addRetouchStroke(pt)
  }

  /** Position du canvas affiché dans le wrapper (pour les marqueurs). */
  const canvasDisp = (): { left: number; top: number; width: number; height: number } | null => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return null
    const c = canvas.getBoundingClientRect()
    const w = wrap.getBoundingClientRect()
    return { left: c.left - w.left, top: c.top - w.top, width: c.width, height: c.height }
  }

  // ---------- Recadrage interactif ----------
  const enterCrop = () => {
    const existing = getOp(stackRef.current, 'crop')
    setCropRect(existing ? { ...existing.params } : { x: 0.05, y: 0.05, w: 0.9, h: 0.9 })
    setCropMode(true)
    setCompareMode(false)
  }

  const applyCrop = () => {
    const r = cropRect
    const isFull = r.x < 0.005 && r.y < 0.005 && r.w > 0.99 && r.h > 0.99
    const next = isFull
      ? { version: 1 as const, ops: stackRef.current.ops.filter((o) => o.type !== 'crop') }
      : upsertOp(stackRef.current, { type: 'crop', params: r })
    setStack(next)
    persist(next, 'crop')
    setCropMode(false)
  }

  const toDisplayRect = (): { left: number; top: number; width: number; height: number } | null => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return null
    const c = canvas.getBoundingClientRect()
    const w = wrap.getBoundingClientRect()
    return {
      left: c.left - w.left + cropRect.x * c.width,
      top: c.top - w.top + cropRect.y * c.height,
      width: cropRect.w * c.width,
      height: cropRect.h * c.height
    }
  }

  const clampRect = (r: CropRect): CropRect => {
    const w = Math.min(1, Math.max(0.02, r.w))
    const h = Math.min(1, Math.max(0.02, r.h))
    return {
      x: Math.min(1 - w, Math.max(0, r.x)),
      y: Math.min(1 - h, Math.max(0, r.y)),
      w,
      h
    }
  }

  /** Convertit un ratio image (Wpx/Hpx) en contrainte sur (w,h) normalisés. */
  const enforceRatio = (r: CropRect, targetRatio: number | null): CropRect => {
    const canvas = canvasRef.current
    if (!targetRatio || !canvas || !canvas.width) return r
    const imgRatio = canvas.width / canvas.height
    return clampRect({ ...r, h: (r.w * imgRatio) / targetRatio })
  }

  const onPointerDown = (e: React.PointerEvent, mode: DragMode) => {
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = { mode, startX: e.clientX, startY: e.clientY, start: { ...cropRect } }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    const canvas = canvasRef.current
    if (!d.mode || !canvas) return
    const c = canvas.getBoundingClientRect()
    const dx = (e.clientX - d.startX) / c.width
    const dy = (e.clientY - d.startY) / c.height
    const s = d.start
    let r: CropRect = { ...s }
    switch (d.mode) {
      case 'move':
        r = { ...s, x: s.x + dx, y: s.y + dy }
        break
      case 'se':
        r = { ...s, w: s.w + dx, h: s.h + dy }
        break
      case 'nw':
        r = { x: s.x + dx, y: s.y + dy, w: s.w - dx, h: s.h - dy }
        break
      case 'ne':
        r = { ...s, y: s.y + dy, w: s.w + dx, h: s.h - dy }
        break
      case 'sw':
        r = { ...s, x: s.x + dx, w: s.w - dx, h: s.h + dy }
        break
    }
    setCropRect(d.mode === 'move' ? clampRect(r) : enforceRatio(clampRect(r), ratio))
  }

  const onPointerUp = () => {
    dragRef.current.mode = null
  }

  // ---------- Clavier ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (toolRef.current !== 'none') {
          setTool('none')
          setPendingDefect(null)
        } else if (cropModeRef.current) setCropMode(false)
        else onClose()
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) doUndo()
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) doRedo()
      const inField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(
        (e.target as HTMLElement)?.tagName
      )
      if (e.key.toLowerCase() === 'c' && !e.ctrlKey && !e.metaKey && !inField && !cropModeRef.current) {
        setCompareMode((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose])

  const angle = getOp(stack, 'straighten')?.params.angle ?? 0
  const disp = cropMode ? toDisplayRect() : null

  const handleStyle = (pos: React.CSSProperties): React.CSSProperties => ({
    position: 'absolute',
    width: 14,
    height: 14,
    background: '#fff',
    border: '2px solid var(--select)',
    borderRadius: 2,
    ...pos
  })

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#111418', display: 'flex', zIndex: 100, color: '#e2e8f0' }}>
      {/* -------- Panneau outils -------- */}
      <aside
        style={{
          width: 330,
          borderRight: '1px solid #333',
          padding: 16,
          overflowY: 'auto',
          overflowX: 'hidden',
          flexShrink: 0,
          fontSize: 14,
          scrollbarWidth: 'thin',
          color: '#e2e8f0'
        }}
      >
        <button onClick={onClose} style={{ marginBottom: 12 }}>
          ← Bibliothèque (Échap)
        </button>
        <h3 style={{ margin: '4px 0 12px', fontSize: 15 }}>{photo.filename}</h3>

        <canvas
          ref={histRef}
          width={256}
          height={64}
          style={{ width: '100%', borderRadius: 4, border: '1px solid #2a2f38', marginBottom: 12 }}
        />

        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          <button onClick={doUndo} disabled={!canUndo || cropMode} title="Ctrl+Z">
            ↩
          </button>
          <button onClick={doRedo} disabled={!canRedo || cropMode} title="Ctrl+Y">
            ↪
          </button>
          <button onClick={doReset} disabled={cropMode}>
            Original
          </button>
        </div>

        <button
          className={compareMode ? 'primary' : undefined}
          onClick={() => setCompareMode((v) => !v)}
          disabled={cropMode}
          title="Comparer original / édité côte à côte (C)"
          style={{ width: '100%', marginBottom: 12 }}
        >
          ⇔ Comparer côte à côte
        </button>

        <button
          onClick={() => {
            // Recadrage/retouche/yeux rouges/texte exclus : n'ont de sens
            // que sur CETTE photo, pas copiés sur une sélection différente.
            const copyable = stack.ops.filter(
              (o) =>
                o.type !== 'crop' &&
                o.type !== 'retouch' &&
                o.type !== 'redeye' &&
                o.type !== 'text'
            )
            localStorage.setItem(
              'picalibre.clipboardStack',
              JSON.stringify({ version: 1, ops: copyable })
            )
            setCopiedFlash(true)
            setTimeout(() => setCopiedFlash(false), 1500)
          }}
          disabled={cropMode || stack.ops.length === 0}
          title="Copier les réglages (tuning, filtre, vignette, cadre) pour les coller sur d'autres photos depuis la bibliothèque"
          style={{ width: '100%', marginBottom: 12 }}
        >
          {copiedFlash ? '✔ Réglages copiés' : '📋 Copier les réglages'}
        </button>

        {/* Onglets */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 12, padding: '6px 0', borderTop: '1px solid #2a2f38', borderBottom: '1px solid #2a2f38' }}>
          {(
            [
              ['tuning', 'Réglages'],
              ['filtres', 'Filtres'],
              ['effects', 'Effets'],
              ['texte', 'Texte'],
              ['cadre', 'Cadre']
            ] as Array<[typeof tab, string]>
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={tab === id ? 'primary' : undefined}
              style={{ fontSize: 12, padding: '3px 8px' }}
            >
              {label}
            </button>
          ))}
        </div>

        {!cropMode ? (
          <>
            <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
              <button onClick={enterCrop} style={{ flex: 1 }}>
                ✂ Recadrer
              </button>
            </div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
              <button onClick={autoContrast} style={{ flex: 1 }}>
                Contraste auto
              </button>
              <button onClick={autoColor} style={{ flex: 1 }}>
                Couleur auto
              </button>
            </div>

            {tab === 'tuning' && (
            <>
            <div id="editor-section-tuning" style={{ fontSize: 13, opacity: 1, fontWeight: 600, letterSpacing: '0.3px', color: '#cbd5e1', marginBottom: 4 }}>OUTILS</div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              {(
                [
                  ['white', '💧 Pipette'],
                  ['redeye', '👁 Yeux rouges'],
                  ['retouch', '🩹 Tampon']
                ] as Array<[Tool, string]>
              ).map(([t, label]) => (
                <button
                  key={t}
                  onClick={() => {
                    setTool(tool === t ? 'none' : t)
                    setPendingDefect(null)
                  }}
                  style={{ flex: 1, background: tool === t ? 'var(--select)' : undefined, fontSize: 12 }}
                >
                  {label}
                </button>
              ))}
            </div>
            {tool === 'white' && (
              <p style={{ fontSize: 12, opacity: 0.9, margin: '0 0 8px', color: '#94a3b8' }}>
                Clique une zone qui devrait être blanche/grise neutre.
              </p>
            )}
            {tool === 'redeye' && (
              <p style={{ fontSize: 12, opacity: 0.9, margin: '0 0 8px', color: '#94a3b8' }}>
                Clique sur chaque œil rouge. Clique un cercle pour le retirer.
              </p>
            )}
            {tool === 'retouch' && (
              <>
                <p style={{ fontSize: 12, opacity: 0.9, margin: '0 0 6px', color: '#94a3b8' }}>
                  1er clic : le défaut · 2e clic : la zone propre à copier.
                  {pendingDefect && ' → choisis la source…'}
                </p>
                <label style={{ fontSize: 14, display: 'block', marginBottom: 8 }}>
                  Taille : {(retouchRadius * 100).toFixed(0)}
                  <input
                    type="range"
                    min={0.01}
                    max={0.12}
                    step={0.005}
                    value={retouchRadius}
                    onChange={(e) => setRetouchRadius(parseFloat(e.target.value))}
                    style={{ width: '100%' }}
                  />
                </label>
              </>
            )}
            </>
            )}

            {tab === 'filtres' && (
            <>
            <div id="editor-section-filtres" style={{ fontSize: 13, opacity: 1, fontWeight: 600, letterSpacing: '0.3px', color: '#cbd5e1', margin: '8px 0 4px' }}>EFFETS</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
              {FILTERS.map((f) => {
                const cur = getOp(stack, 'filter')
                const active = cur?.params.name === f.name
                return (
                  <button
                    key={f.name}
                    onClick={() =>
                      applyOp(
                        {
                          type: 'filter',
                          params: { name: f.name, intensity: active ? 0 : 0.8 }
                        },
                        'filter'
                      )
                    }
                    style={{ padding: '4px 10px', fontSize: 12, background: active ? 'var(--select)' : undefined }}
                  >
                    {f.label}
                  </button>
                )
              })}
            </div>
            {getOp(stack, 'filter') && (
              <label style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>
                Intensité : {(((getOp(stack, 'filter')?.params.intensity ?? 0) as number) * 100).toFixed(0)}
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={getOp(stack, 'filter')?.params.intensity ?? 0}
                  onChange={(e) =>
                    applyOp(
                      {
                        type: 'filter',
                        params: {
                          name: getOp(stack, 'filter')!.params.name,
                          intensity: parseFloat(e.target.value)
                        }
                      },
                      'filter'
                    )
                  }
                  style={{ width: '100%' }}
                />
              </label>
            )}
            </>
            )}

            {tab === 'effects' && (
            <>
            {/* ---- Flou ---- */}
            <div id="editor-section-effects" style={{ fontSize: 13, opacity: 1, fontWeight: 600, letterSpacing: '0.3px', color: '#cbd5e1', margin: '12px 0 4px', paddingTop: 8, borderTop: '1px solid #2a2f38' }}>EFFETS AVANCÉS</div>
            <p style={{ fontSize: 11, color: '#94a3b8', margin: '0 0 6px' }}>
              Clique un effet pour l'activer — son curseur apparaît juste en dessous. Combinables.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              {(
                [
                  ['blur', '🌫 Flou'],
                  ['sharpen', '✨ Netteté'],
                  ['vignette', '🔘 Vignette'],
                  ['softfocus', '🪶 Doucette'],
                  ['glow', '💫 Glow'],
                  ['orton', '🎞 Orton'],
                  ['tiltshift', '🔭 Tilt-shift'],
                  ['hdr', '🌈 Pseudo-HDR'],
                  ['definition', '🔎 Définition']
                ] as Array<[EffectId, string]>
              ).map(([id, label]) => {
                const on = isEffectActive(stack, id)
                return (
                  <button
                    key={id}
                    onClick={() => toggleEffect(stack, id, applyOp)}
                    className={on ? 'primary' : undefined}
                    style={{ fontSize: 12 }}
                  >
                    {label}
                  </button>
                )
              })}
            </div>

            {isEffectActive(stack, 'blur') && (
              <label style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>
                🌫 Flou — Rayon : {(getOp(stack, 'blur')?.params.radius ?? 0).toFixed(1)}px
                <input
                  type="range"
                  min={0}
                  max={20}
                  step={0.5}
                  value={getOp(stack, 'blur')?.params.radius ?? 0}
                  onChange={(e) =>
                    applyOp(
                      { type: 'blur', params: { radius: parseFloat(e.target.value) } },
                      'blur'
                    )
                  }
                  style={{ width: '100%' }}
                />
              </label>
            )}

            {isEffectActive(stack, 'sharpen') && (
              <label style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>
                ✨ Netteté : {Math.round((getOp(stack, 'sharpen')?.params.amount ?? 0) * 100)}
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={getOp(stack, 'sharpen')?.params.amount ?? 0}
                  onChange={(e) =>
                    applyOp(
                      { type: 'sharpen', params: { amount: parseFloat(e.target.value) } },
                      'sharpen'
                    )
                  }
                  style={{ width: '100%' }}
                />
              </label>
            )}

            {isEffectActive(stack, 'vignette') && (
              <label style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>
                🔘 Vignette : {Math.round((getOp(stack, 'vignette')?.params.intensity ?? 0) * 100)}
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={getOp(stack, 'vignette')?.params.intensity ?? 0}
                  onChange={(e) =>
                    applyOp(
                      { type: 'vignette', params: { intensity: parseFloat(e.target.value) } },
                      'vignette'
                    )
                  }
                  style={{ width: '100%' }}
                  title="Assombrit les bords de la photo (style Picasa)"
                />
              </label>
            )}

            {isEffectActive(stack, 'softfocus') && (
              <label style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>
                🪶 Doucette : {Math.round((getOp(stack, 'softfocus')?.params.intensity ?? 0) * 100)}
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={getOp(stack, 'softfocus')?.params.intensity ?? 0}
                  onChange={(e) =>
                    applyOp(
                      { type: 'softfocus', params: { intensity: parseFloat(e.target.value) } },
                      'softfocus'
                    )
                  }
                  style={{ width: '100%' }}
                  title="Fusionne l'image avec une version floutée (adoucissement de portrait)"
                />
              </label>
            )}

            {isEffectActive(stack, 'glow') && (
              <label style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>
                💫 Glow : {Math.round((getOp(stack, 'glow')?.params.intensity ?? 0) * 100)}
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={getOp(stack, 'glow')?.params.intensity ?? 0}
                  onChange={(e) =>
                    applyOp(
                      { type: 'glow', params: { intensity: parseFloat(e.target.value) } },
                      'glow'
                    )
                  }
                  style={{ width: '100%' }}
                  title="Halo lumineux sur les parties claires (mode screen)"
                />
              </label>
            )}

            {isEffectActive(stack, 'orton') && (
              <label style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>
                🎞 Orton : {Math.round((getOp(stack, 'orton')?.params.intensity ?? 0) * 100)}
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={getOp(stack, 'orton')?.params.intensity ?? 0}
                  onChange={(e) =>
                    applyOp(
                      { type: 'orton', params: { intensity: parseFloat(e.target.value) } },
                      'orton'
                    )
                  }
                  style={{ width: '100%' }}
                  title="Effet Orton : sur-exposition + flou large + blend (rêveur)"
                />
              </label>
            )}

            {isEffectActive(stack, 'tiltshift') &&
              (() => {
                const tsOp = getOp(stack, 'tiltshift')
                const tsParams: TiltShiftParams = tsOp?.params ?? {
                  mode: 'radial',
                  focusX: 0.5,
                  focusY: 0.5,
                  focusRadius: 0.2,
                  blurRadius: 0
                }
                const updateTiltShift = (partial: Partial<TiltShiftParams>): void => {
                  applyOp({ type: 'tiltshift', params: { ...tsParams, ...partial } }, 'tiltshift')
                }
                return (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>🔭 Tilt-shift</div>
                    <label style={{ fontSize: 14, display: 'block', marginBottom: 8 }}>
                      Mode
                      <select
                        value={tsParams.mode}
                        onChange={(e) => updateTiltShift({ mode: e.target.value as 'radial' | 'linear' })}
                        style={{ width: '100%', marginTop: 4 }}
                      >
                        <option value="radial">Radial (cercle net)</option>
                        <option value="linear">Linéaire (bande nette)</option>
                      </select>
                    </label>
                    <label style={{ fontSize: 14, display: 'block', marginBottom: 8 }}>
                      Focus X : {(tsParams.focusX * 100).toFixed(0)}%
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={tsParams.focusX}
                        onChange={(e) => updateTiltShift({ focusX: parseFloat(e.target.value) })}
                        style={{ width: '100%' }}
                      />
                    </label>
                    <label style={{ fontSize: 14, display: 'block', marginBottom: 8 }}>
                      Focus Y : {(tsParams.focusY * 100).toFixed(0)}%
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={tsParams.focusY}
                        onChange={(e) => updateTiltShift({ focusY: parseFloat(e.target.value) })}
                        style={{ width: '100%' }}
                      />
                    </label>
                    <label style={{ fontSize: 14, display: 'block', marginBottom: 8 }}>
                      Rayon zone nette : {(tsParams.focusRadius * 100).toFixed(0)}%
                      <input
                        type="range"
                        min={0.02}
                        max={0.5}
                        step={0.01}
                        value={tsParams.focusRadius}
                        onChange={(e) => updateTiltShift({ focusRadius: parseFloat(e.target.value) })}
                        style={{ width: '100%' }}
                      />
                    </label>
                    <label style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>
                      Flou : {tsParams.blurRadius.toFixed(1)}px
                      <input
                        type="range"
                        min={0}
                        max={20}
                        step={0.5}
                        value={tsParams.blurRadius}
                        onChange={(e) => updateTiltShift({ blurRadius: parseFloat(e.target.value) })}
                        style={{ width: '100%' }}
                      />
                    </label>
                  </div>
                )
              })()}

            {isEffectActive(stack, 'hdr') && (
              <label style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>
                🌈 Pseudo-HDR : {Math.round((getOp(stack, 'hdr')?.params.intensity ?? 0) * 100)}
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={getOp(stack, 'hdr')?.params.intensity ?? 0}
                  onChange={(e) =>
                    applyOp(
                      { type: 'hdr', params: { intensity: parseFloat(e.target.value) } },
                      'hdr'
                    )
                  }
                  style={{ width: '100%' }}
                  title="Pseudo-HDR : local tone mapping (boost des détails + compression de dynamique)"
                />
              </label>
            )}

            {isEffectActive(stack, 'definition') && (
              <label style={{ fontSize: 14, display: 'block', marginBottom: 12 }}>
                🔎 Définition : {Math.round((getOp(stack, 'definition')?.params.amount ?? 0) * 100)}
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={getOp(stack, 'definition')?.params.amount ?? 0}
                  onChange={(e) =>
                    applyOp(
                      { type: 'definition', params: { amount: parseFloat(e.target.value) } },
                      'definition'
                    )
                  }
                  style={{ width: '100%' }}
                  title="Définition/Clarté : accentue la texture et la structure locale sur une zone large, sans les halos fins de la Netteté"
                />
              </label>
            )}
            </>
            )}

            {tab === 'texte' && (
            <>
            {/* ---- Texte sur photo ---- */}
            <div id="editor-section-texte" style={{ fontSize: 13, opacity: 1, fontWeight: 600, letterSpacing: '0.3px', color: '#cbd5e1', margin: '12px 0 4px', paddingTop: 8, borderTop: '1px solid #2a2f38' }}>TEXTE</div>
            {(() => {
              const textOp = getTextOp(stack)
              const textParams: TextOpParams = textOp?.params ?? {
                content: '',
                fontFamily: 'sans-serif',
                fontSize: 0.05,
                color: '#ffffff',
                x: 0.5,
                y: 0.5,
                opacity: 1,
                shadow: true,
                shadowColor: '#000000',
                shadowBlur: 0.005,
                fontWeight: 'bold'
              }
              const updateText = (partial: Partial<TextOpParams>): void => {
                applyOp(
                  { type: 'text', params: { ...textParams, ...partial } },
                  'text'
                )
              }
              return (
                <>
                  <input
                    type="text"
                    placeholder="Texte à incuster…"
                    value={textParams.content}
                    onChange={(e) => updateText({ content: e.target.value })}
                    style={{ width: '100%', marginBottom: 8 }}
                  />
                  {textParams.content.trim() !== '' && (
                    <>
                      <label style={{ fontSize: 14, display: 'block', marginBottom: 8 }}>
                        Police
                        <select
                          value={textParams.fontFamily}
                          onChange={(e) => updateText({ fontFamily: e.target.value })}
                          style={{ width: '100%', marginTop: 4 }}
                        >
                          <option value="sans-serif">Sans-serif</option>
                          <option value="serif">Serif</option>
                          <option value="monospace">Monospace</option>
                          <option value="cursive">Cursive</option>
                          <option value="fantasy">Fantasy</option>
                        </select>
                      </label>
                      <label style={{ fontSize: 14, display: 'block', marginBottom: 8 }}>
                        Graisse
                        <select
                          value={textParams.fontWeight}
                          onChange={(e) => updateText({ fontWeight: e.target.value })}
                          style={{ width: '100%', marginTop: 4 }}
                        >
                          <option value="normal">Normal</option>
                          <option value="bold">Gras</option>
                        </select>
                      </label>
                      <label style={{ fontSize: 14, display: 'block', marginBottom: 8 }}>
                        Taille : {(textParams.fontSize * 100).toFixed(0)}% de la largeur
                        <input
                          type="range"
                          min={0.01}
                          max={0.2}
                          step={0.005}
                          value={textParams.fontSize}
                          onChange={(e) => updateText({ fontSize: parseFloat(e.target.value) })}
                          style={{ width: '100%' }}
                        />
                      </label>
                      <label style={{ fontSize: 14, display: 'block', marginBottom: 8 }}>
                        Couleur
                        <input
                          type="color"
                          value={textParams.color}
                          onChange={(e) => updateText({ color: e.target.value })}
                          style={{ width: '100%', height: 30, marginTop: 4, padding: 0 }}
                        />
                      </label>
                      <label style={{ fontSize: 14, display: 'block', marginBottom: 8 }}>
                        Position X : {(textParams.x * 100).toFixed(0)}%
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.01}
                          value={textParams.x}
                          onChange={(e) => updateText({ x: parseFloat(e.target.value) })}
                          style={{ width: '100%' }}
                        />
                      </label>
                      <label style={{ fontSize: 14, display: 'block', marginBottom: 8 }}>
                        Position Y : {(textParams.y * 100).toFixed(0)}%
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.01}
                          value={textParams.y}
                          onChange={(e) => updateText({ y: parseFloat(e.target.value) })}
                          style={{ width: '100%' }}
                        />
                      </label>
                      <label style={{ fontSize: 14, display: 'block', marginBottom: 8 }}>
                        Opacité : {Math.round(textParams.opacity * 100)}%
                        <input
                          type="range"
                          min={0.1}
                          max={1}
                          step={0.05}
                          value={textParams.opacity}
                          onChange={(e) => updateText({ opacity: parseFloat(e.target.value) })}
                          style={{ width: '100%' }}
                        />
                      </label>
                      <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                        <input
                          type="checkbox"
                          checked={textParams.shadow}
                          onChange={(e) => updateText({ shadow: e.target.checked })}
                        />
                        Ombre portée
                      </label>
                      {textParams.shadow && (
                        <>
                          <label style={{ fontSize: 14, display: 'block', marginBottom: 8 }}>
                            Couleur de l'ombre
                            <input
                              type="color"
                              value={textParams.shadowColor}
                              onChange={(e) => updateText({ shadowColor: e.target.value })}
                              style={{ width: '100%', height: 30, marginTop: 4, padding: 0 }}
                            />
                          </label>
                          <label style={{ fontSize: 14, display: 'block', marginBottom: 8 }}>
                            Flou : {(textParams.shadowBlur * 1000).toFixed(1)}‰
                            <input
                              type="range"
                              min={0}
                              max={0.02}
                              step={0.001}
                              value={textParams.shadowBlur}
                              onChange={(e) => updateText({ shadowBlur: parseFloat(e.target.value) })}
                              style={{ width: '100%' }}
                            />
                          </label>
                        </>
                      )}
                      <button
                        onClick={() => applyOp({ type: 'text', params: { ...textParams, content: '' } }, 'text_remove')}
                        style={{ width: '100%', padding: 6, marginBottom: 12, fontSize: 12 }}
                      >
                        ✖ Retirer le texte
                      </button>
                    </>
                  )}
                </>
              )
            })()}
            </>
            )}

            {tab === 'cadre' && (
            <>
            {/* ---- Bordure / cadre ---- */}
            <div id="editor-section-cadre" style={{ fontSize: 13, opacity: 1, fontWeight: 600, letterSpacing: '0.3px', color: '#cbd5e1', margin: '12px 0 4px', paddingTop: 8, borderTop: '1px solid #2a2f38' }}>CADRE</div>
            {(() => {
              const borderOp = getBorderOp(stack)
              const borderParams: BorderOpParams = borderOp?.params ?? {
                thickness: 0.03,
                color: '#ffffff',
                style: 'solid'
              }
              const updateBorder = (partial: Partial<BorderOpParams>): void => {
                applyOp(
                  { type: 'border', params: { ...borderParams, ...partial } },
                  'border'
                )
              }
              return (
                <>
                  <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                    <input
                      type="checkbox"
                      checked={!!borderOp}
                      onChange={(e) => {
                        if (e.target.checked) {
                          applyOp({ type: 'border', params: borderParams }, 'border')
                        } else {
                          applyOp({ type: 'border', params: { ...borderParams, thickness: 0 } }, 'border_remove')
                        }
                      }}
                    />
                    Activer le cadre
                  </label>
                  {borderOp && (
                    <>
                      <label style={{ fontSize: 14, display: 'block', marginBottom: 8 }}>
                        Style
                        <select
                          value={borderParams.style}
                          onChange={(e) => updateBorder({ style: e.target.value as BorderStyle })}
                          style={{ width: '100%', marginTop: 4 }}
                        >
                          <option value="solid">Solid (uniforme)</option>
                          <option value="polaroid">Polaroid (bord bas large)</option>
                          <option value="museum">Musée (cadre épais uniforme)</option>
                        </select>
                      </label>
                      <label style={{ fontSize: 14, display: 'block', marginBottom: 8 }}>
                        Épaisseur : {Math.round(borderParams.thickness * 100)}% de la largeur
                        <input
                          type="range"
                          min={0.005}
                          max={0.15}
                          step={0.005}
                          value={borderParams.thickness}
                          onChange={(e) => updateBorder({ thickness: parseFloat(e.target.value) })}
                          style={{ width: '100%' }}
                        />
                      </label>
                      <label style={{ fontSize: 14, display: 'block', marginBottom: 8 }}>
                        Couleur
                        <input
                          type="color"
                          value={borderParams.color}
                          onChange={(e) => updateBorder({ color: e.target.value })}
                          style={{ width: '100%', height: 30, marginTop: 4, padding: 0 }}
                        />
                      </label>
                      <button
                        onClick={() => applyOp({ type: 'border', params: { ...borderParams, thickness: 0 } }, 'border_remove')}
                        style={{ width: '100%', padding: 6, marginBottom: 12, fontSize: 12 }}
                      >
                        ✖ Retirer le cadre
                      </button>
                    </>
                  )}
                </>
              )
            })()}
            </>
            )}

            {tab === 'tuning' && (
            <>
            <label style={{ fontSize: 13, display: 'block', marginBottom: 14 }}>
              Redressement : {angle.toFixed(1)}°
              <input
                type="range"
                min={-15}
                max={15}
                step={0.1}
                value={angle}
                onChange={(e) =>
                  applyOp(
                    { type: 'straighten', params: { angle: parseFloat(e.target.value) } },
                    'straighten'
                  )
                }
                style={{ width: '100%' }}
              />
            </label>

            {SLIDERS.map((s) => {
              const value =
                (getOp(stack, s.type)?.params as { value: number } | undefined)?.value ?? 0
              return (
                <label key={s.type} style={{ fontSize: 13, display: 'block', marginBottom: 14 }}>
                  {s.label} : {(value * 100).toFixed(0)}
                  <input
                    type="range"
                    min={s.min}
                    max={s.max}
                    step={0.01}
                    value={value}
                    onChange={(e) =>
                      applyOp(
                        { type: s.type, params: { value: parseFloat(e.target.value) } },
                        s.type
                      )
                    }
                    style={{ width: '100%' }}
                  />
                </label>
              )
            })}
            </>
            )}

            <button
              onMouseDown={() => setShowOriginal(true)}
              onMouseUp={() => setShowOriginal(false)}
              onMouseLeave={() => setShowOriginal(false)}
              style={{ width: '100%', padding: 8, marginBottom: 8 }}
            >
              👁 Maintenir : avant/après
            </button>
            <button onClick={doExport} style={{ width: '100%', padding: 8 }}>
              💾 Exporter en JPEG
            </button>
            {exportMsg && (
              <p style={{ fontSize: 12, opacity: 0.8, wordBreak: 'break-all' }}>{exportMsg}</p>
            )}
          </>
        ) : (
          <>
            <p style={{ fontSize: 13, opacity: 0.8 }}>
              Déplace le cadre ou ses poignées, choisis un ratio, puis applique.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
              {RATIOS.map((r) => (
                <button
                  key={r.label}
                  onClick={() => {
                    setRatio(r.value)
                    setCropRect((prev) => enforceRatio(prev, r.value))
                  }}
                  style={{
                    padding: '4px 10px',
                    background: ratio === r.value ? 'var(--select)' : undefined
                  }}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={applyCrop} style={{ flex: 1, padding: 8 }}>
                ✔ Appliquer
              </button>
              <button onClick={() => setCropMode(false)} style={{ flex: 1, padding: 8 }}>
                ✖ Annuler
              </button>
            </div>
          </>
        )}

        <p style={{ fontSize: 11, opacity: 0.45, marginTop: 16 }}>
          Édition non destructive : le fichier original n&apos;est jamais modifié.
        </p>
      </aside>

      {/* -------- Zone image -------- */}
      <main
        ref={wrapRef}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          minWidth: 0,
          position: 'relative',
          touchAction: 'none'
        }}
      >
        {compareMode && !cropMode && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              marginRight: 16,
              maxWidth: '48%'
            }}
          >
            <span style={{ fontSize: 12, color: '#94a3b8', marginBottom: 6, letterSpacing: '0.04em' }}>
              ORIGINAL
            </span>
            <canvas
              ref={compareCanvasRef}
              style={{
                maxWidth: '100%',
                maxHeight: 'calc(100vh - 140px)',
                objectFit: 'contain',
                boxShadow: '0 4px 24px #0008',
                borderRadius: 4
              }}
            />
          </div>
        )}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            maxWidth: compareMode && !cropMode ? '48%' : '100%',
            minWidth: 0
          }}
        >
          {compareMode && !cropMode && (
            <span style={{ fontSize: 12, color: '#94a3b8', marginBottom: 6, letterSpacing: '0.04em' }}>
              ÉDITÉ
            </span>
          )}
          <canvas
            ref={canvasRef}
            onClick={onCanvasClick}
            style={{
              maxWidth: '100%',
              maxHeight: compareMode && !cropMode ? 'calc(100vh - 140px)' : '100%',
              objectFit: 'contain',
              boxShadow: '0 4px 24px #0008',
              borderRadius: 4,
              cursor: tool !== 'none' && !cropMode ? 'crosshair' : 'default'
            }}
          />
        </div>

        {/* Marqueurs yeux rouges */}
        {tool === 'redeye' &&
          !cropMode &&
          (() => {
            const d = canvasDisp()
            if (!d) return null
            return redeyeZones().map((z, i) => {
              const rp = z.r * d.width
              return (
                <div
                  key={i}
                  onClick={(e) => {
                    e.stopPropagation()
                    removeRedeyeZone(i)
                  }}
                  title="Retirer cette zone"
                  style={{
                    position: 'absolute',
                    left: d.left + z.x * d.width - rp,
                    top: d.top + z.y * d.height - rp,
                    width: rp * 2,
                    height: rp * 2,
                    border: '2px solid var(--danger)',
                    borderRadius: '50%',
                    cursor: 'pointer'
                  }}
                />
              )
            })
          })()}

        {/* Marqueur tampon en attente de source */}
        {tool === 'retouch' &&
          pendingDefect &&
          (() => {
            const d = canvasDisp()
            if (!d) return null
            const rp = retouchRadius * d.width
            return (
              <div
                style={{
                  position: 'absolute',
                  left: d.left + pendingDefect.x * d.width - rp,
                  top: d.top + pendingDefect.y * d.height - rp,
                  width: rp * 2,
                  height: rp * 2,
                  border: '2px dashed var(--star)',
                  borderRadius: '50%',
                  pointerEvents: 'none'
                }}
              />
            )
          })()}

        {/* Aperçu zone nette tilt-shift */}
        {!cropMode &&
          getTiltShiftParams(stack) &&
          getTiltShiftParams(stack)!.blurRadius > 0 &&
          (() => {
            const d = canvasDisp()
            if (!d) return null
            const ts = getTiltShiftParams(stack)!
            const rPx = ts.focusRadius * d.width
            const cx = ts.focusX * d.width
            const cy = ts.focusY * d.height
            if (ts.mode === 'radial') {
              return (
                <div
                  style={{
                    position: 'absolute',
                    left: d.left + cx - rPx,
                    top: d.top + cy - rPx * (d.height / d.width),
                    width: rPx * 2,
                    height: rPx * 2 * (d.height / d.width),
                    border: '2px dashed rgba(255,255,255,0.7)',
                    borderRadius: '50%',
                    pointerEvents: 'none'
                  }}
                />
              )
            }
            // linear : bande horizontale
            const bandH = ts.focusRadius * d.width
            return (
              <div
                style={{
                  position: 'absolute',
                  left: d.left,
                  top: d.top + ts.focusY * d.height - bandH,
                  width: d.width,
                  height: bandH * 2,
                  borderTop: '2px dashed rgba(255,255,255,0.7)',
                  borderBottom: '2px dashed rgba(255,255,255,0.7)',
                  pointerEvents: 'none'
                }}
              />
            )
          })()}

        {cropMode && disp && (
          <div
            onPointerDown={(e) => onPointerDown(e, 'move')}
            style={{
              position: 'absolute',
              left: disp.left,
              top: disp.top,
              width: disp.width,
              height: disp.height,
              border: '2px solid #fff',
              boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
              cursor: 'move'
            }}
          >
            {/* Règle des tiers */}
            {[1, 2].map((i) => (
              <div
                key={`v${i}`}
                style={{
                  position: 'absolute',
                  left: `${(i * 100) / 3}%`,
                  top: 0,
                  bottom: 0,
                  width: 1,
                  background: '#ffffff44'
                }}
              />
            ))}
            {[1, 2].map((i) => (
              <div
                key={`h${i}`}
                style={{
                  position: 'absolute',
                  top: `${(i * 100) / 3}%`,
                  left: 0,
                  right: 0,
                  height: 1,
                  background: '#ffffff44'
                }}
              />
            ))}
            <div
              onPointerDown={(e) => onPointerDown(e, 'nw')}
              style={handleStyle({ left: -8, top: -8, cursor: 'nwse-resize' })}
            />
            <div
              onPointerDown={(e) => onPointerDown(e, 'ne')}
              style={handleStyle({ right: -8, top: -8, cursor: 'nesw-resize' })}
            />
            <div
              onPointerDown={(e) => onPointerDown(e, 'sw')}
              style={handleStyle({ left: -8, bottom: -8, cursor: 'nesw-resize' })}
            />
            <div
              onPointerDown={(e) => onPointerDown(e, 'se')}
              style={handleStyle({ right: -8, bottom: -8, cursor: 'nwse-resize' })}
            />
          </div>
        )}
      </main>
    </div>
  )
}
