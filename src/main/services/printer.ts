/**
 * Impression avec mise en page avancée : contact sheet, plein page, grilles.
 * Formats papier : A4, A3, Letter, Legal. Marges configurables.
 * Une fenêtre cachée construit la page (miniatures 1024 via thumb://)
 * puis ouvre le dialogue d'impression système.
 */
import { BrowserWindow } from 'electron'

export type PrintLayout = 'contact' | 'full' | 'grid2x3' | 'grid3x3'
export type PaperSize = 'A4' | 'A3' | 'Letter' | 'Legal'

/** Dimensions de page en mm (largeur × hauteur) pour chaque format papier. */
const PAPER_DIMS: Record<PaperSize, { w: number; h: number }> = {
  A4: { w: 210, h: 297 },
  A3: { w: 297, h: 420 },
  Letter: { w: 216, h: 279 },
  Legal: { w: 216, h: 356 }
}

/** Configuration de grille pour chaque layout. */
const LAYOUT_CONFIG: Record<
  PrintLayout,
  { cols: number; rows: number; showFilename: boolean; gap: number }
> = {
  contact: { cols: 5, rows: 7, showFilename: true, gap: 2 },
  full: { cols: 1, rows: 1, showFilename: false, gap: 0 },
  grid2x3: { cols: 2, rows: 3, showFilename: false, gap: 4 },
  grid3x3: { cols: 3, rows: 3, showFilename: false, gap: 3 }
}

export function printPhotos(
  photoIds: number[],
  layout: PrintLayout,
  paperSize: PaperSize,
  marginMm: number
): void {
  const cfg = LAYOUT_CONFIG[layout]
  const paper = PAPER_DIMS[paperSize]
  const perPage = cfg.cols * cfg.rows

  // Construire les cellules HTML
  const cells: string[] = []
  for (let i = 0; i < photoIds.length; i++) {
    const id = photoIds[i]
    const isLastInRow = (i + 1) % cfg.cols === 0
    const isLastInPage = (i + 1) % perPage === 0
    const isLastPhoto = i === photoIds.length - 1

    let cellClass = 'cell'
    if (isLastInPage && !isLastPhoto) cellClass += ' page-break'

    const img = `<img src="thumb://library/1024/${id}" alt="${id}" />`
    const label = cfg.showFilename
      ? `<span class="fname">${id}</span>`
      : ''

    cells.push(
      `<div class="${cellClass}" style="flex: 1 1 0; min-width: 0; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1mm; overflow: hidden;">${img}${label}</div>`
    )
  }

  // Grouper en pages
  const pages: string[] = []
  for (let i = 0; i < cells.length; i += perPage) {
    const pageCells = cells.slice(i, i + perPage)
    // Remplir les cellules vides pour compléter la dernière page
    while (pageCells.length < perPage && pageCells.length > 0) {
      pageCells.push('<div class="cell empty"></div>')
    }
    pages.push(
      `<div class="page"><div class="grid" style="display: grid; grid-template-columns: repeat(${cfg.cols}, 1fr); grid-template-rows: repeat(${cfg.rows}, 1fr); gap: ${cfg.gap}mm; width: 100%; height: 100%;">${pageCells.join('')}</div></div>`
    )
  }

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    @page { size: ${paper.w}mm ${paper.h}mm; margin: ${marginMm}mm; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { margin: 0; padding: 0; }
    .page {
      width: ${paper.w}mm;
      height: ${paper.h}mm;
      padding: ${marginMm}mm;
      page-break-after: always;
      box-sizing: border-box;
      overflow: hidden;
    }
    .page:last-child { page-break-after: auto; }
    .page-break { page-break-after: always; }
    .cell img {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
    }
    .cell.empty { visibility: hidden; }
    .fname {
      font-family: monospace;
      font-size: 7pt;
      color: #333;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
    }
    @media screen {
      body { background: #888; padding: 20px; }
      .page {
        background: white;
        margin: 0 auto 20px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      }
    }
    @media print {
      body { background: white; }
      .page { margin: 0; box-shadow: none; }
    }
  </style></head><body>${pages.join('')}</body></html>`

  const win = new BrowserWindow({ show: false })
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  win.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      win.webContents.print({ silent: false }, () => win.destroy())
    }, 1500)
  })
}