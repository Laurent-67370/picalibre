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
import { execFileSync, execFile } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { access, chmod, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
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
  console.log('[ffmpeg] téléchargement unique du binaire :', url)
  const res = await net.fetch(url)
  if (!res.ok || !res.body) throw new Error(`téléchargement ffmpeg : HTTP ${res.status}`)
  await mkdir(join(app.getPath('userData'), 'bin'), { recursive: true })
  const tmp = dest + '.part'
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp))
  await chmod(tmp, 0o755)
  await rename(tmp, dest)
  console.log('[ffmpeg] installé dans', dest)
}

let _resolved: string | null = null
let _resolving: Promise<string> | null = null

export function getFfmpegPath(): Promise<string> {
  if (_resolved) return Promise.resolve(_resolved)
  if (_resolving) return _resolving

  _resolving = (async () => {
    // 1. Système
    const system = findSystemFfmpeg()
    if (system && (await works(system))) return (_resolved = system)

    // 2. Embarqué (Win/mac/dev)
    const bundled = loadFfmpegStatic()
    if (bundled && (await exists(bundled)) && (await works(bundled))) {
      return (_resolved = bundled)
    }

    // 3. Déjà téléchargé
    const local = join(
      app.getPath('userData'),
      'bin',
      process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
    )
    if ((await exists(local)) && (await works(local))) return (_resolved = local)

    // 4. Téléchargement unique
    await downloadFfmpeg(local)
    if (await works(local)) return (_resolved = local)
    throw new Error('ffmpeg téléchargé mais non fonctionnel')
  })()

  _resolving.catch(() => {
    _resolving = null // permettre une nouvelle tentative (réseau revenu, etc.)
  })
  return _resolving
}
