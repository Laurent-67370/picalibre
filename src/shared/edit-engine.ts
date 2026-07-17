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

export type ColorOpType =
  | 'fill_light'
  | 'highlights'
  | 'shadows'
  | 'contrast'
  | 'saturation'
  | 'vibrance'
  | 'temperature'
  | 'hue'

/** Effets basés sur le flou — opérations SPATIALES (pas des colorOps). */
export type BlurEffectType = 'blur' | 'sharpen' | 'softfocus' | 'glow' | 'orton'

export type FilterName =
  | 'bw'
  | 'sepia'
  | 'warmify'
  | 'cool'
  | 'invert'
  | 'posterize'
  | 'duotone'
  | 'crossprocess'
  | 'grain'

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

/** Style de bordure/cadre. */
export type BorderStyle = 'solid' | 'polaroid' | 'museum'

/** Paramètres d'une opération de bordure/cadre sur photo. */
export interface BorderOpParams {
  thickness: number // épaisseur en ratio de la largeur (0..0.15), ex: 0.03 = 3% de la largeur
  color: string // couleur CSS hex, ex: '#ffffff'
  style: BorderStyle // 'solid' = bordure uniforme, 'polaroid' = bord fine + bord bas plus large
}

/** Paramètres d'une opération de texte sur photo. */
export interface TextOpParams {
  content: string
  fontFamily: string // ex: 'sans-serif', 'serif', 'monospace'
  fontSize: number // ratio relatif à la largeur de l'image (0..1), ex: 0.05 = 5% de la largeur
  color: string // couleur CSS hex, ex: '#ffffff'
  x: number // position normalisée 0..1 (centre du texte)
  y: number // position normalisée 0..1 (centre du texte)
  opacity: number // 0..1
  shadow: boolean // ombre portée
  shadowColor: string // couleur de l'ombre (hex)
  shadowBlur: number // flou de l'ombre en ratio relatif à la largeur (0..0.02)
  fontWeight: string // 'normal' | 'bold'
}

