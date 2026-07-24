/**
 * Profil de performance machine — partagé main / utilityProcess (Node).
 *
 * Objectif : sur une « petite configuration » (≤ 8 Go de RAM ou ≤ 4 cœurs),
 * les tâches de fond (miniatures, hachage, transcodage, visages) ne doivent
 * jamais saturer la machine au point de rendre l'interface poussive. Toutes
 * les concurrences dérivées de cpus()−1 et les caches dimensionnés « large »
 * sont recalibrés ici, en un seul endroit, plutôt que d'éparpiller des
 * heuristiques par fichier.
 *
 * Sur une machine confortable, les valeurs historiques sont conservées à
 * l'identique — le profil ne change RIEN hors petite configuration.
 *
 * Forçage pour test ou pour l'utilisateur :
 *   PICALIBRE_LOW_SPEC=1 → profil petite configuration même sur grosse machine
 *   PICALIBRE_LOW_SPEC=0 → profil normal même sur petite machine
 */
import { cpus, totalmem } from 'node:os'

/** Seuil RAM : 9 Gio pour englober les machines « 8 Go » (qui rapportent
 *  souvent ~7,7 Gio utiles) sans capturer les 16 Go. */
const LOW_SPEC_RAM_BYTES = 9 * 1024 * 1024 * 1024
/** Seuil CPU : ≤ 4 cœurs logiques = petit processeur. */
const LOW_SPEC_CPU_COUNT = 4

export function cpuCount(): number {
  return cpus().length || 2
}

export function isLowSpec(): boolean {
  const forced = process.env.PICALIBRE_LOW_SPEC
  if (forced === '1') return true
  if (forced === '0') return false
  return totalmem() <= LOW_SPEC_RAM_BYTES || cpuCount() <= LOW_SPEC_CPU_COUNT
}

/** Workers de scan (parcours + hachage xxh3). Le hachage est surtout I/O :
 *  au-delà de 2 workers sur petite machine, on paie surtout la RAM des
 *  Map knownFiles dupliquées et la contention disque. */
export function scanWorkerLimit(): number {
  const normal = Math.max(1, cpuCount() - 1)
  return isLowSpec() ? Math.min(2, normal) : normal
}

/** Couloirs sharp simultanés dans le thumb-worker. */
export function thumbLaneLimit(): number {
  return isLowSpec() ? Math.max(1, Math.min(2, cpuCount() - 1)) : Math.max(2, cpuCount() - 1)
}

/** Threads libvips PAR opération sharp (0 = défaut sharp : nb de cœurs).
 *  Sans plafond, N couloirs × N threads vips sursouscrit le CPU — sur un
 *  4 cœurs : 3 couloirs × 4 threads = 12 threads de calcul pour 4 cœurs. */
export function sharpVipsConcurrency(): number {
  return isLowSpec() ? 2 : 0
}

/** Cache mémoire interne de libvips en Mo (défaut sharp : 50 Mo). */
export function sharpCacheMb(): number {
  return isLowSpec() ? 24 : 50
}

/** Extractions de frames vidéo (ffmpeg) simultanées. */
export function videoThumbConcurrency(): number {
  const normal = Math.max(2, Math.min(4, cpuCount() - 1))
  return isLowSpec() ? Math.min(2, normal) : normal
}

/** Threads accordés à ffmpeg pour le transcodage proxy H.264.
 *  0 = laisser ffmpeg décider (tous les cœurs). Sur petite machine on
 *  garde un cœur libre pour l'interface. */
export function ffmpegTranscodeThreads(): number {
  return isLowSpec() ? Math.max(1, cpuCount() - 1) : 0
}

/** Préréglage x264 du transcodage proxy : « veryfast » divise ~par 2 le
 *  CPU consommé contre un fichier proxy un peu plus gros (cache local). */
export function ffmpegTranscodePreset(): string {
  return isLowSpec() ? 'veryfast' : 'fast'
}

/** Taille des lots envoyés à la fenêtre cachée de détection de visages. */
export function faceBatchSize(): number {
  return isLowSpec() ? 4 : 8
}

/** Pause (ms) entre deux lots de détection de visages — laisse respirer
 *  l'interface pendant cette tâche de fond très gourmande (Human/WebGL). */
export function faceBatchPauseMs(): number {
  return isLowSpec() ? 250 : 0
}

/** cache_size SQLite (pages) — négatif = Kio. */
export function sqliteCacheKib(): number {
  return isLowSpec() ? 16384 : 65536 // 16 Mo vs 64 Mo
}

/** mmap_size SQLite en octets. */
export function sqliteMmapBytes(): number {
  return isLowSpec() ? 134217728 : 268435456 // 128 Mo vs 256 Mo
}
