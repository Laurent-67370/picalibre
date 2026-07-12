/**
 * Movie maker — module pur (chemins ffmpeg passés en paramètre, testable).
 * Photos (éditions appliquées) → frames JPEG → ffmpeg concat → MP4 H.264
 * 1280x720 (letterbox), piste audio optionnelle coupée à la durée (-shortest).
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EditStack } from '../../shared/edit-engine'
import { renderEdited } from './render-sharp'

export interface MovieItem {
  filepath: string
  stack: EditStack
}

export interface MovieOptions {
  ffmpegPath: string
  durationSec: number // par photo
  audioPath: string | null
  outFile: string
  width?: number
  height?: number
  onProgress?: (done: number, total: number) => void
}

function runFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (d) => {
      stderr += d.toString()
      if (stderr.length > 20000) stderr = stderr.slice(-10000)
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg code ${code}: ${stderr.slice(-800)}`))
    })
  })
}

export async function makeMovie(items: MovieItem[], opts: MovieOptions): Promise<void> {
  const { ffmpegPath, durationSec, audioPath, outFile, width = 1280, height = 720 } = opts
  const work = await mkdtemp(join(tmpdir(), 'picalibre-movie-'))
  try {
    // 1. Frames : photos éditées, letterbox sur fond noir
    const frames: string[] = []
    for (let i = 0; i < items.length; i++) {
      const buf = await renderEdited(items[i].filepath, items[i].stack, {
        format: 'jpeg',
        quality: 92,
        maxSize: Math.max(width, height)
      })
      const frame = join(work, `frame_${String(i).padStart(4, '0')}.jpg`)
      await writeFile(frame, buf)
      frames.push(frame)
      opts.onProgress?.(i + 1, items.length + 1)
    }

    // 2. Fichier concat : durée fixe par image, dernière répétée (exigence ffmpeg)
    const esc = (p: string): string => p.replace(/'/g, "'\\''")
    const lines: string[] = []
    for (const f of frames) {
      lines.push(`file '${esc(f)}'`)
      lines.push(`duration ${durationSec}`)
    }
    lines.push(`file '${esc(frames[frames.length - 1])}'`)
    const listFile = join(work, 'list.txt')
    await writeFile(listFile, lines.join('\n') + '\n')

    // 3. Encodage
    const vf = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`
    const args = ['-y', '-f', 'concat', '-safe', '0', '-i', listFile]
    if (audioPath) args.push('-i', audioPath)
    args.push('-vf', vf, '-r', '30', '-c:v', 'libx264', '-preset', 'medium')
    if (audioPath) args.push('-c:a', 'aac', '-b:a', '192k', '-shortest')
    // Borne exacte : la frame finale répétée (exigence concat) hériterait
    // sinon d'une durée supplémentaire
    args.push('-t', String(items.length * durationSec))
    args.push(outFile)

    await runFfmpeg(ffmpegPath, args)
    opts.onProgress?.(items.length + 1, items.length + 1)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
