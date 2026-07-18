import { useEffect, useRef, useState } from 'react'
import type { PhotoRow, RendererApi } from '@shared/ipc'

declare global {
  interface Window {
    api: RendererApi
  }
}

export type CollageLayout = 'grid' | 'row' | 'column' | 'mosaic'

export interface CollageCell {
  x: number
  y: number
  w: number
  h: number
}

export interface CollagePlan {
  W: number
  H: number
  cells: CollageCell[]
}

/**
 * Calcule les cellules d'un layout — version renderer (identique au main).
 * Copie de computeLayout() de collage.ts pour la preview canvas.
 */
function computePreviewLayout(n: number, layout: CollageLayout): CollagePlan {
  if (n < 1) return { W: 0, H: 0, cells: [] }

  const GAP = 14

  if (layout === 'row') {
    const cell = 700
    const W = n * cell + GAP * (n + 1)
    const H = cell + GAP * 2
    return {
      W,
      H,
      cells: Array.from({ length: n }, (_, i) => ({
        x: GAP + i * (cell + GAP),
        y: GAP,
        w: cell,
        h: cell
      }))
    }
  }

  if (layout === 'column') {
    const cell = 700
    const H = n * cell + GAP * (n + 1)
    const W = cell + GAP * 2
    return {
      W,
      H,
      cells: Array.from({ length: n }, (_, i) => ({
        x: GAP,
        y: GAP + i * (cell + GAP),
        w: cell,
        h: cell
      }))
    }
  }

  if (layout === 'mosaic' && n >= 2) {
    const W = 2048
    const H = 1365
    const bigW = Math.round(W * 0.6)
    const cells = [
      { x: GAP, y: GAP, w: bigW - GAP * 2, h: H - GAP * 2 }
    ]
    const rest = n - 1
    const colX = bigW + GAP
    const colW = W - bigW - GAP * 2
    const cellH = Math.floor((H - GAP * (rest + 1)) / rest)
    for (let i = 0; i < rest; i++) {
      cells.push({ x: colX, y: GAP + i * (cellH + GAP), w: colW, h: cellH })
    }
    return { W, H, cells }
  }

  // grid (défaut)
  const cols = Math.ceil(Math.sqrt(n))
  const rows = Math.ceil(n / cols)
  const W = 2048
  const cellW = Math.floor((W - GAP * (cols + 1)) / cols)
  const cellH = cellW
  const H = rows * cellH + GAP * (rows + 1)
  const cells: CollagePlan['cells'] = []
  for (let i = 0; i < n; i++) {
    const c = i % cols
    const r = Math.floor(i / cols)
    cells.push({ x: GAP + c * (cellW + GAP), y: GAP + r * (cellH + GAP), w: cellW, h: cellH })
  }
  return { W, H, cells }
}

export type CollageFormat = 'jpeg' | 'webp' | 'png'

/**
 * CollagePreview — aperçu canvas d'un collage + export.
 *
 * - Rendu canvas en temps réel des photos dans le layout choisi
 * - Aperçu à l'échelle (fit dans la zone disponible)
 * - Export en JPEG/WebP/PNG via IPC
 */
export default function CollagePreview({
  photos,
  layout,
  onClose,
  onExport
}: {
  photos: PhotoRow[]
  layout: CollageLayout
  onClose: () => void
  onExport: (format: CollageFormat) => Promise<void>
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [loading, setLoading] = useState(true)
  const [exportFormat, setExportFormat] = useState<CollageFormat>('jpeg')
  const [exporting, setExporting] = useState(false)

  const plan = computePreviewLayout(photos.length, layout)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || plan.cells.length === 0) return

    // Aperçu à l'échelle : max 1200px de large
    const maxW = 1200
    const scale = Math.min(1, maxW / plan.W)
    canvas.width = Math.round(plan.W * scale)
    canvas.height = Math.round(plan.H * scale)

    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#101216'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    setLoading(true)
    let loaded = 0
    const total = photos.length

    photos.forEach((photo, i) => {
      const cell = plan.cells[i]
      if (!cell) return
      const img = new Image()
      img.onload = () => {
        const sx = Math.round(cell.x * scale)
        const sy = Math.round(cell.y * scale)
        const sw = Math.round(cell.w * scale)
        const sh = Math.round(cell.h * scale)

        // Cover : calcul du crop
        const imgRatio = img.naturalWidth / img.naturalHeight
        const cellRatio = sw / sh
        let cropX = 0
        let cropY = 0
        let cropW = img.naturalWidth
        let cropH = img.naturalHeight
        if (imgRatio > cellRatio) {
          cropW = img.naturalHeight * cellRatio
          cropX = (img.naturalWidth - cropW) / 2
        } else {
          cropH = img.naturalWidth / cellRatio
          cropY = (img.naturalHeight - cropH) / 2
        }

        ctx.drawImage(img, cropX, cropY, cropW, cropH, sx, sy, sw, sh)
        loaded++
        if (loaded === total) setLoading(false)
      }
      img.onerror = () => {
        loaded++
        if (loaded === total) setLoading(false)
      }
      img.src = `thumb://library/1024/${photo.id}?v=${photo.hash_xxh3}`
    })
  }, [photos, plan])

  const handleExport = async (): Promise<void> => {
    setExporting(true)
    try {
      await onExport(exportFormat)
    } finally {
      setExporting(false)
    }
  }

  if (photos.length === 0) return <></>

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: '#0b1220f2',
        zIndex: 1030,
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
        <button onClick={onClose}>← Retour</button>
        <span style={{ fontSize: 14, fontWeight: 600 }}>
          🧩 Collage — {photos.length} photo(s) — {layout}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: '#94a3b8' }}>
          {plan.W}×{plan.H}px
        </span>
        <select
          value={exportFormat}
          onChange={(e) => setExportFormat(e.target.value as CollageFormat)}
          title="Format d'export"
        >
          <option value="jpeg">JPEG</option>
          <option value="webp">WebP</option>
          <option value="png">PNG</option>
        </select>
        <button
          className="primary"
          onClick={handleExport}
          disabled={exporting || loading}
          title="Exporter le collage"
        >
          {exporting ? '⏳ Export…' : '💾 Exporter'}
        </button>
      </div>

      {/* Aperçu canvas */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          overflow: 'auto'
        }}
      >
        {loading && (
          <div style={{ position: 'absolute', color: '#94a3b8', fontSize: 14 }}>
            Chargement de l'aperçu…
          </div>
        )}
        <canvas
          ref={canvasRef}
          style={{
            maxWidth: '100%',
            maxHeight: '100%',
            objectFit: 'contain',
            borderRadius: 4,
            boxShadow: '0 8px 40px #000a'
          }}
        />
      </div>
    </div>
  )
}