import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { AlbumRow, FolderRow, PersonRow, PhotoRow, ScanProgress, RendererApi } from '@shared/ipc'
import MapView from './MapView'
import Editor from './Editor'

declare global {
  interface Window {
    api: RendererApi
  }
}

const PAGE = 10000 // la virtualisation rend l'affichage indolore
const CELL = 172 // 160px de vignette + gap
const ROW_H = 214 // vignette + nom + étoiles

type View =
  | { type: 'folder'; id: number }
  | { type: 'album'; id: number }
  | { type: 'person'; id: number }
  | { type: 'search'; query: string }
  | { type: 'map' }

const PHASE_LABEL: Record<ScanProgress['phase'], string> = {
  walking: 'Parcours des dossiers',
  hashing: 'Indexation (hash)',
  exif: 'Lecture EXIF',
  thumbs: 'Miniatures',
  done: 'Terminé'
}

const folderName = (path: string): string => {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return path.slice(i + 1) || path
}

export default function App(): JSX.Element {
  const [folders, setFolders] = useState<FolderRow[]>([])
  const [albums, setAlbums] = useState<AlbumRow[]>([])
  const [persons, setPersons] = useState<PersonRow[]>([])
  const [faceProgress, setFaceProgress] = useState<{ done: number; total: number } | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [view, setView] = useState<View | null>(null)
  const [photos, setPhotos] = useState<PhotoRow[]>([])
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [searchInput, setSearchInput] = useState('')
  const [editing, setEditing] = useState<PhotoRow | null>(null)

  // ---- Tray (bac Picasa) ----
  const [tray, setTray] = useState<Map<number, PhotoRow>>(new Map())
  const [trayName, setTrayName] = useState('')
  const [trayAlbumId, setTrayAlbumId] = useState<number | ''>('')
  const trayIds = useMemo(() => [...tray.keys()], [tray])

  const toggleTray = (p: PhotoRow) =>
    setTray((prev) => {
      const next = new Map(prev)
      next.has(p.id) ? next.delete(p.id) : next.set(p.id, p)
      return next
    })

  // ---- Chargement ----
  const refreshSidebar = useCallback(() => {
    window.api.invoke('folders:tree', undefined).then(setFolders)
    window.api.invoke('albums:list', undefined).then(setAlbums)
    window.api.invoke('persons:list', undefined).then(setPersons)
  }, [])

  const loadView = useCallback((v: View) => {
    setView(v)
    if (v.type === 'map') {
      setPhotos([])
      return
    }
    const req =
      v.type === 'folder'
        ? window.api.invoke('photos:byFolder', { folderId: v.id, offset: 0, limit: PAGE })
        : v.type === 'album'
          ? window.api.invoke('photos:byAlbum', { albumId: v.id, offset: 0, limit: PAGE })
          : v.type === 'person'
            ? window.api.invoke('photos:byPerson', { personId: v.id, offset: 0, limit: PAGE })
            : window.api.invoke('photos:search', { query: v.query, offset: 0, limit: PAGE })
    req.then(setPhotos)
  }, [])

  const viewRef = useRef<View | null>(null)
  viewRef.current = view

  useEffect(() => {
    refreshSidebar()
    const off1 = window.api.on('scan:progress', (p) => {
      setProgress(p)
      if (p.phase === 'done') refreshSidebar()
    })
    const off2 = window.api.on('library:changed', () => {
      refreshSidebar()
      if (viewRef.current && viewRef.current.type !== 'map') loadView(viewRef.current)
    })
    const off3 = window.api.on('faces:progress', (p) => {
      setFaceProgress(p.done >= p.total ? null : p)
      if (p.done >= p.total) refreshSidebar()
    })
    const off4 = window.api.on('persons:changed', () => refreshSidebar())
    return () => {
      off1()
      off2()
      off3()
      off4()
    }
  }, [refreshSidebar, loadView])

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

  // ---- Actions du tray ----
  const trayCreateAlbum = async () => {
    if (!trayName.trim() || trayIds.length === 0) return
    const { id } = await window.api.invoke('albums:create', { name: trayName.trim() })
    await window.api.invoke('albums:addPhotos', { albumId: id, photoIds: trayIds })
    setTrayName('')
    refreshSidebar()
  }
  const trayAddToAlbum = async () => {
    if (trayAlbumId === '' || trayIds.length === 0) return
    await window.api.invoke('albums:addPhotos', { albumId: trayAlbumId, photoIds: trayIds })
    refreshSidebar()
  }
  const trayTag = async () => {
    if (!trayName.trim() || trayIds.length === 0) return
    await window.api.invoke('tags:addToPhotos', { name: trayName.trim(), photoIds: trayIds })
    setTrayName('')
  }

  // ---- Grille virtualisée ----
  const gridRef = useRef<HTMLDivElement>(null)
  const [gridWidth, setGridWidth] = useState(800)
  useEffect(() => {
    const el = gridRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setGridWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const columns = Math.max(1, Math.floor((gridWidth - 16) / CELL))
  const rowCount = Math.ceil(photos.length / columns)
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => gridRef.current,
    estimateSize: () => ROW_H,
    overscan: 4
  })

  const sidebarItem = (active: boolean): React.CSSProperties => ({
    padding: '5px 8px',
    fontSize: 13,
    cursor: 'pointer',
    borderRadius: 4,
    background: active ? '#2f6feb33' : 'transparent',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis'
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* ---- Sidebar ---- */}
        <aside
          style={{
            width: 260,
            borderRight: '1px solid #333',
            padding: 12,
            overflow: 'auto',
            flexShrink: 0
          }}
        >
          <button onClick={addFolder} style={{ width: '100%', padding: 8, marginBottom: 10 }}>
            + Ajouter un dossier
          </button>
          <input
            placeholder="Rechercher (nom, tag…)"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && searchInput.trim())
                loadView({ type: 'search', query: searchInput.trim() })
            }}
            style={{
              width: '100%',
              padding: 6,
              marginBottom: 12,
              background: '#14171c',
              border: '1px solid #333',
              borderRadius: 4,
              color: '#d7dae0',
              boxSizing: 'border-box'
            }}
          />

          <div
            onClick={() => loadView({ type: 'map' })}
            style={sidebarItem(view?.type === 'map')}
          >
            🗺 Carte
          </div>

          <div style={{ fontSize: 11, opacity: 0.5, margin: '10px 0 4px' }}>PERSONNES</div>
          <button
            onClick={async () => {
              const r = await window.api.invoke('faces:scan', undefined)
              if (r.started) setFaceProgress({ done: 0, total: 1 })
            }}
            style={{ width: '100%', padding: 6, marginBottom: 6, fontSize: 12 }}
          >
            🔍 Analyser les visages
          </button>
          {faceProgress && (
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>
              Détection… {faceProgress.done}/{faceProgress.total}
            </div>
          )}
          {persons.map((pe) => {
            const hasBox =
              pe.samplePhotoId != null && pe.bbox_w != null && pe.bbox_w > 0 && pe.bbox_h != null
            const bx = pe.bbox_x ?? 0
            const by = pe.bbox_y ?? 0
            const bw = pe.bbox_w ?? 1
            const bh = pe.bbox_h ?? 1
            return (
              <div
                key={pe.id}
                onClick={() => {
                  setRenameValue(pe.name ?? '')
                  loadView({ type: 'person', id: pe.id })
                }}
                style={{
                  ...sidebarItem(view?.type === 'person' && view.id === pe.id),
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8
                }}
              >
                <span
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: '50%',
                    flexShrink: 0,
                    background: '#14171c',
                    backgroundImage: hasBox
                      ? `url("thumb://library/256/${pe.samplePhotoId}")`
                      : undefined,
                    backgroundSize: `${100 / bw}% ${100 / bh}%`,
                    backgroundPosition: `${bw < 1 ? (bx / (1 - bw)) * 100 : 0}% ${
                      bh < 1 ? (by / (1 - bh)) * 100 : 0
                    }%`
                  }}
                />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {pe.name ?? `Personne ${pe.id}`}{' '}
                  <span style={{ opacity: 0.5 }}>({pe.face_count})</span>
                </span>
              </div>
            )
          })}
          {persons.length === 0 && !faceProgress && (
            <div style={{ fontSize: 12, opacity: 0.4, padding: '2px 8px' }}>
              Lance l'analyse ci-dessus
            </div>
          )}

          <div style={{ fontSize: 11, opacity: 0.5, margin: '8px 0 4px' }}>ALBUMS</div>
          {albums.map((a) => (
            <div
              key={a.id}
              onClick={() => loadView({ type: 'album', id: a.id })}
              style={sidebarItem(view?.type === 'album' && view.id === a.id)}
            >
              🗂️ {a.name} <span style={{ opacity: 0.5 }}>({a.count})</span>
            </div>
          ))}
          {albums.length === 0 && (
            <div style={{ fontSize: 12, opacity: 0.4, padding: '2px 8px' }}>
              Aucun album — utilise le bac
            </div>
          )}

          <div style={{ fontSize: 11, opacity: 0.5, margin: '12px 0 4px' }}>DOSSIERS</div>
          {folders.map((f) => (
            <div
              key={f.id}
              onClick={() => loadView({ type: 'folder', id: f.id })}
              title={f.path}
              style={sidebarItem(view?.type === 'folder' && view.id === f.id)}
            >
              📁 {folderName(f.path)}
            </div>
          ))}
        </aside>

        {/* ---- Zone principale ---- */}
        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {progress && progress.phase !== 'done' && (
            <div style={{ padding: '8px 16px', background: '#26313f', fontSize: 13 }}>
              {PHASE_LABEL[progress.phase]}… {progress.filesProcessed}/{progress.filesFound}
            </div>
          )}
          {view?.type === 'search' && (
            <div style={{ padding: '8px 16px', fontSize: 13, opacity: 0.7 }}>
              {photos.length} résultat(s) pour « {view.query} »
            </div>
          )}
          {view?.type === 'person' && (
            <div style={{ padding: '8px 16px', display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                value={renameValue}
                placeholder="Nom de la personne…"
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key === 'Enter') {
                    await window.api.invoke('persons:rename', {
                      personId: view.id,
                      name: renameValue
                    })
                    refreshSidebar()
                  }
                }}
                style={{
                  padding: 6,
                  background: '#14171c',
                  border: '1px solid #333',
                  borderRadius: 4,
                  color: '#d7dae0',
                  width: 220
                }}
              />
              <button
                onClick={async () => {
                  await window.api.invoke('persons:rename', { personId: view.id, name: renameValue })
                  refreshSidebar()
                }}
              >
                ✔ Renommer
              </button>
              <span style={{ fontSize: 13, opacity: 0.6 }}>{photos.length} photo(s)</span>
            </div>
          )}

          {view?.type === 'map' ? (
            <MapView
              trayIds={trayIds}
              onGeotagged={() => {
                /* les marqueurs se rechargent dans MapView */
              }}
            />
          ) : (
          <div ref={gridRef} style={{ flex: 1, overflow: 'auto', padding: '8px 16px' }}>
            {view === null ? (
              <p style={{ opacity: 0.7 }}>
                Sélectionne un dossier ou un album, ou ajoute un dossier à indexer.
              </p>
            ) : photos.length === 0 ? (
              <p style={{ opacity: 0.6 }}>Aucune photo ici.</p>
            ) : (
              <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                {virtualizer.getVirtualItems().map((row) => (
                  <div
                    key={row.key}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${row.start}px)`,
                      display: 'grid',
                      gridTemplateColumns: `repeat(${columns}, 1fr)`,
                      gap: 8
                    }}
                  >
                    {photos
                      .slice(row.index * columns, row.index * columns + columns)
                      .map((p) => {
                        const inTray = tray.has(p.id)
                        return (
                          <figure key={p.id} style={{ margin: 0, position: 'relative' }}>
                            <img
                              src={`thumb://library/256/${p.id}`}
                              alt={p.filename}
                              loading="lazy"
                              onClick={() => toggleTray(p)}
                              onDoubleClick={() => setEditing(p)}
                              style={{
                                width: '100%',
                                aspectRatio: '1',
                                objectFit: 'cover',
                                borderRadius: 4,
                                background: '#14171c',
                                display: 'block',
                                cursor: 'pointer',
                                outline: inTray ? '3px solid #2f6feb' : 'none',
                                outlineOffset: -3
                              }}
                            />
                            {inTray && (
                              <span
                                style={{
                                  position: 'absolute',
                                  top: 6,
                                  right: 6,
                                  background: '#2f6feb',
                                  borderRadius: '50%',
                                  width: 20,
                                  height: 20,
                                  fontSize: 13,
                                  textAlign: 'center',
                                  lineHeight: '20px'
                                }}
                              >
                                ✓
                              </span>
                            )}
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
                            <div
                              style={{
                                fontSize: 12,
                                letterSpacing: 2,
                                cursor: 'pointer',
                                userSelect: 'none'
                              }}
                            >
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
                        )
                      })}
                  </div>
                ))}
              </div>
            )}
          </div>
          )}
        </main>
      </div>

      {editing && <Editor photo={editing} onClose={() => setEditing(null)} />}

      {/* ---- Tray (bac Picasa) ---- */}
      <footer
        style={{
          borderTop: '1px solid #333',
          padding: '8px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          background: '#181b20',
          minHeight: 48
        }}
      >
        <div style={{ display: 'flex', gap: 4, overflow: 'auto', maxWidth: 320 }}>
          {[...tray.values()].slice(0, 8).map((p) => (
            <img
              key={p.id}
              src={`thumb://library/256/${p.id}`}
              onClick={() => toggleTray(p)}
              title={`${p.filename} — retirer du bac`}
              style={{ width: 36, height: 36, objectFit: 'cover', borderRadius: 3, cursor: 'pointer' }}
            />
          ))}
          {tray.size > 8 && <span style={{ fontSize: 12, alignSelf: 'center' }}>+{tray.size - 8}</span>}
        </div>
        <span style={{ fontSize: 13, opacity: 0.7, minWidth: 110 }}>
          {tray.size === 0 ? 'Bac vide — clique des photos' : `${tray.size} dans le bac`}
        </span>
        <input
          placeholder="Nom d'album ou tag…"
          value={trayName}
          onChange={(e) => setTrayName(e.target.value)}
          style={{
            padding: 6,
            background: '#14171c',
            border: '1px solid #333',
            borderRadius: 4,
            color: '#d7dae0',
            width: 170
          }}
        />
        <button onClick={trayCreateAlbum} disabled={tray.size === 0 || !trayName.trim()}>
          Nouvel album
        </button>
        <button onClick={trayTag} disabled={tray.size === 0 || !trayName.trim()}>
          Tag
        </button>
        <select
          value={trayAlbumId}
          onChange={(e) => setTrayAlbumId(e.target.value === '' ? '' : Number(e.target.value))}
          style={{ padding: 6, background: '#14171c', color: '#d7dae0', border: '1px solid #333' }}
        >
          <option value="">Album existant…</option>
          {albums.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <button onClick={trayAddToAlbum} disabled={tray.size === 0 || trayAlbumId === ''}>
          Ajouter
        </button>
        <button onClick={() => setTray(new Map())} disabled={tray.size === 0}>
          Vider
        </button>
      </footer>
    </div>
  )
}
