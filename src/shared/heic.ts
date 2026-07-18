/**
 * HEIC/HEIF (format par défaut des photos iPhone) : la distribution npm
 * standard de sharp/libvips ne le décode PAS — vérifié directement via
 * `sharp.format.heif` : `fileSuffix` ne liste que `.avif`, pas `.heic`.
 * Cause : libheif+HEVC est absent des binaires précompilés (licence des
 * brevets HEVC — contrairement à AVIF/AV1, libre de droits).
 *
 * heic-convert (libheif-js, WASM pur, zéro dépendance système) décode le
 * fichier en entier — pleine résolution, identique sur les 3 OS sans
 * compilation native. Contrairement au fallback RAW/PSD existant (preview
 * embarquée, potentiellement basse résolution), c'est un vrai décodage
 * complet : le JPEG résultant est réinjecté tel quel dans sharp, aucun
 * changement en aval (thumbnails, édition, export).
 *
 * Module pur (pas d'import electron) → utilisable depuis le process main,
 * le utilityProcess du worker de miniatures, et le moteur d'export.
 */
import convertHeic from 'heic-convert'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

export const HEIC_EXT = new Set(['.heic', '.heif'])

export function isHeic(filepath: string): boolean {
  return HEIC_EXT.has(extname(filepath).toLowerCase())
}

/**
 * Retourne le chemin d'origine si ce n'est pas un HEIC, sinon un Buffer
 * JPEG décodé (sharp() accepte indifféremment un chemin ou un Buffer).
 * En cas d'échec de conversion, retourne le chemin d'origine tel quel :
 * sharp échouera alors avec un message d'erreur clair (fichier HEIC
 * corrompu ou variante non supportée) plutôt que de rester silencieux.
 */
export async function resolveHeicInput(filepath: string): Promise<string | Buffer> {
  if (!isHeic(filepath)) return filepath
  try {
    const input = await readFile(filepath)
    const output = await convertHeic({ buffer: input, format: 'JPEG', quality: 0.95 })
    return Buffer.from(output)
  } catch (err) {
    console.error('[heic] échec de conversion :', filepath, (err as Error).message)
    return filepath
  }
}
