import { useEffect, useState } from 'react'
import type { FolderRow, ScanProgress, RendererApi } from '@shared/ipc'

declare global {
  interface Window {
    api: RendererApi
  }
}

export default function App(): JSX.Element {
  const [folders, setFolders] = useState<FolderRow[]>([])
  const [progress, setProgress] = useState<ScanProgress | null>(null)

  const refresh = () => window.api.invoke('folders:tree', undefined).then(setFolders)

  useEffect(() => {
    refresh()
    const off1 = window.api.on('scan:progress', setProgress)
    const off2 = window.api.on('library:changed', refresh)
    return () => {
      off1()
      off2()
    }
  }, [])

  const addFolder = async () => {
    const path = await window.api.invoke('dialog:pickFolder', undefined)
    if (!path) return
    await window.api.invoke('scanRoots:add', { path })
    await window.api.invoke('scan:start', {})
  }

  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      <aside style={{ width: 260, borderRight: '1px solid #333', padding: 12, overflow: 'auto' }}>
        <button onClick={addFolder} style={{ width: '100%', padding: 8, marginBottom: 12 }}>
          + Ajouter un dossier à scanner
        </button>
        {folders.map((f) => (
          <div key={f.id} style={{ padding: '4px 0', fontSize: 13, opacity: 0.9 }}>
            📁 {f.path}
          </div>
        ))}
      </aside>
      <main style={{ flex: 1, padding: 16 }}>
        <h2 style={{ marginTop: 0 }}>PicaLibre</h2>
        {progress && progress.phase !== 'done' && (
          <p>
            Scan en cours… {progress.filesProcessed}/{progress.filesFound} fichiers
          </p>
        )}
        {progress?.phase === 'done' && <p>✅ Scan terminé : {progress.filesFound} fichiers indexés</p>}
        {folders.length === 0 && !progress && <p>Ajoute un dossier pour commencer l'indexation.</p>}
      </main>
    </div>
  )
}
