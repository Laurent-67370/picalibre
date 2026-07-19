/**
 * ScannerService — orchestre un POOL de ScanWorkers (utilityProcess) depuis le main.
 *
 * Parallélisation multi-cœur :
 *  - Si plusieurs racines → un worker par racine (ou réparties sur max N=cpus−1 workers).
 *  - Si une seule racine → partition par sous-dossiers de premier niveau :
 *      • Un worker « shallow » scanne uniquement les fichiers à la racine.
 *      • Les autres workers scannent chacun un sous-dossier (récursif).
 *  - Le main agrège la progression de tous les workers.
 *  - Le pipeline post-scan n'est lancé qu'une fois tous les workers terminés.
 *
 * Protocole IPC inchangé : chaque worker envoie 'batch', 'progress', 'done', 'error'
 * exactement comme avant. Les transactions SQLite étant synchrones, les batches
 * parallèles ne créent pas de conflit.
 */
import { utilityProcess, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { opendir } from 'node:fs/promises'
import { cpus } from 'node:os'
import { getDb, getKnownFilesForRoots, upsertScannedBatch } from '../db'
import { runPostScanPipeline } from './pipeline'
import { createProgressThrottle, type ProgressSender } from './progress-throttle'

/** Nombre maximum de workers en parallèle (cpus − 1, au moins 1). */
const MAX_WORKERS = Math.max(1, (cpus().length || 2) - 1)

/** Partitions de travail envoyées aux workers. */
interface WorkerPartition {
  roots: string[]
  /** true = ne scanner que les fichiers directement dans roots[] (pas de récursion).
   *  Utilisé pour le worker qui gère les fichiers de premier niveau d'une racine unique. */
  shallow: boolean
}

/** Progression agrégée de tous les workers. */
interface WorkerProgress {
  filesFound: number
  filesProcessed: number
  currentPath: string | null
}

/**
 * Partitionne une liste de racines en au plus MAX_WORKERS groupes.
 * Si une seule racine : la découpe par sous-dossiers de premier niveau.
 * Retourne un tableau de partitions à assigner chacune à un worker.
 */
async function partitionRoots(roots: string[]): Promise<WorkerPartition[]> {
  // Cas 1 : plusieurs racines → répartir les racines sur les workers
  if (roots.length > 1) {
    const partitions: WorkerPartition[] = []
    for (let i = 0; i < roots.length; i++) {
      const idx = i % MAX_WORKERS
      if (!partitions[idx]) partitions[idx] = { roots: [], shallow: false }
      partitions[idx].roots.push(roots[i])
    }
    return partitions
  }

  // Cas 2 : une seule racine → partitionner par sous-dossiers de premier niveau
  const root = roots[0]

  // Une seule machine mono/bi-cœur (MAX_WORKERS=1) : le découpage shallow +
  // N workers récursifs n'a pas de sens avec un seul worker disponible — un
  // worker unique, pleinement récursif, scanne tout. Évite aussi la division
  // par zéro plus bas (partitions.length - 1 === 0) lors du round-robin.
  if (MAX_WORKERS <= 1) {
    return [{ roots: [root], shallow: false }]
  }

  const subDirs: string[] = []
  try {
    const handle = await opendir(root)
    for await (const entry of handle) {
      if (
        entry.isDirectory() &&
        !entry.name.startsWith('.') &&
        entry.name !== 'node_modules' &&
        entry.name !== '.git' &&
        entry.name !== '@eaDir' &&
        entry.name !== '.picalibre' &&
        entry.name !== '.thumbnails'
      ) {
        subDirs.push(join(root, entry.name))
      }
    }
  } catch {
    // permissions ou dossier disparu → un seul worker récursif
    return [{ roots: [root], shallow: false }]
  }

  // Un worker « shallow » pour les fichiers directement à la racine,
  // puis un worker récursif par sous-dossier (limité à MAX_WORKERS).
  const partitions: WorkerPartition[] = []
  partitions.push({ roots: [root], shallow: true })

  for (let i = 0; i < subDirs.length && partitions.length < MAX_WORKERS; i++) {
    partitions.push({ roots: [subDirs[i]], shallow: false })
  }

  // S'il reste des sous-dossiers (plus que MAX_WORKERS−1), les répartir
  // sur les workers récursifs existants en round-robin.
  // Cas particulier : un seul worker récursif existe (ou aucun, MAX_WORKERS=1
  // sur une machine à 1-2 cœurs) → pas de round-robin possible, modulo par
  // zéro sinon (partitions.length - 1 === 0) → NaN → crash. Tout rejoint
  // alors le worker "shallow" (indice 0), qui devient de facto récursif.
  const recursiveWorkerCount = partitions.length - 1
  for (let i = MAX_WORKERS - 1; i < subDirs.length; i++) {
    const targetIdx = recursiveWorkerCount > 0 ? 1 + ((i - (MAX_WORKERS - 1)) % recursiveWorkerCount) : 0
    partitions[targetIdx].roots.push(subDirs[i])
  }

  return partitions
}

export async function startScan(win: BrowserWindow, rootsOverride?: string[]): Promise<void> {
  const roots =
    rootsOverride ??
    getDb()
      .prepare(`SELECT path FROM scan_roots WHERE mode != 'excluded'`)
      .all()
      .map((r: any) => r.path as string)
  if (roots.length === 0) return

  const partitions = await partitionRoots(roots)

  // État d'agrégation
  const progress: WorkerProgress = { filesFound: 0, filesProcessed: 0, currentPath: null }
  let workersDone = 0
  const totalWorkers = partitions.length
  let pipelineStarted = false

  // Throttle des événements scan:progress : limite à ~10/s (100 ms minimum
  // entre émissions) pour éviter 10 000+ redraws du renderer sur une grosse
  // bibliothèque. Le dernier état est flushé quand tous les workers terminent.
  const progressSender: ProgressSender = createProgressThrottle(win, 100)

  const sendAggregatedProgress = (): void => {
    progressSender.send({
      phase: 'hashing',
      filesFound: progress.filesFound,
      filesProcessed: progress.filesProcessed,
      currentPath: progress.currentPath ?? undefined
    })
  }

  const launchPostScan = (): void => {
    if (pipelineStarted) return
    pipelineStarted = true
    // Flush final : garantit que le renderer reçoit le dernier état de la
    // phase 'hashing' avant d'enchaîner sur les phases exif/thumbs du pipeline.
    progressSender.flush()
    void runPostScanPipeline(win)
  }

  for (const partition of partitions) {
    // Ne charger que les fichiers connus de cette partition — réduit
    // l'empreinte mémoire de 50-100 Mo sur les grosses bibliothèques
    // (avant: toute la table photos en Map JS pour chaque worker).
    const knownFiles = getKnownFilesForRoots(partition.roots, partition.shallow)
    const worker = utilityProcess.fork(join(__dirname, 'scan-worker.js'))
    worker.postMessage({
      type: 'scan',
      roots: partition.roots,
      knownFiles,
      shallow: partition.shallow
    })

    worker.on('message', (msg: any) => {
      switch (msg.type) {
        case 'batch': {
          const folderIds = upsertScannedBatch(msg.files as Parameters<typeof upsertScannedBatch>[0])
          win.webContents.send('library:changed', { folderIds })
          break
        }
        case 'progress': {
          // Mise à jour incrémentale : les workers envoient des compteurs absolus
          // pour leur propre partition — on ne peut pas juste additionner.
          // On recalcule la progression agrégée à partir de deltas.
          // Chaque worker envoie son propre filesFound/filesProcessed absolu.
          // On stocke par-worker et on somme.
          const workerIdx = partitions.indexOf(partition)
          updateWorkerProgress(workerIdx, msg)
          break
        }
        case 'done': {
          workersDone++
          worker.kill()
          if (workersDone >= totalWorkers) {
            // Envoie une dernière progression puis enchaîne le pipeline
            sendAggregatedProgress()
            launchPostScan()
          }
          break
        }
        case 'error': {
          console.error('[scanner]', msg.message)
          worker.kill()
          workersDone++
          if (workersDone >= totalWorkers) {
            launchPostScan()
          }
          break
        }
      }
    })
  }

  // --- Gestion de la progression par-worker ---
  const workerProgress: Map<number, WorkerProgress> = new Map()

  function updateWorkerProgress(workerIdx: number, msg: any): void {
    workerProgress.set(workerIdx, {
      filesFound: msg.filesFound as number,
      filesProcessed: msg.filesProcessed as number,
      currentPath: msg.currentPath as string | null
    })

    // Agrège tous les workers
    let totalFound = 0
    let totalProcessed = 0
    let lastPath: string | null = null
    for (const wp of workerProgress.values()) {
      totalFound += wp.filesFound
      totalProcessed += wp.filesProcessed
      if (wp.currentPath) lastPath = wp.currentPath
    }
    progress.filesFound = totalFound
    progress.filesProcessed = totalProcessed
    progress.currentPath = lastPath

    sendAggregatedProgress()
  }
}