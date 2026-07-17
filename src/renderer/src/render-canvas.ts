/**
 * Moteur de PREVIEW (renderer) — Canvas 2D.
 * Géométrie : straighten via ctx.rotate, crop via extraction de zone.
 * Couleur : applyColorOps sur l'ImageData — MÊME math que l'export sharp.
 *
 * Les opérations COULEUR passent par le GPU (render-webgl, parité testée
 * 13/13 à ±1/255 contre applyColorOps) avec fallback CPU automatique ;
 * sans op spatiale, le chemin GPU évite même le getImageData.
 *
 * Le TEXTE est dessiné en dernier, par-dessus tous les autres effets,
 * garantissant la parité avec l'export (SVG composite dans render-sharp.ts).
 */
import {
  EditStack,
  applyColorOps,
  applySpatialOps,
  cropRectPx,
  straightenAngle,
  getBlurRadius,
  getSharpenAmount,
  getTextOp,
  getBorderOp
} from '@shared/edit-engine'
import { applyColorOpsWebGL, colorOpsOf } from './render-webgl'

export function renderPreview(
  source: HTMLImageElement,
  stack: EditStack,
  target: HTMLCanvasElement,
  opts: { forceCpu?: boolean } = {}
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

  // Flou spatial : ctx.filter appliqué lors du drawImage (avant colorOps)
  const blurRadius = getBlurRadius(stack)
  if (blurRadius > 0) {
    ctx.filter = `blur(${blurRadius}px)`
  }
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
  ctx.filter = 'none'

  // Netteté (unsharp mask) : result = original + amount * (original - blurred)
  const sharpenAmount = getSharpenAmount(stack)
  if (sharpenAmount > 0) {
    // Créer une version floutée de l'image courante
    const blurred = document.createElement('canvas')
    blurred.width = rect.width
    blurred.height = rect.height
    const bctx = blurred.getContext('2d', { willReadFrequently: true })!
    bctx.filter = 'blur(1px)'
    bctx.drawImage(target, 0, 0)
    bctx.filter = 'none'

    // Unsharp mask sur les pixels
    const orig = ctx.getImageData(0, 0, rect.width, rect.height)
    const blur = bctx.getImageData(0, 0, rect.width, rect.height)
    const od = orig.data
    const bd = blur.data
    for (let i = 0; i < od.length; i += 4) {
      od[i] = Math.max(0, Math.min(255, od[i] + sharpenAmount * (od[i] - bd[i])))
      od[i + 1] = Math.max(0, Math.min(255, od[i + 1] + sharpenAmount * (od[i + 1] - bd[i + 1])))
      od[i + 2] = Math.max(0, Math.min(255, od[i + 2] + sharpenAmount * (od[i + 2] - bd[i + 2])))
    }
    ctx.putImageData(orig, 0, 0)
  }

  // --- Pixels : spatial (CPU, zones locales) puis couleur (GPU si possible) ---
  const hasSpatial = stack.ops.some((o) => o.type === 'redeye' || o.type === 'retouch')
  const hasColor = colorOpsOf(stack.ops).length > 0
  const hasText = stack.ops.some((o) => o.type === 'text')
  const hasBorder = stack.ops.some((o) => o.type === 'border')
  const hasBlur = blurRadius > 0
  const hasSharpen = sharpenAmount > 0
  if (!hasSpatial && !hasColor && !hasText && !hasBorder && !hasBlur && !hasSharpen) return

  // Si pas d'op pixel mais texte/bordure seul → dessiner directement
  if (!hasSpatial && !hasColor && (hasText || hasBorder)) {
    drawText(ctx, stack, rect.width, rect.height)
    drawBorder(target, stack, rect.width, rect.height)
    return
  }

  if (hasSpatial) {
    const img = ctx.getImageData(0, 0, rect.width, rect.height)
    applySpatialOps(img.data, rect.width, rect.height, 4, stack.ops)
    if (
      hasColor &&
      !opts.forceCpu &&
      applyColorOpsWebGL(img, stack.ops, ctx, rect.width, rect.height)
    ) {
      drawText(ctx, stack, rect.width, rect.height)
      drawBorder(target, stack, rect.width, rect.height)
      return // GPU a écrit le résultat (spatial inclus via la texture ImageData)
    }
    if (hasColor) applyColorOps(img.data, 4, stack.ops)
    ctx.putImageData(img, 0, 0)
    drawText(ctx, stack, rect.width, rect.height)
    drawBorder(target, stack, rect.width, rect.height)
    return
  }

  // Chemin rapide : couleur seule → texture directe depuis le canvas, AUCUN getImageData
  if (!opts.forceCpu && applyColorOpsWebGL(target, stack.ops, ctx, rect.width, rect.height)) {
    // Le GPU a traité la couleur, mais le texte doit être dessiné ensuite
    drawText(ctx, stack, rect.width, rect.height)
    drawBorder(target, stack, rect.width, rect.height)
    return
  }
  const img = ctx.getImageData(0, 0, rect.width, rect.height)
  applyColorOps(img.data, 4, stack.ops)
  ctx.putImageData(img, 0, 0)
  drawText(ctx, stack, rect.width, rect.height)
  drawBorder(target, stack, rect.width, rect.height)
}