export type EditOp =
  | { type: 'crop'; params: { x: number; y: number; w: number; h: number } }
  | { type: 'straighten'; params: { angle: number } } // degrés, -15..15
  | { type: 'levels'; params: { black: number; white: number } } // contraste auto (0..255)
  | { type: 'wb'; params: { r: number; g: number; b: number } } // gains balance des blancs
  | { type: 'filter'; params: { name: FilterName; intensity: number } } // 0..1
  | { type: 'vignette'; params: { intensity: number } } // 0..1, assombrissement radial des bords
  | { type: 'redeye'; params: { zones: RedeyeZone[] } }
  | { type: 'retouch'; params: { strokes: RetouchStroke[] } }
  | { type: 'text'; params: TextOpParams }
  | { type: 'border'; params: BorderOpParams }
  | { type: 'blur'; params: { radius: number } } // rayon du flou en px (0..20)
  | { type: 'sharpen'; params: { amount: number } } // unsharp mask, 0..1
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
    (op.type === 'vignette' && op.params.intensity === 0) ||
    (op.type === 'redeye' && op.params.zones.length === 0) ||
    (op.type === 'retouch' && op.params.strokes.length === 0) ||
    (op.type === 'text' && op.params.content.trim() === '') ||
    (op.type === 'border' && op.params.thickness <= 0) ||
    (op.type === 'blur' && op.params.radius <= 0) ||
    (op.type === 'sharpen' && op.params.amount <= 0)
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
  ops: EditOp[],
  width: number
): void {
  const colorOps = ops.filter(
    (o) =>
      o.type !== 'crop' &&
      o.type !== 'straighten' &&
      o.type !== 'redeye' &&
      o.type !== 'retouch' &&
      o.type !== 'text' &&
      o.type !== 'border' &&
      o.type !== 'blur' &&
      o.type !== 'sharpen' &&
      o.type !== 'vignette'
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
          case 'posterize': {
            const step = 255 / 4
            er = Math.round(r / step) * step
            eg = Math.round(g / step) * step
            eb = Math.round(b / step) * step
            break
          }
          case 'duotone': {
            // Dégradé bicolore navy → orange (identité visuelle PicaLibre)
            const t = l / 255
            er = 15 + t * (249 - 15)
            eg = 23 + t * (115 - 23)
            eb = 42 + t * (22 - 42)
            break
          }
          case 'crossprocess':
            er = r
            eg = g + 15
            eb = b < 128 ? b * 0.7 : b + (b - 128) * 0.5
            break
          case 'grain': {
            // Bruit pseudo-aléatoire déterministe basé sur la position — pas de
            // Math.random() : rendu stable et reproductible.
            // Exception assumée à la parité stricte CPU/GPU (documentée dans
            // webgl-parity-test.ts) : sin() perd en précision pour de grands
            // arguments sur GPU (comportement dépendant du matériel/driver,
            // hors de notre contrôle) — la formule position-based du shader
            // et celle-ci divergent donc pixel à pixel. Sans conséquence
            // visuelle : un grain de film est un effet stochastique, seul
            // l'aspect granuleux général compte, pas la correspondance exacte
            // entre preview (GPU) et export (CPU).
            const pIdx = i / channels
            const px = pIdx % width
            const py = Math.floor(pIdx / width)
            const h = Math.sin(px * 12.9898 + py * 78.233) * 43758.5453
            const n2 = (h - Math.floor(h) - 0.5) * 45
            er = r + n2; eg = g + n2; eb = b + n2
            break
          }
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
        case 'shadows': {
          // Miroir de highlights, pondéré par l'obscurité (1-l) au lieu de
          // la clarté : v>0 éclaircit les ombres, v<0 les assombrit (plus
          // de contraste dans les tons foncés). Distinct de fill_light
          // (qui ne fait que relever, jamais assombrir).
          const w = v * (1 - l) * (1 - l)
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
        case 'vibrance': {
          // Saturation « intelligente » : boost inversement proportionnel à
          // la saturation déjà présente — protège les teintes déjà vives
          // (et les carnations) d'une sursaturation, contrairement à
          // 'saturation' qui boost tout uniformément.
          const mx = Math.max(r, g, b)
          const mn = Math.min(r, g, b)
          const cur = mx === 0 ? 0 : (mx - mn) / mx
          const k = 1 + v * (1 - cur)
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
        case 'hue': {
          // Rotation de teinte via HSV (v ∈ [-1,1] → ±180°)
          const mx = Math.max(r, g, b)
          const mn = Math.min(r, g, b)
          const d = mx - mn
          let h = 0
          if (d !== 0) {
            if (mx === r) h = (((g - b) / d) % 6)
            else if (mx === g) h = (b - r) / d + 2
            else h = (r - g) / d + 4
            h *= 60
            if (h < 0) h += 360
          }
          const s = mx === 0 ? 0 : d / mx
          const val = mx / 255
          h = (h + v * 180 + 360) % 360
          const cc = val * s
          const x = cc * (1 - Math.abs(((h / 60) % 2) - 1))
          const m = val - cc
          let rr = 0, gg = 0, bb = 0
          if (h < 60) { rr = cc; gg = x; bb = 0 }
          else if (h < 120) { rr = x; gg = cc; bb = 0 }
          else if (h < 180) { rr = 0; gg = cc; bb = x }
          else if (h < 240) { rr = 0; gg = x; bb = cc }
          else if (h < 300) { rr = x; gg = 0; bb = cc }
          else { rr = cc; gg = 0; bb = x }
          r = (rr + m) * 255
          g = (gg + m) * 255
          b = (bb + m) * 255
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

/** Récupère le rayon de flou du stack (0 si absent). */
export function getBlurRadius(stack: EditStack): number {
  return getOp(stack, 'blur')?.params.radius ?? 0
}

/** Récupère le montant de netteté du stack (0 si absent). */
export function getSharpenAmount(stack: EditStack): number {
  return getOp(stack, 'sharpen')?.params.amount ?? 0
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
  const vignette = ops.find((o) => o.type === 'vignette') as
    | Extract<EditOp, { type: 'vignette' }>
    | undefined
  if (!retouch && !redeye && !vignette) return

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

  // --- Vignette : assombrissement radial, nul au centre, maximal aux coins ---
  if (vignette && vignette.params.intensity > 0) {
    const t = vignette.params.intensity
    const cx = width / 2
    const cy = height / 2
    // Rayon normalisant : distance centre→coin = assombrissement maximal (t)
    const maxDist = Math.hypot(cx, cy)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const d = Math.hypot(x - cx, y - cy) / maxDist // 0 au centre, 1 au coin
        const k = 1 - t * d * d // assombrissement quadratique (doux au centre)
        const i = (y * width + x) * channels
        data[i] = Math.round(data[i] * k)
        data[i + 1] = Math.round(data[i + 1] * k)
        data[i + 2] = Math.round(data[i + 2] * k)
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

/**
 * Récupère l'opération text du stack, le cas échéant.
 * Une seule instance de texte est autorisée (modèle upsert).
 */
export function getTextOp(
  stack: EditStack
): Extract<EditOp, { type: 'text' }> | undefined {
  return getOp(stack, 'text')
}

/**
 * Récupère l'opération border du stack, le cas échéant.
 * Une seule instance de bordure est autorisée (modèle upsert).
 */
export function getBorderOp(
  stack: EditStack
): Extract<EditOp, { type: 'border' }> | undefined {
  return getOp(stack, 'border')
}

/**
 * Échappe le texte pour l'inclusion dans un SVG (export sharp).
 * Échappe & < > " et les apostrophes.
 */
export function escapeSvgText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Convertit une couleur hex (#rrggbb) en attributs SVG fill + opacity.
 * Retourne { fill, opacity } où fill est 'rgb(r,g,b)' et opacity est 0..1.
 */
export function hexToSvgFill(hex: string, opacity: number): { fill: string; opacity: number } {
  const m = /^#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex)
  if (!m) return { fill: hex, opacity }
  const r = parseInt(m[1], 16)
  const g = parseInt(m[2], 16)
  const b = parseInt(m[3], 16)
  return { fill: `rgb(${r},${g},${b})`, opacity }
}
