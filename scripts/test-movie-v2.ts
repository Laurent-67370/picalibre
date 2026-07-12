/**
 * Tests movie maker v2 : vidéos mixées, fondus, multi-pistes audio.
 */
import assert from 'node:assert'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import sharp from 'sharp'
import ffmpegPath from 'ffmpeg-static'
import { makeMovie, probeDuration } from '../src/main/services/movie'
import { emptyStack, upsertOp } from '../src/shared/edit-engine'

const FF = ffmpegPath as unknown as string

function streams(file: string): { hasVideo: boolean; hasAudio: boolean } {
  const r = spawnSync(FF, ['-i', file], { encoding: 'utf8' })
  const s = r.stderr
  return { hasVideo: /Stream .*: Video/.test(s), hasAudio: /Stream .*: Audio/.test(s) }
}

async function main() {
  // --- Assets de test ---
  await sharp({ create: { width: 1200, height: 900, channels: 3, background: { r: 200, g: 60, b: 40 } } })
    .jpeg().toFile(join(tmpdir(), 'mv-a.jpg'))
  await sharp({ create: { width: 900, height: 1200, channels: 3, background: { r: 40, g: 120, b: 210 } } })
    .jpeg().toFile(join(tmpdir(), 'mv-b.jpg'))
  // Vidéo 3 s AVEC audio (mire + sinus)
  spawnSync(FF, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=30:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(tmpdir(), 'mv-clip.mp4')])
  // Deux pistes audio de 4 s et 3 s
  spawnSync(FF, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=4', '-c:a', 'aac', join(tmpdir(), 'mv-t1.m4a')])
  spawnSync(FF, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=600:duration=3', '-c:a', 'aac', join(tmpdir(), 'mv-t2.m4a')])

  assert.ok(Math.abs((await probeDuration(FF, join(tmpdir(), 'mv-clip.mp4'))) - 3) < 0.15, 'probeDuration')
  console.log('✅ probeDuration (parse ffmpeg -i)')

  const stackA = upsertOp(emptyStack(), { type: 'temperature', params: { value: 0.6 } })
  const items = [
    { filepath: join(tmpdir(), 'mv-a.jpg'), stack: stackA },
    { filepath: join(tmpdir(), 'mv-clip.mp4'), stack: emptyStack(), isVideo: true },
    { filepath: join(tmpdir(), 'mv-b.jpg'), stack: emptyStack() }
  ]

  // --- 1. Photos + vidéo, fondu, SANS bande-son (audio du clip conservé) ---
  const r1 = await makeMovie(items, {
    ffmpegPath: FF, preset: 'ultrafast', width: 480, height: 270, durationSec: 2, transition: 'fade', outFile: join(tmpdir(), 'mv-out1.mp4')
  })
  assert.equal(r1.segments, 3)
  assert.ok(Math.abs(r1.totalDuration - 7) < 0.2, `durée attendue ~7s, calculée ${r1.totalDuration}`)
  const d1 = await probeDuration(FF, join(tmpdir(), 'mv-out1.mp4'))
  assert.ok(Math.abs(d1 - 7) < 0.3, `durée réelle ~7s, mesurée ${d1}`)
  const s1 = streams(join(tmpdir(), 'mv-out1.mp4'))
  assert.ok(s1.hasVideo && s1.hasAudio, 'flux vidéo + audio présents')
  console.log(`✅ Mix photos+vidéo, fondus : ${d1.toFixed(2)}s, audio du clip conservé`)

  // --- 2. Bande-son 2 pistes (4s+3s=7s), remplace tout, bornée au film ---
  const r2 = await makeMovie(items, {
    ffmpegPath: FF, preset: 'ultrafast', width: 480, height: 270, durationSec: 2, transition: 'fade',
    audioPaths: [join(tmpdir(), 'mv-t1.m4a'), join(tmpdir(), 'mv-t2.m4a')], outFile: join(tmpdir(), 'mv-out2.mp4')
  })
  const d2 = await probeDuration(FF, join(tmpdir(), 'mv-out2.mp4'))
  assert.ok(Math.abs(d2 - r2.totalDuration) < 0.3, `bornée au film : ${d2} vs ${r2.totalDuration}`)
  assert.ok(streams(join(tmpdir(), 'mv-out2.mp4')).hasAudio, 'bande-son présente')
  console.log(`✅ Multi-pistes audio (2 fichiers concaténés) : ${d2.toFixed(2)}s`)

  // --- 3. Régression v1 : photos seules, sans transition ---
  const r3 = await makeMovie(
    [items[0], items[2]],
    { ffmpegPath: FF, preset: 'ultrafast', width: 480, height: 270, durationSec: 2, transition: 'none', outFile: join(tmpdir(), 'mv-out3.mp4') }
  )
  const d3 = await probeDuration(FF, join(tmpdir(), 'mv-out3.mp4'))
  assert.ok(Math.abs(d3 - 4) < 0.2, `photos seules ~4s, mesurée ${d3}`)
  assert.equal(r3.segments, 2)
  console.log(`✅ Régression photos seules : ${d3.toFixed(2)}s`)

  // --- 4. Compat API v1 (audioPath simple) ---
  await makeMovie([items[0]], {
    ffmpegPath: FF, preset: 'ultrafast', width: 480, height: 270, durationSec: 2, audioPath: join(tmpdir(), 'mv-t2.m4a'), outFile: join(tmpdir(), 'mv-out4.mp4')
  })
  assert.ok(streams(join(tmpdir(), 'mv-out4.mp4')).hasAudio, 'compat audioPath v1')
  console.log('✅ Compat API v1 (audioPath)')

  console.log('\n🎉 Movie maker v2 : 5/5')
}

main().catch((e) => { console.error('❌', e.message); process.exit(1) })
