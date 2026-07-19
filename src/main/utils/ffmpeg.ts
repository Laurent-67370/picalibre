/**
 * Résolution du chemin ffmpeg — sans embarquer 77 Mo dans le paquet Linux.
 *
 * Priorité :
 *   1. ffmpeg système (PATH) — le cas nominal sur Linux desktop ;
 *   2. ffmpeg-static embarqué (Windows/macOS, et mode dev) ;
 *   3. binaire déjà téléchargé dans userData/bin ;
 *   4. téléchargement UNIQUE du binaire statique officiel (release GitHub
 *      d'eugeneware/ffmpeg-static, la même source que le paquet npm),
 *      vérifié fonctionnel, mis en cache dans userData/bin.
 *
 * Le premier usage vidéo sur une machine sans ffmpeg déclenche le
 * téléchargement (~77 Mo, une seule fois) ; les suivants sont instantanés.
 */
import { execFileSync, execFile, spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { access, chmod, mkdir, rename } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { app, net } from 'electron'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const FFMPEG_RELEASE = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0'

function assetName(): string | null {
  const map: Record<string, string> = {
    'linux-x64': 'ffmpeg-linux-x64',
    'linux-arm64': 'ffmpeg-linux-arm64',
    'win32-x64': 'ffmpeg-win32-x64.exe',
    'darwin-x64': 'ffmpeg-darwin-x64',
    'darwin-arm64': 'ffmpeg-darwin-arm64'
  }
  return map[`${process.platform}-${process.arch}`] ?? null
}

function loadFfmpegStatic(): string | null {
  try {
    // Chargement paresseux : le module est exclu du paquet Linux.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const p = require('ffmpeg-static') as string | null
    return p ?? null
  } catch {
    return null
  }
}

function findSystemFfmpeg(): string | null {
  try {
    const out =
      process.platform === 'win32'
        ? execFileSync('where', ['ffmpeg'], { encoding: 'utf-8', timeout: 2000 })
        : execFileSync('which', ['ffmpeg'], { encoding: 'utf-8', timeout: 2000 })
    return out.split('\n')[0].trim() || null
  } catch {
    return null
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/** Vérifie qu'un binaire ffmpeg répond réellement (pas un fichier corrompu). */
function works(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(bin, ['-version'], { timeout: 4000 }, (err) => resolve(!err))
  })
}

async function downloadFfmpeg(dest: string): Promise<void> {
  const asset = assetName()
  if (!asset) throw new Error(`plateforme non supportée : ${process.platform}-${process.arch}`)
  const url = `${FFMPEG_RELEASE}/${asset}`
  await mkdir(join(app.getPath('userData'), 'bin'), { recursive: true })
  const tmp = dest + '.part'

  let lastErr: unknown
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`[ffmpeg] téléchargement du binaire (tentative ${attempt}/3) :`, url)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 60_000)
      try {
        const res = await net.fetch(url, { signal: controller.signal })
        if (!res.ok || !res.body) throw new Error(`téléchargement ffmpeg : HTTP ${res.status}`)
        await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp))
      } finally {
        clearTimeout(timer)
      }
      await chmod(tmp, 0o755)
      await rename(tmp, dest)
      console.log('[ffmpeg] installé dans', dest)
      return
    } catch (err) {
      lastErr = err
      console.error(`[ffmpeg] échec tentative ${attempt}/3 :`, (err as Error).message)
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 2000)) // 2s, 4s
    }
  }
  throw new Error(`téléchargement ffmpeg échoué après 3 tentatives : ${(lastErr as Error)?.message}`)
}

/**
 * Un chemin peut « exister » selon fs.access()/fs.stat() tout en étant
 * IMPOSSIBLE À SPAWNER : Electron redirige transparentement les appels
 * fs.* vers .asar.unpacked quand le fichier a été extrait de l'archive,
 * mais child_process.spawn()/execFile() ne bénéficie PAS de cette
 * redirection — le chemin littéral pointe alors À L'INTÉRIEUR de
 * l'archive .asar (un simple fichier pour l'OS, pas un vrai dossier),
 * ce qui échoue avec ENOTDIR au moment précis du spawn, après que
 * toutes les vérifications fs.access() en amont aient réussi. D'où le
 * piège : le bug est invisible tant qu'on ne teste que access()/exists().
 */
