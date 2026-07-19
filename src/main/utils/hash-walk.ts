/**
 * Helpers partagés de hash (xxh3) et parcours récursif de fichiers média.
 *
 * Extraits de importer.ts et relocate.ts où ils étaient dupliqués à l'identique
 * (~30 lignes × 2). Module pur (pas de dépendance Electron) — testable.
 */
import { opendir, open } from 'node:fs/promises'
import { join, extname } from 'node:path'
import xxhash from 'xxhash-wasm'

export const MEDIA_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.heif', '.avif',
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.3gp', '.mts'
])

const HASH_CHUNK = 4 * 1024 * 1024

let hasher: Awaited<ReturnType<typeof xxhash>> | null = null

/**
 * Hash xxh3 d'un fichier lu par blocs de 4 Mo.
 * @param filepath  Chemin absolu du fichier à hasher.
 * @param size      Taille connue du fichier (évite un stat supplémentaire).
 * @returns         Hash hex 16 caractères.
 */
export async function hashFile(filepath: string, size: number): Promise<string> {
  if (!hasher) hasher = await xxhash()
  const h = hasher.create64()
  const fh = await open(filepath, 'r')
  try {
    const buf = Buffer.allocUnsafe(Math.min(HASH_CHUNK, size || 1))
    let pos = 0
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos)
      if (bytesRead <= 0) break
      h.update(buf.subarray(0, bytesRead))
      pos += bytesRead
    }
  } finally {
    await fh.close()
  }
  return h.digest().toString(16).padStart(16, '0')
}

/**
 * Parcours récursif d'un dossier — yield le chemin de chaque fichier média
 * trouvé (par extension). Les dossiers cachés (commençant par '.') sont
 * ignorés. Un dossier inaccessible est ignoré silencieusement.
 */
export async function* walk(dir: string): AsyncGenerator<string> {
  let handle
  try {
    handle = await opendir(dir)
  } catch {
    return
  }
  for await (const entry of handle) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.')) yield* walk(full)
    } else if (entry.isFile() && MEDIA_EXT.has(extname(entry.name).toLowerCase())) {
      yield full
    }
  }
}