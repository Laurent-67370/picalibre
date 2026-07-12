/**
 * Moteur d'édition non destructive — DSL + mathématiques PARTAGÉES.
 *
 * Module 100 % pur (aucun import Node/DOM) : il est importé à la fois par
 *   - le moteur de PREVIEW (renderer, Canvas)  → src/renderer/src/render-canvas.ts
 *   - le moteur d'EXPORT (main, sharp)         → src/main/services/render-sharp.ts
 *
 * La parité couleur entre preview et export est garantie PAR CONSTRUCTION :
 * les deux moteurs appellent applyColorOps() sur leurs pixels bruts.
 * Seule la géométrie (rotation/crop) diffère par l'interpolation, ce qui est
 * visuellement négligeable.
 *
 * Toutes les coordonnées géométriques sont NORMALISÉES 0–1 : le même stack
 * s'applique à la preview 1024 px et à l'export pleine résolution.
 */

export type ColorOpType = 'fill_light' | 'highlights' | 'contrast' | 'saturation' | 'temperature'

export type EditOp =
  | { type: 'crop'; params: { x: number; y: number; w: number; h: number } }
  | { type: 'straighten'; params: { angle: number } } // degrés, -15..15
  | { type: 'levels'; params: { black: number; white: number } } // contraste auto (0..255)
  | { type: 'wb'; params: { r: number; g: number; b: number } } // gains balance des blancs
  | { type: ColorOpType; params: { value: number } } // -1..1 (fill_light : 0..1)

export interface EditStack {
  version: 1
  ops: EditOp[]
}

export const emptyStack = (): EditStack => ({ version: 1, ops: [] })

export function parseStack(json: string): EditStack {
  try {
    const s = JSON.parse(json)
    if (s && s.version === 1 && Array.isArray(s.ops)) return s
  } catch {
    /* ignore */
  }
  return emptyStack()
}

/** Une seule instance par type d'opération (modèle Picasa) ; value 0 = suppression. */
export function upsertOp(stack: EditStack, op: EditOp): EditStack {
  const ops = stack.ops.filter((o) => o.type !== op.type)
  const isNeutral =
    ('value' in op.params && op.params.value === 0) ||
    (op.type === 'straighten' && op.params.angle === 0) ||
    (op.type === 'levels' && op.params.black === 0 && op.params.white === 255) ||
    (op.type === 'wb' && op.params.r === 1 && op.params.g === 1 && op.params.b === 1)
  if (!isNeutral) ops.push(op)
  return { version: 1, ops }
}

export function getOp<T extends EditOp['type']>(
  stack: EditStack,
  type: T
): Extract<EditOp, { type: T }> | undefined {
  return stack.ops.find((o) => o.type === type) as Extract<EditOp, { type: T }> | undefined
}

// Math.round explicite : Uint8ClampedArray arrondit mais Uint8Array TRONQUE —
// sans arrondi commun, preview (RGBA) et export (RGB) divergeraient d'1/255.
const clamp255 = (v: number): number => {
  const r = Math.round(v)
  return r < 0 ? 0 : r > 255 ? 255 : r
}

/**
 * Applique les opérations COULEUR du stack sur un buffer de pixels bruts,
 * en place. `channels` = 3 (RGB, sharp) ou 4 (RGBA, canvas) — l'alpha est ignoré.
 * L'ordre d'application est l'ordre des ops dans le stack.
 */
