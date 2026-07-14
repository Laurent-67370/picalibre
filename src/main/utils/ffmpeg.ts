/**
 * Résolution du chemin ffmpeg — système d'abord, fallback sur ffmpeg-static.
 *
 * Sur Linux, ffmpeg est presque toujours installé (apt, pacman, etc.).
 * L'utiliser plutôt que le binaire static de 77 Mo permet d'alléger
 * massivement l'AppImage/deb. Sur Windows/macOS où ffmpeg système
 * n'est pas garanti, on retombe sur ffmpeg-static embarqué.
 */
import { execFileSync } from 'node:child_process'

/**
 * Chargement PARESSEUX et OPTIONNEL de ffmpeg-static : le module est exclu
 * du paquet Linux (économie de 77 Mo) — un import au niveau module ferait
 * planter l'app au démarrage (« Cannot find module 'ffmpeg-static' »).
 */
function loadFfmpegStatic(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const p = require('ffmpeg-static') as string | null
    return p ?? null
  } catch {
    return null
  }
}

/** Cache du résultat : la résolution ne se fait qu'une fois au démarrage. */
let _resolved: string | null = null

/**
 * Tente de trouver ffmpeg sur le PATH système.
 * @returns chemin absolu ou null si introuvable
 */
function findSystemFfmpeg(): string | null {
  try {
    const cmd = process.platform === 'win32'
      ? execFileSync('where', ['ffmpeg'], { encoding: 'utf-8', timeout: 2000 }).trim()
      : execFileSync('which', ['ffmpeg'], { encoding: 'utf-8', timeout: 2000 }).trim()
    // `which` renvoie la première ligne = le bon chemin
    return cmd.split('\n')[0].trim() || null
  } catch {
    return null // ffmpeg non trouvé sur le système
  }
}

/**
 * Retourne le chemin ffmpeg à utiliser.
 * Priorité : système > ffmpeg-static > 'ffmpeg' (dernier recours, PATH direct).
 */
export function getFfmpegPath(): string {
  if (_resolved) return _resolved

  // 1. Essayer ffmpeg système (rapide et léger)
  const system = findSystemFfmpeg()
  if (system) {
    _resolved = system
    return _resolved
  }

  // 2. Fallback : binaire ffmpeg-static embarqué (Windows/macOS principalement)
  const bundled = loadFfmpegStatic()
  if (bundled) {
    _resolved = bundled
    return _resolved
  }

  // 3. Dernier recours : 'ffmpeg' (espère qu'il est dans le PATH)
  _resolved = 'ffmpeg'
  return _resolved
}
