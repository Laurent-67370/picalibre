/**
 * Générateur de collages — module pur (aucun import electron/db, testable).
 * Les éditions non destructives de chaque photo sont appliquées (renderEdited),
 * puis chaque cellule est remplie en "cover" et composée sur le fond.
 */
import sharp from 'sharp'
import { EditStack } from '../../shared/edit-engine'
import { renderEdited } from './render-sharp'

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

const GAP = 14
const BG = { r: 16, g: 18, b: 22 }

/** Calcule les cellules d'un layout — fonction pure, testée unitairement. */
export function computeLayout(n: number, layout: CollageLayout): CollagePlan {
  if (n < 1) return { W: 0, H: 0, cells: [] }

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
    // Une grande à gauche (60 %), les autres empilées à droite
    const W = 2048
    const H = 1365
    const bigW = Math.round(W * 0.6)
    const cells: CollageCell[] = [
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

  // grid (défaut) : quasi carré
  const cols = Math.ceil(Math.sqrt(n))
  const rows = Math.ceil(n / cols)
  const W = 2048
  const cellW = Math.floor((W - GAP * (cols + 1)) / cols)
  const cellH = cellW
  const H = rows * cellH + GAP * (rows + 1)
  const cells: CollageCell[] = []
  for (let i = 0; i < n; i++) {
    const c = i % cols
    const r = Math.floor(i / cols)
    cells.push({ x: GAP + c * (cellW + GAP), y: GAP + r * (cellH + GAP), w: cellW, h: cellH })
  }
  return { W, H, cells }
}

export interface CollageItem {
  filepath: string
  stack: EditStack
}

export async function makeCollage(
  items: CollageItem[],
  layout: CollageLayout,
  outFile: string
): Promise<{ width: number; height: number }> {
  const plan = computeLayout(items.length, layout)
  const composites: sharp.OverlayOptions[] = []

  for (let i = 0; i < items.length; i++) {
    const cell = plan.cells[i]
    // Éditions appliquées, puis remplissage "cover" de la cellule
    const rendered = await renderEdited(items[i].filepath, items[i].stack, {
      format: 'png',
      maxSize: Math.max(cell.w, cell.h) * 2 // marge de qualité pour le cover
    })
    const fitted = await sharp(rendered)
      .resize(cell.w, cell.h, { fit: 'cover', position: 'attention' })
      .png()
      .toBuffer()
    composites.push({ input: fitted, left: cell.x, top: cell.y })
  }

  await sharp({
    create: { width: plan.W, height: plan.H, channels: 3, background: BG }
  })
    .composite(composites)
    .jpeg({ quality: 92, mozjpeg: true })
    .toFile(outFile)

  return { width: plan.W, height: plan.H }
}
