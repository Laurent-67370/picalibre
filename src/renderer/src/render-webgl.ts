/**
 * Moteur de preview WebGL — accélération GPU des opérations COULEUR.
 *
 * Principe de parité avec le CPU (applyColorOps, partagé avec l'export sharp) :
 *  - même domaine 0..255 dans le shader ;
 *  - luminance Rec.601 recalculée AVANT CHAQUE op, comme en JS ;
 *  - aucun clamp entre les ops (les valeurs restent flottantes), clamp unique
 *    en sortie — l'écriture RGBA8 arrondit au plus proche, comme clamp255().
 * Le fragment shader est GÉNÉRÉ depuis le stack (un extrait GLSL par op, dans
 * l'ordre du stack) et mis en cache par signature de séquence.
 *
 * La géométrie (crop/straighten) et le spatial (yeux rouges/tampon) restent
 * sur le chemin existant : seul le per-pixel couleur — le coût dominant — est
 * déporté sur GPU. Fallback CPU automatique si WebGL indisponible ou en échec.
 */
import { ColorOpType, EditOp, FilterName } from '@shared/edit-engine'

type ColorOp = Extract<
  EditOp,
  { type: 'levels' } | { type: 'wb' } | { type: 'filter' } | { type: ColorOpType }
>

export function colorOpsOf(ops: EditOp[]): ColorOp[] {
  return ops.filter(
    (o): o is ColorOp =>
      o.type !== 'crop' &&
      o.type !== 'straighten' &&
      o.type !== 'redeye' &&
      o.type !== 'retouch' &&
      o.type !== 'text' &&
      o.type !== 'border' &&
      o.type !== 'vignette'
  )
}

const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`

const LUMA = 'dot(c, vec3(0.299, 0.587, 0.114))'

/** Extrait GLSL d'une op (c en 0..255), uniform u{i}. */
function glslFor(op: ColorOp, i: number): { decl: string; body: string } {
  const u = `u${i}`
  switch (op.type) {
    case 'levels':
      return {
        decl: `uniform vec2 ${u};`,
        body: `{ float k = 255.0 / max(1.0, ${u}.y - ${u}.x); c = (c - vec3(${u}.x)) * k; }`
      }
    case 'wb':
      return { decl: `uniform vec3 ${u};`, body: `c *= ${u};` }
    case 'filter': {
      const name = op.params.name as FilterName
      const eff: Record<FilterName, string> = {
        bw: `vec3 e = vec3(l);`,
        sepia: `vec3 e = vec3(
            dot(c, vec3(0.393, 0.769, 0.189)),
            dot(c, vec3(0.349, 0.686, 0.168)),
            dot(c, vec3(0.272, 0.534, 0.131)));`,
        warmify: `vec3 e = vec3(l) + (c - vec3(l)) * 1.15 + vec3(28.0, 6.0, -22.0);`,
        cool: `vec3 e = vec3(l) + (c - vec3(l)) * 1.05 + vec3(-22.0, 0.0, 26.0);`,
        invert: `vec3 e = vec3(255.0) - c;`,
        posterize: `float pstep = 255.0 / 4.0; vec3 e = floor(c / pstep + 0.5) * pstep;`,
        duotone: `vec3 e = mix(vec3(15.0, 23.0, 42.0), vec3(249.0, 115.0, 22.0), l / 255.0);`,
        crossprocess: `vec3 e = vec3(c.r, c.g + 15.0, c.b < 128.0 ? c.b * 0.7 : c.b + (c.b - 128.0) * 0.5);`,
        grain: `float gh = fract(sin(dot(v_uv, vec2(12.9898, 78.233))) * 43758.5453); vec3 e = c + vec3((gh - 0.5) * 45.0);`
      }
      return {
        decl: `uniform float ${u};`,
        body: `{ float l = ${LUMA}; ${eff[name]} c += ${u} * (e - c); }`
      }
    }
    case 'fill_light':
      return {
        decl: `uniform float ${u};`,
        body: `{ float l = ${LUMA} / 255.0; float w = ${u} * (1.0 - l) * (1.0 - l) * 0.9; c += w * (vec3(255.0) - c); }`
      }
    case 'highlights':
      return {
        decl: `uniform float ${u};`,
        body: `{ float l = ${LUMA} / 255.0; float w = ${u} * l * l; c += w * (vec3(255.0) - c); }`
      }
    case 'contrast':
      return {
        decl: `uniform float ${u};`,
        body: `c = (c - vec3(128.0)) * (1.0 + ${u}) + vec3(128.0);`
      }
    case 'saturation':
      return {
        decl: `uniform float ${u};`,
        body: `{ float lum = ${LUMA}; c = vec3(lum) + (c - vec3(lum)) * (1.0 + ${u}); }`
      }
    case 'temperature':
      return {
        decl: `uniform float ${u};`,
        body: `{ c.r += ${u} * 40.0; c.b -= ${u} * 40.0; }`
      }
  }
}

/** Signature de séquence (le nom du filtre change le shader, les valeurs non). */
function signatureOf(ops: ColorOp[]): string {
  return ops.map((o) => (o.type === 'filter' ? `filter:${o.params.name}` : o.type)).join('|')
}

function fragSource(ops: ColorOp[]): string {
  const parts = ops.map((o, i) => glslFor(o, i))
  return `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