function spawnSafe(p: string): string {
  return p.includes(`${sep}app.asar${sep}`) ? p.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`) : p
}

let _resolved: string | null = null
let _resolving: Promise<string> | null = null

export function getFfmpegPath(): Promise<string> {
  if (_resolved) {
    // Ne pas faire confiance aveuglément à un chemin résolu il y a
    // longtemps (mémorisé pour la durée du process) : si le binaire a
    // disparu entre-temps (profil nettoyé, cache vidé manuellement...),
    // mieux vaut relancer toute la résolution qu'échouer avec une erreur
    // cryptique (ENOTDIR/ENOENT) au moment du spawn.
    return exists(_resolved).then((ok) => {
      if (ok) return _resolved as string
      console.warn('[ffmpeg] chemin mémorisé introuvable, nouvelle résolution :', _resolved)
      _resolved = null
      return getFfmpegPath()
    })
  }
  if (_resolving) return _resolving

  _resolving = (async () => {
    // 1. Système
    const system = findSystemFfmpeg()
    if (system && (await works(system))) return (_resolved = spawnSafe(system))

    // 2. Embarqué (Win/mac/dev)
    const bundled = loadFfmpegStatic()
    if (bundled && (await exists(bundled)) && (await works(bundled))) {
      return (_resolved = spawnSafe(bundled))
    }

    // 3. Déjà téléchargé
    const local = join(
      app.getPath('userData'),
      'bin',
      process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
    )
    if ((await exists(local)) && (await works(local))) return (_resolved = spawnSafe(local))

    // 4. Téléchargement unique
    await downloadFfmpeg(local)
    if (await works(local)) return (_resolved = spawnSafe(local))
    throw new Error('ffmpeg téléchargé mais non fonctionnel')
  })()

  _resolving.catch(() => {
    _resolving = null // permettre une nouvelle tentative (réseau revenu, etc.)
  })
  return _resolving
}

// ---------------------------------------------------------------------------
// Helpers ffmpeg mutualisés : spawn + parse stderr.
//
// Extraits de movie.ts où ils étaient définis, et consommés par movie.ts
// et pipeline.ts. Les fonctions `probeDuration` et `probeVideoInfo` étaient
// exportées par movie.ts et importées par pipeline.ts — c'est désormais
// ici qu'elles vivent, movie.ts les réexporte par commodité (compat).
// ---------------------------------------------------------------------------

/**
 * Lance ffmpeg, capture le stderr (tronqué à 40 ko), et résout avec ce
 * stderr (utile quand l'appelant veut parser des infos dedans). Rejette
 * avec un message incluant les 800 derniers caractères en cas de code != 0.
 */
export function runFfmpeg(ffmpegPath: string, args: string[]): Promise<string> {
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

const PROBE_TIMEOUT_MS = 15_000

/** Capture le stderr d'un `ffmpeg -i file` avec timeout (le `-i` seul sort en code 1, normal). */
function probeStderr(ffmpegPath: string, file: string): Promise<string> {
  return new Promise<string>((resolve) => {
    const proc = spawn(ffmpegPath, ['-i', file], { stdio: ['ignore', 'ignore', 'pipe'] })
    let out = ''
    const killTimer = setTimeout(() => {
      proc.kill('SIGKILL')
      resolve(out)
    }, PROBE_TIMEOUT_MS)
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
}

function parseDuration(stderr: string): number | null {
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/)
  if (!m) return null
  return (
    parseInt(m[1], 10) * 3600 +
    parseInt(m[2], 10) * 60 +
    parseInt(m[3], 10) +
    parseInt(m[4], 10) / Math.pow(10, m[4].length)
  )
}

/** Durée d'un média via `ffmpeg -i` (parse "Duration: HH:MM:SS.cc"), sans ffprobe. */
export async function probeDuration(ffmpegPath: string, file: string): Promise<number> {
  const stderr = await probeStderr(ffmpegPath, file)
  const d = parseDuration(stderr)
  if (d == null) throw new Error(`Durée introuvable pour ${file}`)
  return d
}

/**
 * Durée + codec vidéo en un seul appel `ffmpeg -i` (au lieu de deux spawns
 * séparés) — le codec sert à détecter les vidéos HEVC/H.265, que Chromium
 * (build Electron standard) ne décode pas nativement (licence des brevets,
 * contrairement à H.264/VP9/AV1). Renvoie duration=0 si introuvable.
 */
export async function probeVideoInfo(
  ffmpegPath: string,
  file: string
): Promise<{ duration: number; codec: string | null }> {
  const stderr = await probeStderr(ffmpegPath, file)
  const d = parseDuration(stderr)
  const cm = stderr.match(/Video:\s*([a-zA-Z0-9_]+)/)
  return { duration: d ?? 0, codec: cm ? cm[1].toLowerCase() : null }
}
