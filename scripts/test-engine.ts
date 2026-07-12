/**
 * Test du moteur d'édition : DSL, math couleur, pipeline export sharp.
 * Usage : npx tsx scripts/test-engine.ts
 */
import sharp from 'sharp'
import assert from 'node:assert'
import {
  emptyStack,
  upsertOp,
  applyColorOps,
  cropRectPx,
  stackHash,
  EditStack
} from '../src/shared/edit-engine'
import { renderEdited } from '../src/main/services/render-sharp'

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

  // --- 6. stackHash stable ---
  assert.equal(stackHash(stack), stackHash(JSON.parse(JSON.stringify(stack))), 'hash stable')
  assert.notEqual(stackHash(stack), stackHash(emptyStack()), 'hash discriminant')
  console.log('✅ stackHash')

  console.log('\n🎉 Tous les tests du moteur passent')
}

main().catch((e) => {
  console.error('❌', e.message)
  process.exit(1)
})
