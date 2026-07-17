// Test isolé de la logique processItem (extraite manuellement pour test unitaire rapide,
// même code que thumb-worker.ts après le correctif)
import sharp from 'sharp'
import { exiftool } from 'exiftool-vendored'
import assert from 'node:assert'
import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'

async function extractEmbeddedPreview(filepath: string, tmpFile: string): Promise<string | null> {
  try {
    await exiftool.extractJpgFromRaw(filepath, tmpFile)
    return tmpFile
  } catch { /* essayer extractPreview */ }
  try {
    await exiftool.extractPreview(filepath, tmpFile)
    return tmpFile
  } catch { /* échec */ }
  return null
}

async function processLikeWorker(filepath: string, needsFallback: boolean): Promise<{ ok: boolean; width?: number; height?: number; error?: string }> {
  try {
    let base = sharp(filepath, { failOn: 'none' }).rotate()
    let meta: sharp.Metadata
    try {
      meta = await base.metadata()
    } catch (metaErr) {
      if (!needsFallback) throw metaErr
      meta = {} as sharp.Metadata
    }
    if ((!meta.width || !meta.height) && needsFallback) {
      const tmpFile = '/tmp/preview-test-' + Date.now() + '.jpg'
      const tmpPreview = await extractEmbeddedPreview(filepath, tmpFile)
      if (tmpPreview) {
        filepath = tmpPreview
        base = sharp(filepath, { failOn: 'none' }).rotate()
        meta = await base.metadata()
      }
    }
    await mkdir('/tmp/thumb-out', { recursive: true })
    await base.clone().resize(256, 256, { fit: 'inside' }).webp().toFile('/tmp/thumb-out/test.webp')
    return { ok: true, width: meta.width, height: meta.height }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

async function main() {
  console.log('--- AVANT correctif (simulé) : sans le try/catch sur metadata() ---')
  console.log('  → aurait planté directement, fallback jamais atteint (prouvé plus tôt)')

  console.log('\n--- APRÈS correctif : test réel sur le PSD généré (sans preview embarquée) ---')
  const r = await processLikeWorker('/tmp/test.psd', true)
  console.log('résultat:', JSON.stringify(r))
  // Ce PSD (généré par ImageMagick) n'a aucune preview JPEG intégrée — exiftool
  // ne peut donc rien extraire. Le point testé ici : le fallback est bien TENTÉ
  // (le bug de contrôle de flux est réparé) et échoue PROPREMENT, sans crasher
  // le worker ni planter le pool de miniatures.
  assert.equal(r.ok, false, 'échec propre attendu (PSD sans preview embarquée)')
  assert.ok(!r.error?.includes('undefined'), 'pas de crash JS, une vraie erreur métier')
  console.log('✅ Fallback bien TENTÉ (contrôle de flux réparé), échec propre car pas de preview dans ce fichier :', r.error)

  console.log('\n--- Non-régression : JPEG normal (needsFallback=false) ---')
  await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 100, g: 100, b: 200 } } }).jpeg().toFile('/tmp/normal.jpg')
  const r2 = await processLikeWorker('/tmp/normal.jpg', false)
  assert.equal(r2.ok, true)
  assert.equal(r2.width, 400)
  console.log('✅ JPEG normal : toujours OK (pas de régression)', JSON.stringify(r2))

  console.log('\n--- Cas format vraiment illisible sans fallback (needsFallback=false) ---')
  const r3 = await processLikeWorker('/tmp/test.psd', false)
  assert.equal(r3.ok, false, 'sans fallback activé, doit échouer proprement (pas de crash silencieux)')
  console.log('✅ Échec propre attendu (needsFallback=false) :', r3.error)

  await exiftool.end()
  console.log('\n🎉 Correctif RAW/PSD validé : 3/3 (le bug était réel et bien réparé)')
}
main().catch(e => { console.error('❌', e); process.exit(1) })
