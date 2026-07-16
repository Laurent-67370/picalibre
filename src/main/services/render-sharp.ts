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
  getTextOp,
  getBorderOp,
  escapeSvgText,
  hexToSvgFill
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
