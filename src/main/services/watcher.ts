/**
 * WatcherService — surveillance temps réel des racines de scan (chokidar).
 * Ajout/modification → mini-rescan des dossiers touchés (le rescan
 * incrémental par size+mtime rend l'opération quasi gratuite).
 * Suppression → statut 'missing' (comportement Picasa : jamais de perte
 * d'albums/tags/éditions si le disque revient).
 */
import chokidar, { FSWatcher } from 'chokidar'
import { BrowserWindow } from 'electron'
import { dirname, extname } from 'node:path'
import { getDb } from '../db'
import { startScan } from './scanner'

const MEDIA_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.heif', '.avif',
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.3gp', '.mts'
])

let watcher: FSWatcher | null = null
let flushTimer: ReturnType<typeof setTimeout> | undefined
const pendingDirs = new Set<string>()
const pendingMissing = new Set<string>()

export function startWatchers(win: BrowserWindow): void {
  void stopWatchers()
  const roots = getDb()
    .prepare(`SELECT path FROM scan_roots WHERE mode = 'watch'`)
    .all()
    .map((r: any) => r.path as string)
  if (roots.length === 0) return

  watcher = chokidar.watch(roots, {
    ignoreInitial: true,
    ignored: (p: string) => /[\\/]\./.test(p) || p.includes('node_modules'),
    awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 200 }
  })

  const isMedia = (p: string): boolean => MEDIA_EXT.has(extname(p).toLowerCase())

  const schedule = (): void => {
    clearTimeout(flushTimer)
    flushTimer = setTimeout(() => flush(win), 2500)
  }

  watcher.on('add', (p) => {
    if (isMedia(p)) {
      pendingDirs.add(dirname(p))
      schedule()
    }
  })
  watcher.on('change', (p) => {
    if (isMedia(p)) {
      pendingDirs.add(dirname(p))
      schedule()
    }
  })
  watcher.on('unlink', (p) => {
    if (isMedia(p)) {
      pendingMissing.add(p)
      schedule()
    }
  })
  console.log(`[watcher] surveillance de ${roots.length} racine(s)`)
}

function flush(win: BrowserWindow): void {
  if (pendingMissing.size > 0) {
    const db = getDb()
    const stmt = db.prepare(`UPDATE photos SET status = 'missing' WHERE filepath = ?`)
    const tx = db.transaction((paths: string[]) => {
      for (const p of paths) stmt.run(p)
    })
    tx([...pendingMissing])
    pendingMissing.clear()
    win.webContents.send('library:changed', { folderIds: [] })
  }
  if (pendingDirs.size > 0) {
    const dirs = [...pendingDirs]
    pendingDirs.clear()
    console.log(`[watcher] rescan de ${dirs.length} dossier(s)`)
    startScan(win, dirs)
  }
}

export async function stopWatchers(): Promise<void> {
  clearTimeout(flushTimer)
  if (watcher) {
    await watcher.close()
    watcher = null
  }
}