export function applyColorOps(
  data: Uint8Array | Uint8ClampedArray,
  channels: 3 | 4,
  ops: EditOp[]
): void {
  const colorOps = ops.filter((o) => o.type !== 'crop' && o.type !== 'straighten')
  if (colorOps.length === 0) return

  const n = data.length
  for (let i = 0; i < n; i += channels) {
    let r = data[i]
    let g = data[i + 1]
    let b = data[i + 2]

    for (const op of colorOps) {
      if (op.type === 'levels') {
        const { black, white } = op.params as { black: number; white: number }
        const k = 255 / Math.max(1, white - black)
        r = (r - black) * k
        g = (g - black) * k
        b = (b - black) * k
        continue
      }
      if (op.type === 'wb') {
        const gains = op.params as { r: number; g: number; b: number }
        r *= gains.r
        g *= gains.g
        b *= gains.b
        continue
      }
      const v = (op.params as { value: number }).value
      // Luminance Rec.601, recalculée après chaque op (0..1)
      const l = (0.299 * r + 0.587 * g + 0.114 * b) / 255

      switch (op.type) {
        case 'fill_light': {
          // Relève les ombres : poids fort sur pixels sombres (0..1)
          const w = v * (1 - l) * (1 - l) * 0.9
          r += w * (255 - r)
          g += w * (255 - g)
          b += w * (255 - b)
          break
        }
        case 'highlights': {
          // v<0 récupère les hautes lumières, v>0 les pousse
          const w = v * l * l
          r += w * (255 - r)
          g += w * (255 - g)
          b += w * (255 - b)
          break
        }
        case 'contrast': {
          const k = 1 + v
          r = (r - 128) * k + 128
          g = (g - 128) * k + 128
          b = (b - 128) * k + 128
          break
        }
        case 'saturation': {
          const k = 1 + v
          const lum = l * 255
          r = lum + (r - lum) * k
          g = lum + (g - lum) * k
          b = lum + (b - lum) * k
          break
        }
        case 'temperature': {
          // v>0 réchauffe (R+, B-), v<0 refroidit
          r += v * 40
          b -= v * 40
          break
        }
      }
    }

    data[i] = clamp255(r)
    data[i + 1] = clamp255(g)
    data[i + 2] = clamp255(b)
  }
}

/** Rectangle de crop en pixels pour une image de dimensions données (post-rotation). */
export function cropRectPx(
  stack: EditStack,
  width: number,
  height: number
): { left: number; top: number; width: number; height: number } | null {
  const crop = getOp(stack, 'crop')
  if (!crop) return null
  const { x, y, w, h } = crop.params
  const left = Math.round(x * width)
  const top = Math.round(y * height)
  return {
    left: Math.max(0, Math.min(left, width - 1)),
    top: Math.max(0, Math.min(top, height - 1)),
    width: Math.max(1, Math.min(Math.round(w * width), width - left)),
    height: Math.max(1, Math.min(Math.round(h * height), height - top))
  }
}

export function straightenAngle(stack: EditStack): number {
  return getOp(stack, 'straighten')?.params.angle ?? 0
}

/**
 * Contraste auto : points noir/blanc aux centiles 0,5 %/99,5 % de l'histogramme
 * de luminance. Le résultat est STOCKÉ dans le DSL (op 'levels') pour garantir
 * un rendu identique en preview et en export, quelle que soit la résolution
 * d'analyse.
 */
export function computeAutoContrast(
  data: Uint8Array | Uint8ClampedArray,
  channels: 3 | 4
): { black: number; white: number } {
  const hist = new Uint32Array(256)
  let total = 0
  for (let i = 0; i < data.length; i += channels) {
    const l = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2])
    hist[l]++
    total++
  }
  const lowTarget = total * 0.005
  const highTarget = total * 0.995
  let acc = 0
  let black = 0
  let white = 255
  for (let i = 0; i < 256; i++) {
    acc += hist[i]
    if (acc <= lowTarget) black = i
    if (acc <= highTarget) white = i
  }
  if (white - black < 32) return { black: 0, white: 255 } // image quasi plate : neutre
  return { black, white }
}

/**
 * Couleur auto (balance des blancs "gray world") : gains RGB pour ramener
 * chaque canal vers la luminance moyenne. Stocké en dur dans le DSL (op 'wb').
 */
export function computeAutoColor(
  data: Uint8Array | Uint8ClampedArray,
  channels: 3 | 4
): { r: number; g: number; b: number } {
  let sr = 0
  let sg = 0
  let sb = 0
  let n = 0
  for (let i = 0; i < data.length; i += channels) {
    sr += data[i]
    sg += data[i + 1]
    sb += data[i + 2]
    n++
  }
  if (n === 0) return { r: 1, g: 1, b: 1 }
  const ar = sr / n
  const ag = sg / n
  const ab = sb / n
  const target = 0.299 * ar + 0.587 * ag + 0.114 * ab
  const clampGain = (x: number): number => Math.min(1.6, Math.max(0.6, x))
  const round3 = (x: number): number => Math.round(x * 1000) / 1000
  return {
    r: round3(clampGain(target / Math.max(1, ar))),
    g: round3(clampGain(target / Math.max(1, ag))),
    b: round3(clampGain(target / Math.max(1, ab)))
  }
}

/** Hash stable et rapide du stack (invalidation du cache de rendus). */
export function stackHash(stack: EditStack): string {
  const s = JSON.stringify(stack.ops)
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h2 >>> 0).toString(16) + (h1 >>> 0).toString(16)
}
