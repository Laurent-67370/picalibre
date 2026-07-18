/**
 * Movie maker v2 — module pur (chemins ffmpeg passés en paramètre, testable).
 *
 * Nouveautés Phase 4+ :
 *  - VIDÉOS dans les movies : chaque élément (photo OU vidéo) devient un
 *    SEGMENT normalisé aux mêmes paramètres (H.264 yuv420p, 30 fps, WxH
 *    letterbox, AAC 48 kHz stéréo — silence anullsrc pour les photos) ;
 *    l'assemblage concat se fait ensuite en COPIE de flux (rapide, sans
 *    double ré-encodage).
 *  - TRANSITIONS : fondu au noir 0,5 s en entrée/sortie de chaque segment
 *    (vidéo + audio), cuit dans le segment → l'assemblage reste une copie.
 *  - MULTI-PISTES AUDIO : une playlist de N fichiers est concaténée en une
 *    bande-son unique qui REMPLACE l'audio des segments ; bornée à la durée
 *    totale du film (jamais l'inverse). Sans bande-son, les vidéos gardent
 *    leur propre audio et les photos restent silencieuses.
 *
 * La durée des vidéos est sondée sans dépendance supplémentaire en parsant
 * la sortie `Duration:` de `ffmpeg -i`.
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
  isVideo?: boolean
}

export type MovieTransition = 'none' | 'fade'

export interface MovieOptions {
  ffmpegPath: string
  durationSec: number // par photo (les vidéos gardent leur durée)
  audioPaths?: string[] // playlist bande-son (remplace l'audio des segments)
  /** @deprecated compat v1 — utiliser audioPaths */
  audioPath?: string | null
  transition?: MovieTransition
  outFile: string
  width?: number
  height?: number
  preset?: string // libx264 : medium par défaut, ultrafast pour les tests
  onProgress?: (done: number, total: number) => void
}

const FADE_D = 0.5

function runFfmpeg(ffmpegPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (d) => {
      stderr += d.toString()
      if (stderr.length > 40000) stderr = stderr.slice(-20000)
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve(stderr)
      else reject(new Error(`ffmpeg code ${code}: ${stderr.slice(-800)}`))
    })
  })
}

/** Durée d'un média via `ffmpeg -i` (parse "Duration: HH:MM:SS.cc"), sans ffprobe. */
export async function probeDuration(ffmpegPath: string, file: string): Promise<number> {
  const stderr = await new Promise<string>((resolve) => {
    const proc = spawn(ffmpegPath, ['-i', file], { stdio: ['ignore', 'ignore', 'pipe'] })
    let out = ''
    const killTimer = setTimeout(() => {
      proc.kill('SIGKILL')
      resolve(out)
    }, 15_000)
    proc.stderr.on('data', (d) => (out += d.toString()))
    proc.on('close', () => {
      clearTimeout(killTimer)
      resolve(out) // -i seul sort en code 1, normal
    })
    proc.on('error', () => {
      clearTimeout(killTimer)
      resolve(out)
    })
  })
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/)
  if (!m) throw new Error(`Durée introuvable pour ${file}`)
  return (
    parseInt(m[1], 10) * 3600 +
    parseInt(m[2], 10) * 60 +
    parseInt(m[3], 10) +
    parseInt(m[4], 10) / Math.pow(10, m[4].length)
  )
}

/**
 * Durée + codec vidéo en un seul appel `ffmpeg -i` (au lieu de deux
 * spawns séparés) — le codec sert à détecter les vidéos HEVC/H.265,
 * que Chromium (build Electron standard) ne décode pas nativement
 * (licence des brevets, contrairement à H.264/VP9/AV1).
 */
export async function probeVideoInfo(
  ffmpegPath: string,
  file: string
): Promise<{ duration: number; codec: string | null }> {
  const stderr = await new Promise<string>((resolve) => {
    const proc = spawn(ffmpegPath, ['-i', file], { stdio: ['ignore', 'ignore', 'pipe'] })
    let out = ''
    const killTimer = setTimeout(() => {
      proc.kill('SIGKILL')
      resolve(out)
    }, 15_000)
    proc.stderr.on('data', (d) => (out += d.toString()))
    proc.on('close', () => {
      clearTimeout(killTimer)
      resolve(out)
    })
    proc.on('error', () => {
      clearTimeout(killTimer)
      resolve(out)
    })
  })
  const dm = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/)
  const duration = dm
    ? parseInt(dm[1], 10) * 3600 +
      parseInt(dm[2], 10) * 60 +
      parseInt(dm[3], 10) +
      parseInt(dm[4], 10) / Math.pow(10, dm[4].length)
    : 0
  const cm = stderr.match(/Video:\s*([a-zA-Z0-9_]+)/)
  return { duration, codec: cm ? cm[1].toLowerCase() : null }
}

