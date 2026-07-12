import { useCallback, useEffect, useState } from 'react'
import type { FolderRow, PhotoRow, ScanProgress, RendererApi } from '@shared/ipc'

declare global {
  interface Window {
    api: RendererApi
  }
}

const PAGE = 500

const PHASE_LABEL: Record<ScanProgress['phase'], string> = {
  walking: 'Parcours des dossiers',
  hashing: 'Indexation (hash)',
  exif: 'Lecture EXIF',
  thumbs: 'Miniatures',
  done: 'Terminé'
}

function folderName(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return path.slice(i + 1) || path
}

export default function App(): JSX.Element {
  const [folders, setFolders] = useState<FolderRow[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [photos, setPhotos] = useState<PhotoRow[]>([])
  const [progress, setProgress] = useState<ScanProgress | null>(null)

  const refreshFolders = useCallback(
    () => window.api.invoke('folders:tree', undefined).then(setFolders),
    []
  )

  const loadPhotos = useCallback((folderId: number) => {
    setSelected(folderId)
    window.api
      .invoke('photos:byFolder', { folderId, offset: 0, limit: PAGE })
      .then(setPhotos)
  }, [])

  useEffect(() => {
    refreshFolders()
    const off1 = window.api.on('scan:progress', (p) => {
      setProgress(p)
      if (p.phase === 'done') refreshFolders()
    })
    const off2 = window.api.on('library:changed', () => {
      refreshFolders()
      if (selected !== null) loadPhotos(selected)
    })
    return () => {
      off1()
      off2()
    }
  }, [refreshFolders, loadPhotos, selected])

  const addFolder = async () => {
    const path = await window.api.invoke('dialog:pickFolder', undefined)
    if (!path) return
    await window.api.invoke('scanRoots:add', { path })
    await window.api.invoke('scan:start', {})
  }

  const setRating = async (photoId: number, rating: number) => {
    await window.api.invoke('photos:setRating', { photoId, rating })
    setPhotos((prev) => prev.map((p) => (p.id === photoId ? { ...p, rating } : p)))
  }

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <aside
        style={{
          width: 260,
          borderRight: '1px solid #333',
          padding: 12,
          overflow: 'auto',
          flexShrink: 0
        }}
      >
        <button onClick={addFolder} style={{ width: '100%', padding: 8, marginBottom: 12 }}>
          + Ajouter un dossier
        </button>
        {folders.map((f) => (
          <div
            key={f.id}
            onClick={() => loadPhotos(f.id)}
            title={f.path}
            style={{
              padding: '5px 8px',
              fontSize: 13,
              cursor: 'pointer',
              borderRadius: 4,
              background: selected === f.id ? '#2f6feb33' : 'transparent',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis'
            }}
          >
            📁 {folderName(f.path)}
          </div>
        ))}
      </aside>

      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {progress && progress.phase !== 'done' && (
          <div style={{ padding: '8px 16px', background: '#26313f', fontSize: 13 }}>
            {PHASE_LABEL[progress.phase]}… {progress.filesProcessed}/{progress.filesFound}
          </div>
        )}

        <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
          {selected === null ? (
            <p style={{ opacity: 0.7 }}>
              Sélectionne un dossier à gauche, ou ajoute un dossier pour lancer l&apos;indexation.
            </p>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
                gap: 8
              }}
            >
              {photos.map((p) => (
                <figure key={p.id} style={{ margin: 0, position: 'relative' }}>
                  <img
                    src={`thumb://library/256/${p.id}`}
                    alt={p.filename}
                    loading="lazy"
                    style={{
                      width: '100%',
                      aspectRatio: '1',
                      objectFit: 'cover',
                      borderRadius: 4,
                      background: '#14171c',
                      display: 'block'
                    }}
                  />
                  <figcaption
                    style={{
                      fontSize: 11,
                      opacity: 0.75,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      marginTop: 2
                    }}
                  >
                    {p.filename}
                  </figcaption>
                  <div style={{ fontSize: 12, letterSpacing: 2, cursor: 'pointer', userSelect: 'none' }}>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <span
                        key={n}
                        onClick={() => setRating(p.id, p.rating === n ? 0 : n)}
                        style={{ color: n <= p.rating ? '#f5c518' : '#444' }}
                      >
                        ★
                      </span>
                    ))}
                  </div>
                </figure>
              ))}
              {photos.length === 0 && <p style={{ opacity: 0.6 }}>Aucune photo dans ce dossier.</p>}
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