/**
 * Dessine l'opération texte sur le canvas de preview.
 * Parité garantie avec le rendu SVG de l'export (render-sharp.ts).
 * Coordonnées normalisées 0..1 → pixels, fontSize relatif à la largeur.
 */
function drawText(
  ctx: CanvasRenderingContext2D,
  stack: EditStack,
  width: number,
  height: number
): void {
  const textOp = getTextOp(stack)
  if (!textOp) return
  const { content, fontFamily, fontSize, color, x, y, opacity, shadow, shadowColor, shadowBlur, fontWeight } = textOp.params
  if (content.trim() === '') return

  const fontSizePx = Math.round(fontSize * width)
  const px = x * width
  const py = y * height

  ctx.save()
  ctx.globalAlpha = Math.max(0, Math.min(1, opacity))
  ctx.font = `${fontWeight} ${fontSizePx}px ${fontFamily}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  if (shadow) {
    ctx.shadowColor = shadowColor
    ctx.shadowBlur = Math.round(shadowBlur * width)
    ctx.shadowOffsetX = 0
    ctx.shadowOffsetY = 0
  }

  ctx.fillStyle = color
  ctx.fillText(content, px, py)
  ctx.restore()
}

/**
 * Dessine la bordure/cadre sur le canvas de preview.
 * La bordure ÉTEND le canvas : on crée un nouveau canvas plus grand, on remplit
 * avec la couleur de bordure, puis on dessine l'image par-dessus.
 * Parité garantie avec le rendu SVG de l'export (render-sharp.ts).
 *
 * Style 'solid' : bordure uniforme sur les 4 côtés.
 * Style 'polaroid' : bordure fine sur 3 côtés + bord bas plus large (effet Polaroid).
 */
function drawBorder(
  canvas: HTMLCanvasElement,
  stack: EditStack,
  width: number,
  height: number
): void {
  const borderOp = getBorderOp(stack)
  if (!borderOp) return
  const { thickness, color, style } = borderOp.params
  if (thickness <= 0) return

  const bw = Math.round(thickness * width)
  // Polaroid : bord bas 4× plus épais
  const bottomBw = style === 'polaroid' ? bw * 4 : bw
  const newW = width + bw * 2
  const newH = height + bw + bottomBw

  // Créer un canvas étendu
  const extended = document.createElement('canvas')
  extended.width = newW
  extended.height = newH
  const ectx = extended.getContext('2d')!

  // Remplir avec la couleur de bordure
  ectx.fillStyle = color
  ectx.fillRect(0, 0, newW, newH)

  // Dessiner le canvas original par-dessus
  ectx.drawImage(canvas, bw, bw)

  // Recopier vers le canvas cible (redimensionner)
  canvas.width = newW
  canvas.height = newH
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(extended, 0, 0)
}