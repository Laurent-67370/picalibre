/**
 * Moteur d'EXPORT (pleine résolution) — sharp/libvips.
 *
 * Pipeline en 2 passes déterministes :
 *   1. Orientation EXIF + redressement (straighten) → buffer intermédiaire
 *   2. Crop en pixels (calculé sur les dimensions post-rotation) → pixels bruts
 *      → applyColorOps (MÊME math que la preview) → encodage final
 *
 * Module pur (pas d'import electron) → testable en Node directement.
 */
import sharp from 'sharp'
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
  getBorderOp,
  escapeSvgText,
  hexToSvgFill,
  TiltShiftParams
} from '../../shared/edit-engine'

export interface ExportOptions {
  format?: 'jpeg' | 'webp' | 'png'
  quality?: number
  maxSize?: number // redimensionnement final optionnel (bord le plus long)
  watermark?: string // texte incrusté en bas à droite
}

export async function renderEdited(
  filepath: string,
  stack: EditStack,
  opts: ExportOptions = {}
): Promise<Buffer> {
  const { format = 'jpeg', quality = 92, maxSize, watermark } = opts

  // Passe 1 : orientation EXIF + redressement
  let pass1 = sharp(filepath, { failOn: 'none' }).rotate()
  const angle = straightenAngle(stack)
  if (angle !== 0) {
    pass1 = pass1.rotate(angle, { background: { r: 0, g: 0, b: 0 } })
  }
  const rotated = await pass1.toBuffer()

  // Passe 2 : crop (px calculés post-rotation) puis pixels bruts
  let pass2 = sharp(rotated)
  const meta = await pass2.metadata()
  const rect = cropRectPx(stack, meta.width ?? 0, meta.height ?? 0)
  if (rect) pass2 = pass2.extract(rect)

  // Flou spatial (opération spatiale, appliquée AVANT les colorOps)
  const blurRadius = getBlurRadius(stack)
  if (blurRadius > 0) {
    pass2 = pass2.blur(blurRadius)
  }

  // Netteté (unsharp mask) : image + amount * (image - blur(image))
  const sharpenAmount = getSharpenAmount(stack)
  if (sharpenAmount > 0) {
    pass2 = pass2.sharpen({ sigma: 1.0, m1: sharpenAmount * 500, m2: sharpenAmount * 500 })
  }

  // Doucette/softfocus : blend(image, blur(image), intensity) —
  // mélange l'original avec une version floutée, opacité = intensity.
  // Implémentation : floute une copie, puis composite l'original par-dessus
  // avec opacité (1 - intensity) → l'image reste nette à (1-intensity) et
  // floutée à intensity.
  const softFocusIntensity = getSoftFocusIntensity(stack)
  if (softFocusIntensity > 0) {
    const origBuffer = await pass2.clone().raw().toBuffer({ resolveWithObject: true })
    const blurred = pass2.blur(6)
    const blurredBuf = await blurred.raw().toBuffer({ resolveWithObject: true })
    // Blend pixel par pixel : result = orig * (1 - t) + blurred * t
    const t = softFocusIntensity
    const od = origBuffer.data
    const bd = blurredBuf.data
    const len = Math.min(od.length, bd.length)
    for (let i = 0; i < len; i++) {
      od[i] = Math.round(od[i] * (1 - t) + bd[i] * t)
    }
    pass2 = sharp(od, {
      raw: {
        width: origBuffer.info.width,
        height: origBuffer.info.height,
        channels: origBuffer.info.channels
      }
    })
  }

  // Glow : image + blur(bright_parts) — seuille les parties claires, floute,
  // puis composite en mode screen pour créer un halo lumineux.
  const glowIntensity = getGlowIntensity(stack)
  if (glowIntensity > 0) {
    const origBuf = await pass2.clone().raw().toBuffer({ resolveWithObject: true })
    const glowBuf = await pass2
      .modulate({ brightness: 1.3 })
      .blur(10)
      .raw()
      .toBuffer({ resolveWithObject: true })
    const od = origBuf.data
    const gd = glowBuf.data
    const len = Math.min(od.length, gd.length)
    // Screen blend : result = 255 - (255 - a) * (255 - b) / 255, avec opacité
    const t = glowIntensity
    for (let i = 0; i < len; i++) {
      const screen = 255 - ((255 - od[i]) * (255 - gd[i])) / 255
      od[i] = Math.round(od[i] * (1 - t) + screen * t)
    }
    pass2 = sharp(od, {
      raw: {
        width: origBuf.info.width,
        height: origBuf.info.height,
        channels: origBuf.info.channels
      }
    })
  }

  // Orton : blend(overexposed, blur(large), 0.5) —
  // sur-expose l'image, floute largement, puis blend à 50% avec l'original.
  const ortonIntensity = getOrtonIntensity(stack)
  if (ortonIntensity > 0) {
    const origBuf = await pass2.clone().raw().toBuffer({ resolveWithObject: true })
    const ortonBuf = await pass2
      .modulate({ brightness: 1.4 })
      .blur(15)
      .raw()
      .toBuffer({ resolveWithObject: true })
    const od = origBuf.data
    const id = ortonBuf.data
    const len = Math.min(od.length, id.length)
    // Blend à 50% : result = orig * (1 - t*0.5) + orton * (t*0.5)
    const t = ortonIntensity * 0.5
    for (let i = 0; i < len; i++) {
      od[i] = Math.round(od[i] * (1 - t) + id[i] * t)
    }
    pass2 = sharp(od, {
      raw: {
        width: origBuf.info.width,
        height: origBuf.info.height,
        channels: origBuf.info.channels
      }
    })
  }

  // Tilt-shift : flou gaussien sur toute l'image, puis blend avec l'originale
  // selon un masque de distance (net au centre, flou sur les bords).
  // Mode radial : cercle net centré sur (focusX, focusY) avec rayon focusRadius.
  // Mode linear : bande nette horizontale centrée sur focusY, hauteur 2×focusRadius.
  const tiltShiftParams = getTiltShiftParams(stack)
  if (tiltShiftParams && tiltShiftParams.blurRadius > 0) {
    const tsParams: TiltShiftParams = tiltShiftParams
    const origBuf = await pass2.clone().raw().toBuffer({ resolveWithObject: true })
    const W = origBuf.info.width
    const H = origBuf.info.height
    const ch = origBuf.info.channels
    const blurBuf = await pass2
      .blur(tsParams.blurRadius)
      .raw()
      .toBuffer({ resolveWithObject: true })
    const od = origBuf.data
    const bd = blurBuf.data
    const rPx = tsParams.focusRadius * W
    const cx = tsParams.focusX * W
    const cy = tsParams.focusY * H
    const transition = rPx * 0.5

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let dist: number
        if (tsParams.mode === 'radial') {
          dist = Math.hypot(x - cx, y - cy)
        } else {
          dist = Math.abs(y - cy)
        }
        let t: number
        if (dist <= rPx) {
          t = 0
        } else if (dist >= rPx + transition) {
          t = 1
        } else {
          t = (dist - rPx) / transition
        }
        const i = (y * W + x) * ch
        for (let c = 0; c < 3; c++) {
          od[i + c] = Math.round(od[i + c] * (1 - t) + bd[i + c] * t)
        }
      }
    }
    pass2 = sharp(od, {
      raw: { width: W, height: H, channels: ch }
    })
  }

  // Pseudo-HDR : local tone mapping
  // Étape 1 : flou léger (radius ~5px) → image basse fréquence
  // Étape 2 : high_freq = image - blurred (détails)
  // Étape 3 : hdr = image + intensity * high_freq * 2 (boost des détails locaux)
  // Étape 4 : tone compression : hdr / (1 + hdr/255) (Reinhard)
  const hdrIntensity = getHdrIntensity(stack)
  if (hdrIntensity > 0) {
    const origBuf = await pass2.clone().raw().toBuffer({ resolveWithObject: true })
    const W = origBuf.info.width
    const H = origBuf.info.height
    const ch = origBuf.info.channels
    const blurBuf = await pass2
      .blur(5)
      .raw()
      .toBuffer({ resolveWithObject: true })
    const od = origBuf.data
    const bd = blurBuf.data
    const t = hdrIntensity

    for (let i = 0; i < od.length; i += ch) {
      for (let c = 0; c < 3; c++) {
        const px = od[i + c]
        const highFreq = px - bd[i + c] // détail local
        const hdr = px + t * highFreq * 2 // boost des détails
        // Tone mapping Reinhard : hdr / (1 + hdr/255)
        const mapped = (hdr * 255) / (255 + hdr)
        od[i + c] = Math.max(0, Math.min(255, Math.round(mapped)))
      }
    }
    pass2 = sharp(od, {
      raw: { width: W, height: H, channels: ch }
    })
  }

  const { data, info } = await pass2
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  // Math partagée avec la preview : spatial (tampon, yeux rouges) puis couleur
  applySpatialOps(data, info.width, info.height, 3, stack.ops)
  applyColorOps(data, 3, stack.ops, info.width)

  // Encodage final
  let out = sharp(data, {
    raw: { width: info.width, height: info.height, channels: 3 }
  })
  if (maxSize) {
    out = out.resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true })
  }

  // Texte sur photo : composé APRÈS le redimensionnement pour garantir
  // que le fontSize relatif (ratio de la largeur) est identique en preview et en export.
  // Parité preview/export : même paramètres, même position normalisée, même font.
  const textOp = getTextOp(stack)
  if (textOp && textOp.params.content.trim() !== '') {
    const inter = await out.png().toBuffer()
    const m = await sharp(inter).metadata()
    const W = m.width ?? 100
    const H = m.height ?? 100
    const p = textOp.params
    const fontSizePx = Math.round(p.fontSize * W)
    const px = p.x * W
    const py = p.y * H
    const fillAttrs = hexToSvgFill(p.color, p.opacity)
    const escaped = escapeSvgText(p.content)

    // Ombre portée : filtre SVG blur
    let shadowDef = ''
    let shadowStyle = ''
    if (p.shadow) {
      const blurPx = Math.round(p.shadowBlur * W)
      const shadowFill = hexToSvgFill(p.shadowColor, p.opacity)
      shadowDef = `<filter id="textShadow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur in="SourceAlpha" stdDeviation="${blurPx}"/>
        <feOffset dx="0" dy="0" result="offsetblur"/>
        <feFlood flood-color="${shadowFill.fill}" flood-opacity="${shadowFill.opacity}"/>
        <feComposite in2="offsetblur" operator="in"/>
        <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>`
      shadowStyle = ' filter="url(#textShadow)"'
    }

    const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <defs>${shadowDef}</defs>
      <text x="${px}" y="${py}"
        text-anchor="middle" dominant-baseline="middle"
        font-family="${p.fontFamily}" font-size="${fontSizePx}"
        font-weight="${p.fontWeight}"
        fill="${fillAttrs.fill}" fill-opacity="${fillAttrs.opacity}"${shadowStyle}>${escaped}</text></svg>`
    const composited = await sharp(inter)
      .composite([{ input: Buffer.from(svg) }])
      .removeAlpha()
      .png()
      .toBuffer()
    out = sharp(composited)
  }

  // Filigrane : composé APRÈS le redimensionnement, taille relative à l'image
  if (watermark) {
    const inter = await out.png().toBuffer()
    const m = await sharp(inter).metadata()
    const W = m.width ?? 100
    const H = m.height ?? 100
    const fontSize = Math.max(12, Math.round(W / 28))
    const escaped = watermark.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <text x="${W - Math.round(fontSize * 0.6)}" y="${H - Math.round(fontSize * 0.6)}"
        text-anchor="end" font-family="DejaVu Sans, sans-serif" font-size="${fontSize}"
        fill="#ffffff" fill-opacity="0.85" stroke="#000000" stroke-opacity="0.35"
        stroke-width="1">${escaped}</text></svg>`
    const composited = await sharp(inter)
      .composite([{ input: Buffer.from(svg) }])
      .removeAlpha() // le SVG introduit un canal alpha : on reste en RGB
      .png()
      .toBuffer()
    out = sharp(composited)
  }

  // Bordure/cadre : appliqué APRÈS le texte et le filigrane, car la bordure
  // étend l'image. Parité preview/export : même épaisseur relative, même couleur.
  const borderOp = getBorderOp(stack)
  if (borderOp && borderOp.params.thickness > 0) {
    const inter = await out.png().toBuffer()
    const m = await sharp(inter).metadata()
    const W = m.width ?? 100
    const H = m.height ?? 100
    const bw = Math.round(borderOp.params.thickness * W)
    const isMuseum = borderOp.params.style === 'museum'
    const topBw = isMuseum ? Math.round(bw * 2.5) : bw
    const sideBw = isMuseum ? Math.round(bw * 2.5) : bw
    const bottomBw =
      borderOp.params.style === 'polaroid' ? bw * 4 : isMuseum ? Math.round(bw * 2.5) : bw
    // Parser la couleur hex en { r, g, b }
    const hexMatch = /^#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(borderOp.params.color)
    const bg = hexMatch
      ? { r: parseInt(hexMatch[1], 16), g: parseInt(hexMatch[2], 16), b: parseInt(hexMatch[3], 16) }
      : { r: 255, g: 255, b: 255 }

    out = sharp(inter).extend({
      top: topBw,
      bottom: bottomBw,
      left: sideBw,
      right: sideBw,
      background: { r: bg.r, g: bg.g, b: bg.b, alpha: 1 }
    }).removeAlpha()
  }

  switch (format) {
    case 'webp':
      return out.webp({ quality }).toBuffer()
    case 'png':
      return out.png().toBuffer()
    default:
      return out.jpeg({ quality, mozjpeg: true }).toBuffer()
  }
}
