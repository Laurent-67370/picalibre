/**
 * Impression avec mise en page simple : 1, 2 ou 4 photos par page.
 * Une fenêtre cachée construit la page (miniatures 1024 via thumb://)
 * puis ouvre le dialogue d'impression système.
 */
import { BrowserWindow } from 'electron'

export function printPhotos(photoIds: number[], perPage: 1 | 2 | 4): void {
  const cell =
    perPage === 1
      ? 'width:100%;height:96vh'
      : perPage === 2
        ? 'width:100%;height:47vh'
        : 'width:48%;height:47vh'
  const imgs = photoIds
    .map(
      (id, i) =>
        `<img src="thumb://library/1024/${id}" style="${cell};object-fit:contain;margin:0.5%" ${
          (i + 1) % perPage === 0 && i + 1 < photoIds.length
            ? 'class="pb"'
            : ''
        }/>`
    )
    .join('')
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    @page{margin:8mm} body{margin:0;display:flex;flex-wrap:wrap;align-content:flex-start}
    .pb{page-break-after:always}
  </style></head><body>${imgs}</body></html>`

  const win = new BrowserWindow({ show: false })
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  win.webContents.on('did-finish-load', () => {
    // Petit délai pour laisser les images se charger
    setTimeout(() => {
      win.webContents.print({ silent: false }, () => win.destroy())
    }, 1200)
  })
}