/** Filtres de fondu vidéo+audio cuits dans le segment. */
function fadeFilters(duration: number, transition: MovieTransition): { v: string; a: string } {
  if (transition !== 'fade' || duration <= FADE_D * 2) return { v: '', a: '' }
  const outSt = (duration - FADE_D).toFixed(3)
  return {
    v: `,fade=t=in:st=0:d=${FADE_D},fade=t=out:st=${outSt}:d=${FADE_D}`,
    a: `afade=t=in:st=0:d=${FADE_D},afade=t=out:st=${outSt}:d=${FADE_D}`
  }
}

export interface MovieResult {
  totalDuration: number
  segments: number
}

export async function makeMovie(items: MovieItem[], opts: MovieOptions): Promise<MovieResult> {
  const {
    ffmpegPath,
    durationSec,
    outFile,
    width = 1280,
    height = 720,
    transition = 'none',
    preset = 'medium'
  } = opts
  const audioPaths = opts.audioPaths ?? (opts.audioPath ? [opts.audioPath] : [])
  const work = await mkdtemp(join(tmpdir(), 'picalibre-movie-'))
  const totalSteps = items.length + 1
  try {
    const scalePad = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p`
    const segArgsCommon = [
      '-c:v', 'libx264', '-preset', preset, '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'
    ]

    // --- 1. Segments normalisés (mêmes codecs/params → concat en copie) ---
    const segments: string[] = []
    const segDurations: number[] = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const seg = join(work, `seg_${String(i).padStart(4, '0')}.mp4`)
      if (item.isVideo) {
        const dur = await probeDuration(ffmpegPath, item.filepath)
        const f = fadeFilters(dur, transition)
        await runFfmpeg(ffmpegPath, [
          '-y', '-i', item.filepath,
          '-vf', scalePad + f.v,
          '-af', (f.a ? f.a + ',' : '') + 'aresample=48000',
          ...segArgsCommon,
          seg
        ])
        segDurations.push(dur)
      } else {
        // Photo éditée → image fixe de durationSec + silence
        const buf = await renderEdited(item.filepath, item.stack, {
          format: 'jpeg',
          quality: 92,
          maxSize: Math.max(width, height)
        })
        const frame = join(work, `frame_${i}.jpg`)
        await writeFile(frame, buf)
        const f = fadeFilters(durationSec, transition)
        await runFfmpeg(ffmpegPath, [
          '-y',
          '-loop', '1', '-t', String(durationSec), '-i', frame,
          '-f', 'lavfi', '-t', String(durationSec), '-i', 'anullsrc=r=48000:cl=stereo',
          '-vf', scalePad + f.v,
          ...(f.a ? ['-af', f.a] : []),
          '-shortest',
          ...segArgsCommon,
          seg
        ])
        segDurations.push(durationSec)
      }
      segments.push(seg)
      opts.onProgress?.(i + 1, totalSteps)
    }
    const totalDuration = segDurations.reduce((a, b) => a + b, 0)

    // --- 2. Assemblage : concat en copie de flux ---
    const esc = (p: string): string => p.replace(/'/g, "'\\''")
    const listFile = join(work, 'list.txt')
    await writeFile(listFile, segments.map((s) => `file '${esc(s)}'`).join('\n') + '\n')

    if (audioPaths.length === 0) {
      // Les segments gardent leur audio (vidéos) / silence (photos)
      await runFfmpeg(ffmpegPath, [
        '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
        '-c', 'copy', '-movflags', '+faststart', outFile
      ])
    } else {
      // Bande-son : playlist concaténée, remplace l'audio, bornée au film
      const inputs: string[] = ['-f', 'concat', '-safe', '0', '-i', listFile]
      for (const a of audioPaths) inputs.push('-i', a)
      const chain =
        audioPaths.map((_, i) => `[${i + 1}:a]`).join('') +
        `concat=n=${audioPaths.length}:v=0:a=1[aud]`
      await runFfmpeg(ffmpegPath, [
        '-y', ...inputs,
        '-filter_complex', chain,
        '-map', '0:v', '-map', '[aud]',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
        '-t', totalDuration.toFixed(3),
        '-movflags', '+faststart',
        outFile
      ])
    }
    opts.onProgress?.(totalSteps, totalSteps)
    return { totalDuration, segments: segments.length }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}
