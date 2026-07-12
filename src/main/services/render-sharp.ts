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
  cropRectPx,
  straightenAngle
} from '../../shared/edit-engine'

export interface ExportOptions {
  format?: 'jpeg' | 'webp' | 'png'
  quality?: number
  maxSize?: number // redimensionnement final optionnel (bord le plus long)
}

export async function renderEdited(
  filepath: string,
  stack: EditStack,
  opts: ExportOptions = {}
): Promise<Buffer> {
  const { format = 'jpeg', quality = 92, maxSize } = opts

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

  // Math couleur partagée avec la preview
  applyColorOps(data, 3, stack.ops)

  // Encodage final
  let out = sharp(data, {
    raw: { width: info.width, height: info.height, channels: 3 }
  })
  if (maxSize) {
    out = out.resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true })
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
