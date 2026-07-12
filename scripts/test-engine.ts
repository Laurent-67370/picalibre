/**
 * Test du moteur d'édition : DSL, math couleur, pipeline export sharp.
 * Usage : npx tsx scripts/test-engine.ts
 */
import sharp from 'sharp'
import assert from 'node:assert'
import {
  applySpatialOps,
  computeAutoContrast,
  computeAutoColor,
  emptyStack,
  upsertOp,
  applyColorOps,
  cropRectPx,
  stackHash,
  EditStack
} from '../src/shared/edit-engine'
import { renderEdited } from '../src/main/services/render-sharp'
import {
  bestMatch,
  blobToF32,
  cosine,
  f32ToBlob,
  mergeCentroid
} from '../src/main/services/faces/cluster'

async function main() {
  // --- 1. DSL : upsertOp remplace, valeur neutre supprime ---
  let s = emptyStack()
  s = upsertOp(s, { type: 'contrast', params: { value: 0.5 } })
  s = upsertOp(s, { type: 'contrast', params: { value: 0.3 } })
  assert.equal(s.ops.length, 1, 'une seule instance par type')
  assert.equal((s.ops[0].params as any).value, 0.3)
  s = upsertOp(s, { type: 'contrast', params: { value: 0 } })
  assert.equal(s.ops.length, 0, 'valeur 0 = op supprimée')
  console.log('✅ DSL upsertOp')

  // --- 2. Math couleur : propriétés attendues ---
  const px = new Uint8ClampedArray([128, 128, 128, 255, 10, 200, 250, 255])
  applyColorOps(px, 4, [{ type: 'contrast', params: { value: 0.5 } }])
  assert.deepEqual([px[0], px[1], px[2]], [128, 128, 128], 'gris moyen invariant au contraste')
  assert.equal(px[4] < 10, true, 'sombre plus sombre')
  assert.equal(px[6], 255, 'clamp à 255')

  const warm = new Uint8ClampedArray([100, 100, 100, 255])
  applyColorOps(warm, 4, [{ type: 'temperature', params: { value: 1 } }])
  assert.equal(warm[0] > 100 && warm[2] < 100, true, 'température : R+ B-')

  const fill = new Uint8ClampedArray([20, 20, 20, 255, 240, 240, 240, 255])
  const before = [fill[0], fill[4]]
  applyColorOps(fill, 4, [{ type: 'fill_light', params: { value: 0.5 } }])
  assert.equal(fill[0] - before[0] > fill[4] - before[1], true, 'fill light agit surtout sur les ombres')
  console.log('✅ Math couleur (contraste, température, fill light, clamp)')

  // --- 3. Parité RGB/RGBA : mêmes valeurs quel que soit le nb de canaux ---
  const ops: EditStack['ops'] = [
    { type: 'fill_light', params: { value: 0.4 } },
    { type: 'contrast', params: { value: 0.3 } },
    { type: 'saturation', params: { value: -0.2 } },
    { type: 'temperature', params: { value: 0.5 } }
  ]
  const rgba = new Uint8ClampedArray([37, 142, 210, 255])
  const rgb = new Uint8Array([37, 142, 210])
  applyColorOps(rgba, 4, ops)
  applyColorOps(rgb, 3, ops)
  assert.deepEqual([rgba[0], rgba[1], rgba[2]], [rgb[0], rgb[1], rgb[2]], 'parité 3/4 canaux')
  console.log('✅ Parité RGB (sharp) / RGBA (canvas) par construction')

  // --- 4. cropRectPx : bornes et normalisation ---
  const cs = upsertOp(emptyStack(), { type: 'crop', params: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } })
  const rect = cropRectPx(cs, 4000, 3000)!
  assert.deepEqual(rect, { left: 1000, top: 750, width: 2000, height: 1500 })
  console.log('✅ cropRectPx (coordonnées normalisées → pixels)')

  // --- 5. Pipeline export complet sur image de test ---
  const testImg = await sharp({
    create: { width: 800, height: 600, channels: 3, background: { r: 30, g: 60, b: 120 } }
  })
    .composite([
      {
        input: await sharp({
          create: { width: 400, height: 300, channels: 3, background: { r: 220, g: 180, b: 90 } }
        }).png().toBuffer(),
        left: 200,
        top: 150
      }
    ])
    .jpeg()
    .toBuffer()
  const tmp = '/tmp/picalibre-test.jpg'
  await sharp(testImg).toFile(tmp)

  let stack = emptyStack()
  stack = upsertOp(stack, { type: 'straighten', params: { angle: 5 } })
  stack = upsertOp(stack, { type: 'crop', params: { x: 0.1, y: 0.1, w: 0.6, h: 0.6 } })
  stack = upsertOp(stack, { type: 'fill_light', params: { value: 0.4 } })
  stack = upsertOp(stack, { type: 'contrast', params: { value: 0.3 } })
  stack = upsertOp(stack, { type: 'temperature', params: { value: 0.5 } })

  const out1 = await renderEdited(tmp, stack, { format: 'jpeg', quality: 92 })
  const out2 = await renderEdited(tmp, stack, { format: 'jpeg', quality: 92 })
  assert.equal(Buffer.compare(out1, out2), 0, 'rendu déterministe')

  const meta = await sharp(out1).metadata()
  // 800x600 pivoté de 5° ≈ 849x667 ; crop 60 % ≈ 509x400
  assert.equal(Math.abs((meta.width ?? 0) - 509) <= 2, true, `largeur export ${meta.width}`)
  assert.equal(Math.abs((meta.height ?? 0) - 400) <= 2, true, `hauteur export ${meta.height}`)
  console.log(`✅ Export sharp : ${meta.width}x${meta.height}, déterministe, ${out1.length} octets`)

  // Sans édition = dimensions intactes
  const plain = await renderEdited(tmp, emptyStack(), { format: 'png' })
  const pm = await sharp(plain).metadata()
  assert.deepEqual([pm.width, pm.height], [800, 600], 'stack vide = dimensions intactes')
  console.log('✅ Stack vide : original préservé')

  // --- 6bis. Levels + WB + analyses auto ---
  const lv = new Uint8ClampedArray([50, 50, 50, 255, 200, 200, 200, 255])
  applyColorOps(lv, 4, [{ type: 'levels', params: { black: 50, white: 200 } }])
  assert.deepEqual([lv[0], lv[4]], [0, 255], 'levels étire la dynamique')

  const wb = new Uint8ClampedArray([100, 100, 100, 255])
  applyColorOps(wb, 4, [{ type: 'wb', params: { r: 1.2, g: 1, b: 0.8 } }])
  assert.deepEqual([wb[0], wb[1], wb[2]], [120, 100, 80], 'gains wb appliqués')

  // Image bleutée : l'auto-color doit pousser R et réduire B
  const cast = new Uint8Array(300)
  for (let i = 0; i < 300; i += 3) { cast[i] = 80; cast[i+1] = 100; cast[i+2] = 160 }
  const gains = computeAutoColor(cast, 3)
  assert.equal(gains.r > 1 && gains.b < 1, true, 'gray world corrige la dominante')

  // Image terne 60..180 : l'auto-contraste doit resserrer les points
  const flat = new Uint8Array(3000)
  for (let i = 0; i < 3000; i += 3) { const v = 60 + ((i/3) % 121); flat[i]=v; flat[i+1]=v; flat[i+2]=v }
  const lvls = computeAutoContrast(flat, 3)
  assert.equal(lvls.black >= 55 && lvls.white <= 185, true, `auto-contraste ${JSON.stringify(lvls)}`)

  // Neutralité : upsert d'un levels neutre supprime l'op
  let ns = upsertOp(emptyStack(), { type: 'levels', params: { black: 0, white: 255 } })
  assert.equal(ns.ops.length, 0, 'levels neutre supprimé')
  ns = upsertOp(ns, { type: 'wb', params: { r: 1, g: 1, b: 1 } })
  assert.equal(ns.ops.length, 0, 'wb neutre supprimé')
  console.log('✅ Levels, WB, auto-contraste, auto-couleur')

  // --- 6ter. Filtres, yeux rouges, tampon ---
  const fbw = new Uint8ClampedArray([200, 100, 50, 255])
  applyColorOps(fbw, 4, [{ type: 'filter', params: { name: 'bw', intensity: 1 } }])
  assert.equal(fbw[0] === fbw[1] && fbw[1] === fbw[2], true, 'filtre N&B : canaux égaux')

  const fhalf = new Uint8ClampedArray([200, 100, 50, 255])
  applyColorOps(fhalf, 4, [{ type: 'filter', params: { name: 'invert', intensity: 0.5 } }])
  assert.deepEqual([fhalf[0], fhalf[1], fhalf[2]], [128, 128, 128], 'intensité 0,5 = mélange 50/50')

  // Image 4x4 : pixel rouge vif au centre d'une zone yeux rouges
  const W = 4, H = 4
  const eye = new Uint8Array(W * H * 3).fill(80)
  const ci = (1 * W + 1) * 3
  eye[ci] = 220; eye[ci + 1] = 60; eye[ci + 2] = 60
  applySpatialOps(eye, W, H, 3, [
    { type: 'redeye', params: { zones: [{ x: 0.375, y: 0.375, r: 0.3 }] } }
  ])
  assert.equal(eye[ci], 60, 'rouge dominant ramené à la moyenne G/B')
  assert.equal(eye[0], 80, 'pixels hors zone intacts')

  // Tampon : copie la source (claire) sur la destination (sombre)
  const W2 = 10, H2 = 10
  const patch = new Uint8Array(W2 * H2 * 3).fill(200)
  const di = (5 * W2 + 2) * 3
  patch[di] = 10; patch[di + 1] = 10; patch[di + 2] = 10 // défaut sombre en (2,5)
  applySpatialOps(patch, W2, H2, 3, [
    { type: 'retouch', params: { strokes: [{ dx: 0.2, dy: 0.5, sx: 0.7, sy: 0.5, r: 0.1 }] } }
  ])
  assert.equal(patch[di] > 150, true, `défaut recouvert par la source (${patch[di]})`)

  // Parité 3/4 canaux maintenue avec les ops spatiales + filtre
  const spOps: EditStack['ops'] = [
    { type: 'redeye', params: { zones: [{ x: 0.5, y: 0.5, r: 0.4 }] } },
    { type: 'filter', params: { name: 'sepia', intensity: 0.7 } }
  ]
  const p3 = new Uint8Array([220, 60, 60])
  const p4 = new Uint8ClampedArray([220, 60, 60, 255])
  applySpatialOps(p3, 1, 1, 3, spOps); applyColorOps(p3, 3, spOps)
  applySpatialOps(p4, 1, 1, 4, spOps); applyColorOps(p4, 4, spOps)
  assert.deepEqual([p4[0], p4[1], p4[2]], [p3[0], p3[1], p3[2]], 'parité spatial+filtre')

  // Neutralité
  let zs = upsertOp(emptyStack(), { type: 'redeye', params: { zones: [] } })
  zs = upsertOp(zs, { type: 'filter', params: { name: 'bw', intensity: 0 } })
  zs = upsertOp(zs, { type: 'retouch', params: { strokes: [] } })
  assert.equal(zs.ops.length, 0, 'ops vides/neutres supprimées')
  console.log('✅ Filtres créatifs, yeux rouges, tampon (+ parité)')

  // --- 6. stackHash stable ---
  assert.equal(stackHash(stack), stackHash(JSON.parse(JSON.stringify(stack))), 'hash stable')
  assert.notEqual(stackHash(stack), stackHash(emptyStack()), 'hash discriminant')
  console.log('✅ stackHash')

  // --- 7. Clustering de visages ---
  const vecA = Float32Array.from({ length: 64 }, (_, i) => Math.sin(i))
  const vecA2 = vecA.map((v) => v * 1.05) as Float32Array // même direction
  const vecB = Float32Array.from({ length: 64 }, (_, i) => Math.cos(i * 3))
  assert.equal(cosine(vecA, vecA) > 0.999, true, 'cosinus identité')
  assert.equal(cosine(vecA, vecA2) > 0.999, true, 'cosinus invariant à l échelle')
  assert.equal(Math.abs(cosine(vecA, vecB)) < 0.3, true, 'vecteurs distincts peu similaires')

  const persons = [
    { id: 1, centroid: vecA, count: 5 },
    { id: 2, centroid: vecB, count: 3 }
  ]
  const m = bestMatch(vecA2, persons)
  assert.equal(m?.personId, 1, 'assignation au bon cluster')
  const noMatch = bestMatch(
    Float32Array.from({ length: 64 }, (_, i) => ((i * 37) % 13) - 6),
    persons
  )
  assert.equal(noMatch === null || noMatch.similarity < 0.7, true, 'inconnu → pas de faux rattachement fort')

  const merged = mergeCentroid(vecA, 1, vecB)
  assert.equal(Math.abs(merged[0] - (vecA[0] + vecB[0]) / 2) < 1e-6, true, 'moyenne incrémentale n=1')

  const rt = blobToF32(f32ToBlob(vecA))
  assert.equal(rt.length, vecA.length, 'aller-retour BLOB longueur')
  assert.equal(Math.abs(rt[10] - vecA[10]) < 1e-9, true, 'aller-retour BLOB valeurs')
  console.log('✅ Clustering visages (cosinus, assignation, centroïdes, BLOB)')

  console.log('\n🎉 Tous les tests du moteur passent')
}

main().catch((e) => {
  console.error('❌', e.message)
  process.exit(1)
})
