/**
 * Moteur de PREVIEW (renderer) — Canvas 2D.
 * Géométrie : straighten via ctx.rotate, crop via extraction de zone.
 * Couleur : applyColorOps sur l'ImageData — MÊME math que l'export sharp.
 *
 * Rendu d'une preview 1024 px : quelques ms à quelques dizaines de ms,
 * suffisant pour des sliders fluides avec debounce. (Optimisation WebGL
 * prévue plus tard sans changer le DSL.)
 */
import {
  EditStack,
  applyColorOps,
  applySpatialOps,
  cropRectPx,
  straightenAngle
} from '@shared/edit-engine'

export function renderPreview(
  source: HTMLImageElement,
  stack: EditStack,
  target: HTMLCanvasElement
): void {
  const sw = source.naturalWidth
  const sh = source.naturalHeight
  if (!sw || !sh) return

  // --- Passe 1 : redressement dans un canvas intermédiaire ---
  const angle = straightenAngle(stack)
  let stage: HTMLCanvasElement | HTMLImageElement = source
  let stageW = sw
  let stageH = sh

  if (angle !== 0) {
    const rad = (angle * Math.PI) / 180
    const cos = Math.abs(Math.cos(rad))
    const sin = Math.abs(Math.sin(rad))
    stageW = Math.round(sw * cos + sh * sin)
    stageH = Math.round(sw * sin + sh * cos)
    const rot = document.createElement('canvas')
    rot.width = stageW
    rot.height = stageH
    const rctx = rot.getContext('2d')!
    rctx.fillStyle = '#000'
    rctx.fillRect(0, 0, stageW, stageH)
    rctx.translate(stageW / 2, stageH / 2)
    rctx.rotate(rad)
    rctx.drawImage(source, -sw / 2, -sh / 2)
    stage = rot
  }

  // --- Passe 2 : crop ---
  const rect = cropRectPx(stack, stageW, stageH) ?? {
    left: 0,
    top: 0,
    width: stageW,
    height: stageH
  }

  target.width = rect.width
  target.height = rect.height
  const ctx = target.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(
    stage,
    rect.left,
    rect.top,
    rect.width,
    rect.height,
    0,
    0,
    rect.width,
    rect.height
  )

  // --- Pixels : math partagée (spatial puis couleur) ---
  const hasPixelOps = stack.ops.some((o) => o.type !== 'crop' && o.type !== 'straighten')
  if (hasPixelOps) {
    const img = ctx.getImageData(0, 0, rect.width, rect.height)
    applySpatialOps(img.data, rect.width, rect.height, 4, stack.ops)
    applyColorOps(img.data, 4, stack.ops)
    ctx.putImageData(img, 0, 0)
  }
}
