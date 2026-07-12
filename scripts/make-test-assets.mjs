/** Génère le jeu de test du pipeline (photos + vidéo) — multiplateforme. */
import sharp from 'sharp'
import ffmpegPath from 'ffmpeg-static'
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2]
if (!root) { console.error('usage: node make-test-assets.mjs <dossier>'); process.exit(1) }
mkdirSync(join(root, 'vacances'), { recursive: true })
mkdirSync(join(root, 'famille'), { recursive: true })

const colors = [[200,80,60],[60,160,220],[90,200,120]]
await Promise.all(colors.map(([r,g,b], i) =>
  sharp({ create: { width: 1400+i*100, height: 1000, channels: 3, background: { r, g, b } } })
    .jpeg({ quality: 90 })
    .toFile(join(root, i < 2 ? 'vacances' : 'famille', `photo_${i+1}.jpg`))
))
const clip = join(root, 'vacances', 'clip.mp4')
const res = spawnSync(ffmpegPath, ['-y',
  '-f','lavfi','-i','testsrc=size=640x480:rate=30:duration=3',
  '-f','lavfi','-i','sine=frequency=440:duration=3',
  '-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac', clip
], { encoding: 'utf8' })
if (res.status !== 0) { console.error(res.stderr?.slice(-300)); process.exit(1) }
console.log('assets OK →', root)
