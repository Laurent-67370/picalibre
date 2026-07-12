/**
 * ScannerService — orchestre le ScanWorker (utilityProcess) depuis le main.
 */
import { utilityProcess, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { getDb, getKnownFiles, upsertScannedBatch } from '../db'
import { runPostScanPipeline } from './pipeline'

export function startScan(win: BrowserWindow, rootsOverride?: string[]): void {
  const roots =
    rootsOverride ??
    getDb()
      .prepare(`SELECT path FROM scan_roots WHERE mode != 'excluded'`)
      .all()
      .map((r: any) => r.path)
  if (roots.length === 0) return

  const worker = utilityProcess.fork(join(__dirname, 'scan-worker.js'))
  worker.postMessage({ type: 'scan', roots, knownFiles: getKnownFiles() })

  worker.on('message', (msg: any) => {
    switch (msg.type) {
      case 'batch': {
        const folderIds = upsertScannedBatch(msg.files)
        win.webContents.send('library:changed', { folderIds })
        break
      }
      case 'progress':
        win.webContents.send('scan:progress', { phase: 'hashing', ...msg })
        break
      case 'done':
        worker.kill()
        // Enchaîne EXIF puis miniatures, puis émet phase 'done'
        void runPostScanPipeline(win)
        break
      case 'error':
        console.error('[scanner]', msg.message)
        worker.kill()
        break
    }
  })
}
