import { useState } from 'react'
import type { PhotoRow } from '@shared/ipc'

/**
 * Dialogue d'impression avec prévisualisation.
 *
 * Layouts : contact sheet, plein page, grille 2x3, grille 3x3.
 * Formats papier : A4, A3, Letter, Legal.
 * Marges configurables (en mm).
 * Prévisualisation en miniature avant envoi vers l'imprimante.
 */

export type PrintLayout = 'contact' | 'full' | 'grid2x3' | 'grid3x3'
export type PaperSize = 'A4' | 'A3' | 'Letter' | 'Legal'

const LAYOUT_LABELS: Record<PrintLayout, string> = {
  contact: 'Planche contact',
  full: 'Plein page',
  grid2x3: 'Grille 2×3',
  grid3x3: 'Grille 3×3'
}

const LAYOUT_COLS: Record<PrintLayout, number> = {
  contact: 5,
  full: 1,
  grid2x3: 2,
  grid3x3: 3
}

const LAYOUT_ROWS: Record<PrintLayout, number> = {
  contact: 7,
  full: 1,
  grid2x3: 3,
  grid3x3: 3
}

const LAYOUT_SHOW_NAME: Record<PrintLayout, boolean> = {
  contact: true,
  full: false,
  grid2x3: false,
  grid3x3: false
}

/** Ratio largeur/hauteur des formats papier. */
const PAPER_RATIO: Record<PaperSize, number> = {
  A4: 210 / 297,
  A3: 297 / 420,
  Letter: 216 / 279,
  Legal: 216 / 356
}

export default function PrintDialog({
  photos,
  onClose,
  onPrint
}: {
  photos: PhotoRow[]
  onClose: () => void
  onPrint: (layout: PrintLayout, paperSize: PaperSize, marginMm: number) => void
}): JSX.Element {
  const [layout, setLayout] = useState<PrintLayout>('contact')
  const [paperSize, setPaperSize] = useState<PaperSize>('A4')
  const [marginMm, setMarginMm] = useState(10)

  const cols = LAYOUT_COLS[layout]
  const rows = LAYOUT_ROWS[layout]
  const perPage = cols * rows
  const showName = LAYOUT_SHOW_NAME[layout]
  const pageCount = Math.max(1, Math.ceil(photos.length / perPage))

  // Photos pour la prévisualisation (première page)
  const previewPhotos = photos.slice(0, perPage)

  // Ratio de la page pour la prévisualisation
  const paperRatio = PAPER_RATIO[paperSize]

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 250,
        background: '#0f172acc',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--card)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: 24,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          minWidth: 560,
          maxWidth: '90vw',
          maxHeight: '90vh',
          overflow: 'auto'
        }}
      >
        <h3 style={{ margin: 0 }}>
          🖨 Impression ({photos.length} photo(s) · {pageCount} page(s))
        </h3>

        {/* Options */}
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <label
            style={{ fontSize: 13, display: 'flex', flexDirection: 'column', gap: 6 }}
          >
            Disposition
            <select
              value={layout}
              onChange={(e) => setLayout(e.target.value as PrintLayout)}
            >
              {Object.entries(LAYOUT_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>

          <label
            style={{ fontSize: 13, display: 'flex', flexDirection: 'column', gap: 6 }}
          >
            Format papier
            <select
              value={paperSize}
              onChange={(e) => setPaperSize(e.target.value as PaperSize)}
            >
              <option value="A4">A4 (210×297 mm)</option>
              <option value="A3">A3 (297×420 mm)</option>
              <option value="Letter">Letter (216×279 mm)</option>
              <option value="Legal">Legal (216×356 mm)</option>
            </select>
          </label>

          <label
            style={{ fontSize: 13, display: 'flex', flexDirection: 'column', gap: 6 }}
          >
            Marges : {marginMm} mm
            <input
              type="range"
              min={0}
              max={30}
              step={1}
              value={marginMm}
              onChange={(e) => setMarginMm(Number(e.target.value))}
              style={{ width: 120 }}
            />
          </label>
        </div>

        {/* Prévisualisation */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            padding: 16,
            background: '#888',
            borderRadius: 8,
            overflow: 'auto'
          }}
        >
          <div
            style={{
              width: 300,
              height: 300 / paperRatio,
              background: 'white',
              padding: `${(marginMm / 297) * 100}%`,
              boxSizing: 'border-box',
              display: 'grid',
              gridTemplateColumns: `repeat(${cols}, 1fr)`,
              gridTemplateRows: `repeat(${rows}, 1fr)`,
              gap: 2,
              boxShadow: '0 2px 8px rgba(0,0,0,0.3)'
            }}
          >
            {previewPhotos.map((p) => (
              <div
                key={p.id}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 1,
                  overflow: 'hidden',
                  minWidth: 0,
                  minHeight: 0
                }}
              >
                <img
                  src={`thumb://library/256/${p.id}?v=${p.hash_xxh3}`}
                  alt={p.filename}
                  style={{
                    maxWidth: '100%',
                    maxHeight: '100%',
                    objectFit: 'contain'
                  }}
                />
                {showName && (
                  <span
                    style={{
                      fontSize: 6,
                      color: '#333',
                      fontFamily: 'monospace',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      maxWidth: '100%'
                    }}
                  >
                    {p.filename}
                  </span>
                )}
              </div>
            ))}
            {/* Cellules vides pour compléter la grille */}
            {Array.from({ length: perPage - previewPhotos.length }).map((_, i) => (
              <div key={`empty-${i}`} style={{ visibility: 'hidden' }} />
            ))}
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose}>Annuler</button>
          <button
            className="primary"
            onClick={() => onPrint(layout, paperSize, marginMm)}
            disabled={photos.length === 0}
          >
            🖨 Imprimer
          </button>
        </div>
      </div>
    </div>
  )
}