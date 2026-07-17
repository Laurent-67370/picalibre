import { useCallback, useEffect, useRef, useState } from 'react'
import type { PhotoRow, RendererApi } from '@shared/ipc'
import {
  ColorOpType,
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
  { type: 'contrast', label: 'Contraste', min: -1, max: 1 },
  { type: 'saturation', label: 'Saturation', min: -1, max: 1 },
  { type: 'temperature', label: 'Température', min: -1, max: 1 }
]

const RATIOS: Array<{ label: string; value: number | null }> = [
  { label: 'Libre', value: null },
  { label: '1:1', value: 1 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:2', value: 3 / 2 },
  { label: '16:9', value: 16 / 9 }
]

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
  { name: 'invert', label: 'Négatif' }
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

  useEffect(scheduleRender, [stack, showOriginal, cropMode, scheduleRender])

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
    border: '2px solid #2f6feb',
    borderRadius: 2,
    ...pos
  })

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#111418', display: 'flex', zIndex: 100 }}>
      {/* -------- Panneau outils -------- */}
      <aside
        style={{
          width: 300,
          borderRight: '1px solid #333',
          padding: 16,
          overflow: 'auto',
          flexShrink: 0
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

            <div style={{ fontSize: 11, opacity: 0.5, marginBottom: 4 }}>OUTILS</div>
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
                  style={{ flex: 1, background: tool === t ? '#2f6feb' : undefined, fontSize: 12 }}
                >
                  {label}
                </button>
              ))}
            </div>
            {tool === 'white' && (
              <p style={{ fontSize: 12, opacity: 0.75, margin: '0 0 8px' }}>
                Clique une zone qui devrait être blanche/grise neutre.
              </p>
            )}
            {tool === 'redeye' && (
              <p style={{ fontSize: 12, opacity: 0.75, margin: '0 0 8px' }}>
                Clique sur chaque œil rouge. Clique un cercle pour le retirer.
              </p>
            )}
            {tool === 'retouch' && (
              <>
                <p style={{ fontSize: 12, opacity: 0.75, margin: '0 0 6px' }}>
                  1er clic : le défaut · 2e clic : la zone propre à copier.
                  {pendingDefect && ' → choisis la source…'}
                </p>
                <label style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
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

            <div style={{ fontSize: 11, opacity: 0.5, margin: '8px 0 4px' }}>EFFETS</div>
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
                    style={{ padding: '4px 10px', fontSize: 12, background: active ? '#2f6feb' : undefined }}
                  >
                    {f.label}
                  </button>
                )
              })}
            </div>
            {getOp(stack, 'filter') && (
              <label style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
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

            {/* ---- Flou ---- */}
            <div style={{ fontSize: 11, opacity: 0.5, margin: '8px 0 4px' }}>FLOU</div>
            <label style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
              Rayon : {(getOp(stack, 'blur')?.params.radius ?? 0).toFixed(1)}px
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

            {/* ---- Texte sur photo ---- */}
            <div style={{ fontSize: 11, opacity: 0.5, margin: '8px 0 4px' }}>TEXTE</div>
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
                      <label style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
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
                      <label style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
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
                      <label style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
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
                      <label style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
                        Couleur
                        <input
                          type="color"
                          value={textParams.color}
                          onChange={(e) => updateText({ color: e.target.value })}
                          style={{ width: '100%', height: 30, marginTop: 4, padding: 0 }}
                        />
                      </label>
                      <label style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
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
                      <label style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
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
                      <label style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
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
                          <label style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
                            Couleur de l'ombre
                            <input
                              type="color"
                              value={textParams.shadowColor}
                              onChange={(e) => updateText({ shadowColor: e.target.value })}
                              style={{ width: '100%', height: 30, marginTop: 4, padding: 0 }}
                            />
                          </label>
                          <label style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
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

            {/* ---- Bordure / cadre ---- */}
            <div style={{ fontSize: 11, opacity: 0.5, margin: '8px 0 4px' }}>CADRE</div>
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
                      <label style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
                        Style
                        <select
                          value={borderParams.style}
                          onChange={(e) => updateBorder({ style: e.target.value as BorderStyle })}
                          style={{ width: '100%', marginTop: 4 }}
                        >
                          <option value="solid">Solid (uniforme)</option>
                          <option value="polaroid">Polaroid (bord bas large)</option>
                        </select>
                      </label>
                      <label style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
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
                      <label style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
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
                    background: ratio === r.value ? '#2f6feb' : undefined
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
        <canvas
          ref={canvasRef}
          onClick={onCanvasClick}
          style={{
            maxWidth: '100%',
            maxHeight: '100%',
            objectFit: 'contain',
            boxShadow: '0 4px 24px #0008',
            borderRadius: 4,
            cursor: tool !== 'none' && !cropMode ? 'crosshair' : 'default'
          }}
        />

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
                    border: '2px solid #ff5252',
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
                  border: '2px dashed #f5c518',
                  borderRadius: '50%',
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
