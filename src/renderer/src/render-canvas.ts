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
  getSoftFocusIntensity,
  getGlowIntensity,
  getOrtonIntensity,
  getTiltShiftParams,
  getHdrIntensity,
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

  // Doucette/softfocus : blend(image, blur(image), intensity) —
  // globalAlpha pour composite la version floutée par-dessus l'original.
  const softFocusIntensity = getSoftFocusIntensity(stack)
  if (softFocusIntensity > 0) {
    const blurred = document.createElement('canvas')
    blurred.width = rect.width
    blurred.height = rect.height
    const bctx = blurred.getContext('2d', { willReadFrequently: true })!
    bctx.filter = `blur(6px)`
    bctx.drawImage(target, 0, 0)
    bctx.filter = 'none'
    ctx.globalAlpha = softFocusIntensity
    ctx.drawImage(blurred, 0, 0)
    ctx.globalAlpha = 1
  }

  // Glow : image + blur(bright_parts) — sur-expose, floute, composite en screen.
  const glowIntensity = getGlowIntensity(stack)
  if (glowIntensity > 0) {
    const glowCanvas = document.createElement('canvas')
    glowCanvas.width = rect.width
    glowCanvas.height = rect.height
    const gctx = glowCanvas.getContext('2d', { willReadFrequently: true })!
    // Sur-exposer
    gctx.filter = 'brightness(1.3) blur(10px)'
    gctx.drawImage(target, 0, 0)
    gctx.filter = 'none'
    // Screen blend par pixels
    const orig = ctx.getImageData(0, 0, rect.width, rect.height)
    const glow = gctx.getImageData(0, 0, rect.width, rect.height)
    const od = orig.data
    const gd = glow.data
    const t = glowIntensity
    for (let i = 0; i < od.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const screen = 255 - ((255 - od[i + c]) * (255 - gd[i + c])) / 255
        od[i + c] = Math.round(od[i + c] * (1 - t) + screen * t)
      }
    }
    ctx.putImageData(orig, 0, 0)
  }

  // Orton : blend(overexposed, blur(large), 0.5) —
  // sur-expose, floute largement, blend à 50% avec l'original.
  const ortonIntensity = getOrtonIntensity(stack)
  if (ortonIntensity > 0) {
    const ortonCanvas = document.createElement('canvas')
    ortonCanvas.width = rect.width
    ortonCanvas.height = rect.height
    const octx = ortonCanvas.getContext('2d', { willReadFrequently: true })!
    octx.filter = 'brightness(1.4) blur(15px)'
    octx.drawImage(target, 0, 0)
    octx.filter = 'none'
    // Blend pixel par pixel à 50% pondéré par intensity
    const orig = ctx.getImageData(0, 0, rect.width, rect.height)
    const orton = octx.getImageData(0, 0, rect.width, rect.height)
    const od = orig.data
    const id = orton.data
    const t = ortonIntensity * 0.5
    for (let i = 0; i < od.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        od[i + c] = Math.round(od[i + c] * (1 - t) + id[i + c] * t)
      }
    }
    ctx.putImageData(orig, 0, 0)
  }

  // Tilt-shift : flou gaussien sur toute l'image, puis blend avec l'originale
  // selon un masque de distance (net au centre, flou sur les bords).
  // Mode radial : cercle net centré sur (focusX, focusY) avec rayon focusRadius.
  // Mode linear : bande nette horizontale centrée sur focusY, hauteur 2×focusRadius.
  const tiltShiftParams = getTiltShiftParams(stack)
  if (tiltShiftParams && tiltShiftParams.blurRadius > 0) {
    const { mode, focusX, focusY, focusRadius, blurRadius } = tiltShiftParams
    const blurred = document.createElement('canvas')
    blurred.width = rect.width
    blurred.height = rect.height
    const bctx = blurred.getContext('2d', { willReadFrequently: true })!
    bctx.filter = `blur(${blurRadius}px)`
    bctx.drawImage(target, 0, 0)
    bctx.filter = 'none'

    const orig = ctx.getImageData(0, 0, rect.width, rect.height)
    const blur = bctx.getImageData(0, 0, rect.width, rect.height)
    const od = orig.data
    const bd = blur.data
    const rPx = focusRadius * rect.width
    const cx = focusX * rect.width
    const cy = focusY * rect.height
    // Zone de transition : 50% du rayon en plus (adoucissement du masque)
    const transition = rPx * 0.5

    for (let y = 0; y < rect.height; y++) {
      for (let x = 0; x < rect.width; x++) {
        let dist: number
        if (mode === 'radial') {
          dist = Math.hypot(x - cx, y - cy)
        } else {
          // linear : distance verticale à la ligne de mise au point
          dist = Math.abs(y - cy)
        }
        // Masque : 0 dans la zone nette (→ original), 1 au-delà (→ flou)
        let t: number
        if (dist <= rPx) {
          t = 0
        } else if (dist >= rPx + transition) {
          t = 1
        } else {
          t = (dist - rPx) / transition
        }
        const i = (y * rect.width + x) * 4
        for (let c = 0; c < 3; c++) {
          od[i + c] = Math.round(od[i + c] * (1 - t) + bd[i + c] * t)
        }
      }
    }
    ctx.putImageData(orig, 0, 0)
  }

  // Pseudo-HDR : local tone mapping
  // Étape 1 : flou léger (radius ~5px) → image basse fréquence
  // Étape 2 : high_freq = image - blurred (détails)
  // Étape 3 : hdr = image + intensity * high_freq * 2 (boost des détails locaux)
  // Étape 4 : tone compression : hdr / (1 + hdr/255) (Reinhard)
  const hdrIntensity = getHdrIntensity(stack)
  if (hdrIntensity > 0) {
    const blurred = document.createElement('canvas')
    blurred.width = rect.width
    blurred.height = rect.height
    const bctx = blurred.getContext('2d', { willReadFrequently: true })!
    bctx.filter = 'blur(5px)'
    bctx.drawImage(target, 0, 0)
    bctx.filter = 'none'

    const orig = ctx.getImageData(0, 0, rect.width, rect.height)
    const blur = bctx.getImageData(0, 0, rect.width, rect.height)
    const od = orig.data
    const bd = blur.data
    const t = hdrIntensity

    for (let i = 0; i < od.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const px = od[i + c]
        const highFreq = px - bd[i + c] // détail local
        const hdr = px + t * highFreq * 2 // boost des détails
        // Tone mapping Reinhard : hdr / (1 + hdr/255)
        const mapped = (hdr * 255) / (255 + hdr)
        od[i + c] = Math.max(0, Math.min(255, Math.round(mapped)))
      }
    }
    ctx.putImageData(orig, 0, 0)
  }

  // --- Pixels : spatial (CPU, zones locales) puis couleur (GPU si possible) ---
  const hasSpatial = stack.ops.some(
    (o) => o.type === 'redeye' || o.type === 'retouch' || o.type === 'vignette'
  )
  const hasColor = colorOpsOf(stack.ops).length > 0
  const hasText = stack.ops.some((o) => o.type === 'text')
  const hasBorder = stack.ops.some((o) => o.type === 'border')
  const hasBlur = blurRadius > 0
  const hasSharpen = sharpenAmount > 0
  const hasSoftFocus = softFocusIntensity > 0
  const hasGlow = glowIntensity > 0
  const hasOrton = ortonIntensity > 0
  const hasTiltShift = !!(tiltShiftParams && tiltShiftParams.blurRadius > 0)
  const hasHdr = hdrIntensity > 0
  if (!hasSpatial && !hasColor && !hasText && !hasBorder && !hasBlur && !hasSharpen && !hasSoftFocus && !hasGlow && !hasOrton && !hasTiltShift && !hasHdr) return

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
    if (hasColor) applyColorOps(img.data, 4, stack.ops, rect.width)
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
  applyColorOps(img.data, 4, stack.ops, rect.width)
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
  const isMuseum = style === 'museum'
  // Polaroid : bord bas 4× plus épais. Musée : bordure uniforme 2,5× plus épaisse.
  const topBw = isMuseum ? Math.round(bw * 2.5) : bw
  const sideBw = isMuseum ? Math.round(bw * 2.5) : bw
  const bottomBw = style === 'polaroid' ? bw * 4 : isMuseum ? Math.round(bw * 2.5) : bw
  const newW = width + sideBw * 2
  const newH = height + topBw + bottomBw

  // Créer un canvas étendu
  const extended = document.createElement('canvas')
  extended.width = newW
  extended.height = newH
  const ectx = extended.getContext('2d')!

  // Remplir avec la couleur de bordure
  ectx.fillStyle = color
  ectx.fillRect(0, 0, newW, newH)

  // Dessiner le canvas original par-dessus
  ectx.drawImage(canvas, sideBw, topBw)

  // Recopier vers le canvas cible (redimensionner)
  canvas.width = newW
  canvas.height = newH
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(extended, 0, 0)
}