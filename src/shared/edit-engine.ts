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

export type FilterName = 'bw' | 'sepia' | 'warmify' | 'cool' | 'invert'

export interface RedeyeZone {
  x: number
  y: number
  r: number
} // centre + rayon, normalisés sur l'image post-géométrie

export interface RetouchStroke {
  dx: number
  dy: number // destination (le défaut à corriger)
  sx: number
  sy: number // source (la zone propre copiée)
  r: number // rayon normalisé
}

export type EditOp =
  | { type: 'crop'; params: { x: number; y: number; w: number; h: number } }
  | { type: 'straighten'; params: { angle: number } } // degrés, -15..15
  | { type: 'levels'; params: { black: number; white: number } } // contraste auto (0..255)
  | { type: 'wb'; params: { r: number; g: number; b: number } } // gains balance des blancs
  | { type: 'filter'; params: { name: FilterName; intensity: number } } // 0..1
  | { type: 'redeye'; params: { zones: RedeyeZone[] } }
  | { type: 'retouch'; params: { strokes: RetouchStroke[] } }
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
    (op.type === 'wb' && op.params.r === 1 && op.params.g === 1 && op.params.b === 1) ||
    (op.type === 'filter' && op.params.intensity === 0) ||
    (op.type === 'redeye' && op.params.zones.length === 0) ||
    (op.type === 'retouch' && op.params.strokes.length === 0)
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
  const colorOps = ops.filter(
    (o) =>
      o.type !== 'crop' && o.type !== 'straighten' && o.type !== 'redeye' && o.type !== 'retouch'
  )
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
      if (op.type === 'filter') {
        const { name, intensity: t } = op.params as { name: FilterName; intensity: number }
        const l = 0.299 * r + 0.587 * g + 0.114 * b
        let er = r
        let eg = g
        let eb = b
        switch (name) {
          case 'bw':
            er = l; eg = l; eb = l
            break
          case 'sepia':
            er = 0.393 * r + 0.769 * g + 0.189 * b
            eg = 0.349 * r + 0.686 * g + 0.168 * b
            eb = 0.272 * r + 0.534 * g + 0.131 * b
            break
          case 'warmify':
            er = l + (r - l) * 1.15 + 28
            eg = l + (g - l) * 1.15 + 6
            eb = l + (b - l) * 1.15 - 22
            break
          case 'cool':
            er = l + (r - l) * 1.05 - 22
            eg = l + (g - l) * 1.05
            eb = l + (b - l) * 1.05 + 26
            break
          case 'invert':
            er = 255 - r; eg = 255 - g; eb = 255 - b
            break
        }
        r += t * (er - r)
        g += t * (eg - g)
        b += t * (eb - b)
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
 * Opérations SPATIALES (yeux rouges, tampon) — appliquées sur les pixels bruts
 * POST-GÉOMETRIE, AVANT les opérations couleur, dans les DEUX moteurs.
 * Ordre d'application global (fixe, identique preview/export) :
 *   géométrie (straighten + crop) → retouch → redeye → ops couleur (ordre du stack)
 */
export function applySpatialOps(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  channels: 3 | 4,
  ops: EditOp[]
): void {
  const retouch = ops.find((o) => o.type === 'retouch') as
    | Extract<EditOp, { type: 'retouch' }>
    | undefined
  const redeye = ops.find((o) => o.type === 'redeye') as
    | Extract<EditOp, { type: 'redeye' }>
    | undefined
  if (!retouch && !redeye) return

  // --- Tampon : copie de disque adouci depuis la source vers la destination ---
  if (retouch && retouch.params.strokes.length > 0) {
    // Lecture depuis un instantané pour éviter les traînées entre strokes
    const src = data.slice()
    for (const st of retouch.params.strokes) {
      const rPx = Math.max(2, st.r * width)
      const dcx = st.dx * width
      const dcy = st.dy * height
      const ox = Math.round((st.sx - st.dx) * width)
      const oy = Math.round((st.sy - st.dy) * height)
      const x0 = Math.max(0, Math.floor(dcx - rPx))
      const x1 = Math.min(width - 1, Math.ceil(dcx + rPx))
      const y0 = Math.max(0, Math.floor(dcy - rPx))
      const y1 = Math.min(height - 1, Math.ceil(dcy + rPx))
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dist = Math.hypot(x - dcx, y - dcy)
          if (dist > rPx) continue
          const sxp = x + ox
          const syp = y + oy
          if (sxp < 0 || sxp >= width || syp < 0 || syp >= height) continue
          // Bord adouci sur les 30 % extérieurs du rayon
          const t = dist / rPx
          const w = t < 0.7 ? 1 : (1 - t) / 0.3
          const di = (y * width + x) * channels
          const si = (syp * width + sxp) * channels
          for (let c = 0; c < 3; c++) {
            data[di + c] = Math.round(data[di + c] + w * (src[si + c] - data[di + c]))
          }
        }
      }
    }
  }

  // --- Yeux rouges : désaturation du rouge dans les zones ---
  if (redeye && redeye.params.zones.length > 0) {
    for (const z of redeye.params.zones) {
      const rPx = Math.max(2, z.r * width)
      const cx = z.x * width
      const cy = z.y * height
      const x0 = Math.max(0, Math.floor(cx - rPx))
      const x1 = Math.min(width - 1, Math.ceil(cx + rPx))
      const y0 = Math.max(0, Math.floor(cy - rPx))
      const y1 = Math.min(height - 1, Math.ceil(cy + rPx))
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if (Math.hypot(x - cx, y - cy) > rPx) continue
          const i = (y * width + x) * channels
          const rr = data[i]
          const gg = data[i + 1]
          const bb = data[i + 2]
          // Pixel "rouge dominant" → ramené vers la moyenne G/B
          if (rr > (gg + bb) / 2 + 15) {
            data[i] = Math.round((gg + bb) / 2)
          }
        }
      }
    }
  }
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
