/**
 * Test de parité WebGL ↔ CPU — exécuté DANS le renderer Electron
 * (mode PICALIBRE_TEST_WEBGL, le main capture les console.log).
 *
 * Pour chaque stack de test : le même ImageData de référence passe par
 * applyColorOps (CPU, vérité de l'export sharp) et par applyColorOpsWebGL.
 * Tolérance : 1/255 par canal (arrondi float GPU), avec un taux de pixels
 * divergents borné.
 */
import { EditOp, applyColorOps } from '@shared/edit-engine'
import { applyColorOpsWebGL, isWebglAvailable } from './render-webgl'

const SIZE = 256

function referenceImage(): ImageData {
  const img = new ImageData(SIZE, SIZE)
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4
      img.data[i] = x
      img.data[i + 1] = y
      img.data[i + 2] = (x * 7 + y * 13) % 256
      img.data[i + 3] = 255
    }
  }
  return img
}

// Note : le filtre 'grain' n'est PAS dans CASES ci-dessous — sin() perd en
// précision pour de grands arguments sur GPU (comportement dépendant du
// matériel/driver), donc son bruit position-based diverge pixel à pixel
// entre CPU et GPU. Sans conséquence visuelle (effet stochastique : seul
// l'aspect granuleux général compte). Un smoke-test séparé (plus bas)
// vérifie juste qu'il s'exécute sans erreur sur les deux chemins.
const CASES: Array<[string, EditOp[]]> = [
  ['levels', [{ type: 'levels', params: { black: 12, white: 238 } }]],
  ['wb', [{ type: 'wb', params: { r: 1.18, g: 0.97, b: 0.86 } }]],
  ['filtre bw', [{ type: 'filter', params: { name: 'bw', intensity: 0.7 } }]],
  ['filtre sepia', [{ type: 'filter', params: { name: 'sepia', intensity: 0.8 } }]],
  ['filtre warmify', [{ type: 'filter', params: { name: 'warmify', intensity: 0.6 } }]],
  ['filtre cool', [{ type: 'filter', params: { name: 'cool', intensity: 0.6 } }]],
  ['filtre invert', [{ type: 'filter', params: { name: 'invert', intensity: 1 } }]],
  ['filtre posterize', [{ type: 'filter', params: { name: 'posterize', intensity: 1 } }]],
  ['filtre duotone', [{ type: 'filter', params: { name: 'duotone', intensity: 0.8 } }]],
  ['filtre crossprocess', [{ type: 'filter', params: { name: 'crossprocess', intensity: 0.8 } }]],
  ['fill_light', [{ type: 'fill_light', params: { value: 0.5 } }]],
  ['highlights', [{ type: 'highlights', params: { value: -0.4 } }]],
  ['shadows', [{ type: 'shadows', params: { value: 0.5 } }]],
  ['contrast', [{ type: 'contrast', params: { value: 0.35 } }]],
  ['saturation', [{ type: 'saturation', params: { value: -0.3 } }]],
  ['vibrance', [{ type: 'vibrance', params: { value: 0.6 } }]],
  ['temperature', [{ type: 'temperature', params: { value: 0.6 } }]],
  ['hue', [{ type: 'hue', params: { value: 0.4 } }]],
  [
    'chaîne complète',
    [
      { type: 'levels', params: { black: 8, white: 245 } },
      { type: 'wb', params: { r: 1.1, g: 1.0, b: 0.9 } },
      { type: 'fill_light', params: { value: 0.35 } },
      { type: 'highlights', params: { value: -0.25 } },
      { type: 'shadows', params: { value: 0.3 } },
      { type: 'contrast', params: { value: 0.3 } },
      { type: 'saturation', params: { value: 0.2 } },
      { type: 'vibrance', params: { value: 0.3 } },
      { type: 'temperature', params: { value: 0.4 } },
      { type: 'hue', params: { value: -0.2 } },
      { type: 'filter', params: { name: 'sepia', intensity: 0.5 } }
    ]
  ]
]

export async function runWebglParityTest(): Promise<void> {
  console.log('[webgl-test] démarrage')
  if (!isWebglAvailable()) {
    console.log('[webgl-test] VERDICT: SKIP (WebGL indisponible — fallback CPU assumé)')
    return
  }

  let allPass = true
  for (const [name, ops] of CASES) {
    // CPU (vérité export)
    const cpu = referenceImage()
    applyColorOps(cpu.data, 4, ops, SIZE)

    // GPU
    const src = referenceImage()
    const out = document.createElement('canvas')
    out.width = SIZE
    out.height = SIZE
    const ctx = out.getContext('2d', { willReadFrequently: true })!
    const ok = applyColorOpsWebGL(src, ops, ctx, SIZE, SIZE)
    if (!ok) {
      console.log(`[webgl-test] ${name}: ÉCHEC rendu GPU`)
      allPass = false
      continue
    }
    const gpu = ctx.getImageData(0, 0, SIZE, SIZE)

    let maxDiff = 0
    let diffCount = 0
    for (let i = 0; i < cpu.data.length; i += 4) {
      for (let ch = 0; ch < 3; ch++) {
        const d = Math.abs(cpu.data[i + ch] - gpu.data[i + ch])
        if (d > maxDiff) maxDiff = d
        if (d > 0) diffCount++
      }
    }
    const pct = (diffCount / ((cpu.data.length / 4) * 3)) * 100
    const pass = maxDiff <= 1 && pct < 5
    if (!pass) allPass = false
    console.log(
      `[webgl-test] ${pass ? '✅' : '❌'} ${name} — écart max ${maxDiff}/255, ${pct.toFixed(2)} % de pixels à ±1`
    )
  }

  // Smoke-test grain : vérifie juste que les deux chemins s'exécutent sans
  // erreur et produisent un résultat non vide — pas de comparaison pixel
  // (voir la note au-dessus de CASES pour pourquoi).
  try {
    const grainOps: EditOp[] = [{ type: 'filter', params: { name: 'grain', intensity: 1 } }]
    const cpuG = referenceImage()
    applyColorOps(cpuG.data, 4, grainOps, SIZE)
    const srcG = referenceImage()
    const outG = document.createElement('canvas')
    outG.width = SIZE
    outG.height = SIZE
    const ctxG = outG.getContext('2d', { willReadFrequently: true })!
    const okG = applyColorOpsWebGL(srcG, grainOps, ctxG, SIZE, SIZE)
    console.log(`[webgl-test] ${okG ? '✅' : '❌'} filtre grain (smoke-test, sans comparaison pixel)`)
    if (!okG) allPass = false
  } catch (err) {
    console.log(`[webgl-test] ❌ filtre grain (smoke-test) exception : ${(err as Error).message}`)
    allPass = false
  }

  console.log(`[webgl-test] VERDICT: ${allPass ? 'PASS' : 'FAIL'}`)
}
