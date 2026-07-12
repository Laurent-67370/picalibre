/**
 * ScannerService — orchestre le ScanWorker (utilityProcess) depuis le main.
 */
import { utilityProcess, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { getDb, getKnownFiles, upsertScannedBatch } from '../db'

export function startScan(win: BrowserWindow): void {
  const roots = getDb()
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
        win.webContents.send('scan:progress', {
          phase: 'done',
          filesFound: msg.stats.filesFound,
          filesProcessed: msg.stats.filesProcessed
        })
        worker.kill()
        break
      case 'error':
        console.error('[scanner]', msg.message)
        worker.kill()
        break
    }
  })
}