${parts.map((p) => p.decl).join('\n')}
void main() {
  vec3 c = texture2D(u_tex, v_uv).rgb * 255.0;
${parts.map((p) => '  ' + p.body).join('\n')}
  gl_FragColor = vec4(clamp(c / 255.0, 0.0, 1.0), 1.0);
}`
}

interface Program {
  prog: WebGLProgram
  uniforms: WebGLUniformLocation[]
}

let glCanvas: HTMLCanvasElement | null = null
let gl: WebGLRenderingContext | null = null
let quad: WebGLBuffer | null = null
let texture: WebGLTexture | null = null
const programCache = new Map<string, Program>()
let webglBroken = false

function ensureContext(): WebGLRenderingContext | null {
  if (webglBroken) return null
  if (gl && !gl.isContextLost()) return gl
  glCanvas = document.createElement('canvas')
  gl =
    (glCanvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true }) as
      | WebGLRenderingContext
      | null) ?? null
  if (!gl) {
    webglBroken = true
    return null
  }
  programCache.clear()
  quad = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, quad)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  texture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return gl
}

function compile(g: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const sh = g.createShader(type)!
  g.shaderSource(sh, src)
  g.compileShader(sh)
  if (!g.getShaderParameter(sh, g.COMPILE_STATUS)) {
    throw new Error(g.getShaderInfoLog(sh) ?? 'compilation shader')
  }
  return sh
}

function programFor(g: WebGLRenderingContext, ops: ColorOp[]): Program {
  const sig = signatureOf(ops)
  const cached = programCache.get(sig)
  if (cached) return cached
  const prog = g.createProgram()!
  g.attachShader(prog, compile(g, g.VERTEX_SHADER, VERT))
  g.attachShader(prog, compile(g, g.FRAGMENT_SHADER, fragSource(ops)))
  g.linkProgram(prog)
  if (!g.getProgramParameter(prog, g.LINK_STATUS)) {
    throw new Error(g.getProgramInfoLog(prog) ?? 'link shader')
  }
  const uniforms = ops.map((_, i) => g.getUniformLocation(prog, `u${i}`)!)
  const entry = { prog, uniforms }
  programCache.set(sig, entry)
  return entry
}

function setUniforms(g: WebGLRenderingContext, ops: ColorOp[], uniforms: WebGLUniformLocation[]): void {
  ops.forEach((op, i) => {
    const loc = uniforms[i]
    switch (op.type) {
      case 'levels':
        g.uniform2f(loc, op.params.black, op.params.white)
        break
      case 'wb':
        g.uniform3f(loc, op.params.r, op.params.g, op.params.b)
        break
      case 'filter':
        g.uniform1f(loc, op.params.intensity)
        break
      default:
        g.uniform1f(loc, op.params.value)
    }
  })
}

export function isWebglAvailable(): boolean {
  return ensureContext() !== null
}

/**
 * Applique les ops couleur sur GPU et dessine le résultat dans `targetCtx`
 * à (0,0). `source` : canvas 2D (chemin rapide, zéro getImageData) ou
 * ImageData (après ops spatiales CPU). Retourne false si le CPU doit prendre
 * le relais.
 */
export function applyColorOpsWebGL(
  source: HTMLCanvasElement | ImageData,
  ops: EditOp[],
  targetCtx: CanvasRenderingContext2D,
  width: number,
  height: number
): boolean {
  const colorOps = colorOpsOf(ops)
  if (colorOps.length === 0) return true
  const g = ensureContext()
  if (!g || !glCanvas) return false
  try {
    if (glCanvas.width !== width || glCanvas.height !== height) {
      glCanvas.width = width
      glCanvas.height = height
    }
    g.viewport(0, 0, width, height)

    g.bindTexture(g.TEXTURE_2D, texture)
    g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, 1)
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, source as TexImageSource)

    const { prog, uniforms } = programFor(g, colorOps)
    g.useProgram(prog)
    setUniforms(g, colorOps, uniforms)

    g.bindBuffer(g.ARRAY_BUFFER, quad)
    const aPos = g.getAttribLocation(prog, 'a_pos')
    g.enableVertexAttribArray(aPos)
    g.vertexAttribPointer(aPos, 2, g.FLOAT, false, 0, 0)
    g.drawArrays(g.TRIANGLES, 0, 3)

    // UNPACK_FLIP_Y à l'upload suffit : le canvas GL s'affiche déjà à l'endroit
    targetCtx.drawImage(glCanvas, 0, 0)
    return true
  } catch (err) {
    console.warn('[webgl] bascule CPU :', (err as Error).message)
    webglBroken = true
    return false
  }
}
