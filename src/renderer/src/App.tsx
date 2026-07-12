import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { AlbumRow, FaceLite, FolderRow, PersonRow, PhotoRow, ScanProgress, RendererApi } from '@shared/ipc'
import MapView from './MapView'
import Slideshow from './Slideshow'
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
  | { type: 'duplicates' }
  | { type: 'hidden' }
  | { type: 'settings' }

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
  const [manageFaces, setManageFaces] = useState(false)
  const [faceList, setFaceList] = useState<FaceLite[]>([])
  const [selFaces, setSelFaces] = useState<Set<number>>(new Set())
  const [mergeTarget, setMergeTarget] = useState<number | ''>('')
  const [dupGroups, setDupGroups] = useState<Array<{ hash: string; photos: PhotoRow[] }>>([])
  const [roots, setRoots] = useState<Array<{ id: number; path: string; mode: string }>>([])
  const [privacy, setPrivacy] = useState<{ hasPassword: boolean; unlocked: boolean }>({ hasPassword: false, unlocked: true })
  const [pwInput, setPwInput] = useState('')
  const [exportPreset, setExportPreset] = useState<number | 0>(0)
  const [watermark, setWatermark] = useState('')
  const [exportProgress, setExportProgress] = useState<{ done: number; total: number } | null>(null)
  const [slideshow, setSlideshow] = useState(false)
  const [collageLayout, setCollageLayout] = useState<'grid' | 'row' | 'column' | 'mosaic'>('grid')
  const [movieBusy, setMovieBusy] = useState(false)
  const [importProgress, setImportProgress] = useState<{ done: number; total: number; copied: number; skipped: number } | null>(null)
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
    setManageFaces(false)
    setSelFaces(new Set())
    if (v.type === 'map') {
      setPhotos([])
      return
    }
    if (v.type === 'duplicates') {
      setPhotos([])
      window.api.invoke('duplicates:list', undefined).then(setDupGroups)
      return
    }
    if (v.type === 'settings') {
      setPhotos([])
      window.api.invoke('scanRoots:list', undefined).then(setRoots)
      window.api.invoke('privacy:status', undefined).then(setPrivacy)
      return
    }
    if (v.type === 'hidden') {
      window.api.invoke('privacy:status', undefined).then((st) => {
        setPrivacy(st)
        if (st.unlocked) window.api.invoke('photos:hidden', undefined).then(setPhotos)
        else setPhotos([])
      })
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
    const off5 = window.api.on('import:progress', (p) => {
      setImportProgress(p.done >= p.total ? null : p)
    })
    const off6 = window.api.on('export:progress', (p) => {
      setExportProgress(p.done >= p.total ? null : p)
    })
    void off5
    void off6
    return () => {
      off1()
      off2()
      off3()
      off4()
    }
  }, [refreshSidebar, loadView])

  const runImport = async () => {
    const sourceDir = await window.api.invoke('dialog:pickFolder', undefined)
    if (!sourceDir) return
    const destDir = await window.api.invoke('dialog:pickFolder', undefined)
    if (!destDir) return
    setImportProgress({ done: 0, total: 1, copied: 0, skipped: 0 })
    const stats = await window.api.invoke('import:run', { sourceDir, destDir })
    setImportProgress(null)
    alert(
      `Import terminé : ${stats.copied} copiée(s), ${stats.skippedDuplicates} doublon(s) ignoré(s), ${stats.errors} erreur(s).`
    )
  }

  const mergeGroup = async (hash: string, keepId: number) => {
    const group = dupGroups.find((g) => g.hash === hash)
    if (!group) return
    const removeIds = group.photos.filter((p) => p.id !== keepId).map((p) => p.id)
    await window.api.invoke('duplicates:merge', { keepId, removeIds })
    window.api.invoke('duplicates:list', undefined).then(setDupGroups)
    refreshSidebar()
  }

  const trayExport = async () => {
    if (trayIds.length === 0) return
    const destDir = await window.api.invoke('dialog:pickFolder', undefined)
    if (!destDir) return
    setExportProgress({ done: 0, total: trayIds.length })
    const r = await window.api.invoke('export:batch', {
      photoIds: trayIds,
      destDir,
      maxSize: exportPreset === 0 ? null : exportPreset,
      quality: 90,
      watermark: watermark.trim() || null
    })
    setExportProgress(null)
    alert(`Export : ${r.exported} réussie(s), ${r.errors} erreur(s).`)
  }

  const trayCsv = async () => {
    if (trayIds.length === 0) return
    const destDir = await window.api.invoke('dialog:pickFolder', undefined)
    if (!destDir) return
    const r = await window.api.invoke('export:metadata', {
      photoIds: trayIds,
      destFile: `${destDir}/metadonnees.csv`
    })
    alert(`CSV écrit (${r.rows} ligne(s)) : ${destDir}/metadonnees.csv`)
  }

  const trayHide = async () => {
    const hide = view?.type !== 'hidden'
    const r = await window.api.invoke('photos:setHidden', { photoIds: trayIds, hidden: hide })
    if (!r.ok) {
      alert('Déverrouille les photos masquées d’abord (⚙ Réglages).')
      return
    }
    setTray(new Map())
    if (viewRef.current) loadView(viewRef.current)
  }

  const relocate = async () => {
    const newRoot = await window.api.invoke('dialog:pickFolder', undefined)
    if (!newRoot) return
    const r = await window.api.invoke('library:relocate', { newRoot })
    alert(
      `Migration : ${r.relinked} photo(s) reliée(s) par hash, ${r.stillMissing} toujours manquante(s).`
    )
    refreshSidebar()
  }

  const trayCollage = async () => {
    if (trayIds.length === 0) return
    const outFile = await window.api.invoke('dialog:saveFile', {
      defaultName: 'collage.jpg',
      name: 'JPEG',
      extensions: ['jpg']
    })
    if (!outFile) return
    const r = await window.api.invoke('create:collage', {
      photoIds: trayIds,
      layout: collageLayout,
      outFile
    })
    alert(`🧩 Collage ${r.width}x${r.height} créé : ${outFile}`)
  }

  const trayMovie = async () => {
    if (trayIds.length === 0) return
    const wantAudio = confirm('Ajouter une piste audio (MP3/M4A/WAV) ?')
    let audioPath: string | null = null
    if (wantAudio) {
      audioPath = await window.api.invoke('dialog:pickFile', {
        name: 'Audio',
        extensions: ['mp3', 'm4a', 'wav', 'ogg', 'flac']
      })
    }
    const outFile = await window.api.invoke('dialog:saveFile', {
      defaultName: 'diaporama.mp4',
      name: 'Vidéo MP4',
      extensions: ['mp4']
    })
    if (!outFile) return
    setMovieBusy(true)
    try {
      await window.api.invoke('create:movie', {
        photoIds: trayIds,
        durationSec: 3,
        audioPath,
        outFile
      })
      alert(`🎬 Film créé : ${outFile}`)
    } catch {
      alert('Échec de la création du film.')
    }
    setMovieBusy(false)
  }

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

          <button onClick={runImport} style={{ width: '100%', padding: 6, marginBottom: 10, fontSize: 12 }}>
            📥 Importer SD / appareil
          </button>
          {importProgress && (
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>
              Import… {importProgress.done}/{importProgress.total} ({importProgress.skipped} doublons)
            </div>
          )}
          <div
            onClick={() => loadView({ type: 'map' })}
            style={sidebarItem(view?.type === 'map')}
          >
            🗺 Carte
          </div>
          <div
            onClick={() => loadView({ type: 'duplicates' })}
            style={sidebarItem(view?.type === 'duplicates')}
          >
            ⧉ Doublons
          </div>
          <div
            onClick={() => loadView({ type: 'hidden' })}
            style={sidebarItem(view?.type === 'hidden')}
          >
            🙈 Masquées
          </div>
          <div
            onClick={() => loadView({ type: 'settings' })}
            style={sidebarItem(view?.type === 'settings')}
          >
            ⚙ Réglages
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
              <button
                onClick={async () => {
                  const next = !manageFaces
                  setManageFaces(next)
                  setSelFaces(new Set())
                  if (next) {
                    setFaceList(await window.api.invoke('faces:byPerson', { personId: view.id }))
                  }
                }}
              >
                {manageFaces ? '▣ Grille photos' : '👥 Gérer les visages'}
              </button>
              <select
                value={mergeTarget}
                onChange={(e) => setMergeTarget(e.target.value === '' ? '' : Number(e.target.value))}
                style={{ padding: 6, background: '#14171c', color: '#d7dae0', border: '1px solid #333' }}
              >
                <option value="">Fusionner dans…</option>
                {persons
                  .filter((pe) => pe.id !== view.id)
                  .map((pe) => (
                    <option key={pe.id} value={pe.id}>
                      {pe.name ?? `Personne ${pe.id}`}
                    </option>
                  ))}
              </select>
              <button
                disabled={mergeTarget === ''}
                onClick={async () => {
                  if (mergeTarget === '') return
                  await window.api.invoke('persons:merge', {
                    targetId: mergeTarget,
                    sourceIds: [view.id]
                  })
                  setMergeTarget('')
                  setManageFaces(false)
                  loadView({ type: 'person', id: mergeTarget })
                }}
              >
                ⇥ Fusionner
              </button>
            </div>
          )}

          {view?.type === 'person' && manageFaces && (
            <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
              <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
                <span style={{ fontSize: 13, opacity: 0.7 }}>
                  {selFaces.size > 0
                    ? `${selFaces.size} visage(s) sélectionné(s)`
                    : 'Clique les visages à traiter (les moins sûrs en premier)'}
                </span>
                <button
                  disabled={selFaces.size === 0}
                  onClick={async () => {
                    await window.api.invoke('faces:confirm', { faceIds: [...selFaces] })
                    setFaceList(await window.api.invoke('faces:byPerson', { personId: view.id }))
                    setSelFaces(new Set())
                  }}
                >
                  ✔ C'est bien {renameValue || 'cette personne'}
                </button>
                <button
                  disabled={selFaces.size === 0}
                  onClick={async () => {
                    await window.api.invoke('faces:reject', { faceIds: [...selFaces] })
                    setFaceList(await window.api.invoke('faces:byPerson', { personId: view.id }))
                    setSelFaces(new Set())
                    window.api
                      .invoke('photos:byPerson', { personId: view.id, offset: 0, limit: 10000 })
                      .then(setPhotos)
                  }}
                >
                  ✖ Pas cette personne
                </button>
                <button
                  disabled={selFaces.size === 0}
                  onClick={async () => {
                    await window.api.invoke('faces:split', { faceIds: [...selFaces] })
                    setFaceList(await window.api.invoke('faces:byPerson', { personId: view.id }))
                    setSelFaces(new Set())
                    window.api
                      .invoke('photos:byPerson', { personId: view.id, offset: 0, limit: 10000 })
                      .then(setPhotos)
                  }}
                >
                  ✂ Détacher (nouvelle personne)
                </button>
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))',
                  gap: 10
                }}
              >
                {faceList.map((f) => {
                  const sel = selFaces.has(f.id)
                  return (
                    <div
                      key={f.id}
                      onClick={() =>
                        setSelFaces((prev) => {
                          const next = new Set(prev)
                          next.has(f.id) ? next.delete(f.id) : next.add(f.id)
                          return next
                        })
                      }
                      title={`Confiance ${(f.confidence * 100).toFixed(0)} %`}
                      style={{ cursor: 'pointer', textAlign: 'center' }}
                    >
                      <div
                        style={{
                          width: '100%',
                          aspectRatio: '1',
                          borderRadius: 8,
                          background: '#14171c',
                          backgroundImage: `url("thumb://library/256/${f.photo_id}")`,
                          backgroundSize: `${100 / f.bbox_w}% ${100 / f.bbox_h}%`,
                          backgroundPosition: `${
                            f.bbox_w < 1 ? (f.bbox_x / (1 - f.bbox_w)) * 100 : 0
                          }% ${f.bbox_h < 1 ? (f.bbox_y / (1 - f.bbox_h)) * 100 : 0}%`,
                          outline: sel
                            ? '3px solid #2f6feb'
                            : f.assignment === 'confirmed'
                              ? '2px solid #3fb950'
                              : '1px solid #333',
                          outlineOffset: -2
                        }}
                      />
                      <div style={{ fontSize: 10, opacity: 0.6, marginTop: 3 }}>
                        {f.assignment === 'confirmed' ? '✔ confirmé' : `${(f.confidence * 100).toFixed(0)} %`}
                      </div>
                    </div>
                  )
                })}
                {faceList.length === 0 && (
                  <p style={{ opacity: 0.6, gridColumn: '1/-1' }}>Aucun visage pour cette personne.</p>
                )}
              </div>
            </div>
          )}

          {view?.type === 'person' && manageFaces ? null : view?.type === 'settings' ? (
            <div style={{ flex: 1, overflow: 'auto', padding: 16, maxWidth: 720 }}>
              <h3 style={{ marginTop: 0 }}>Dossiers surveillés</h3>
              {roots.map((r) => (
                <div key={r.id} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ flex: 1, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {r.path}
                  </span>
                  <select
                    value={r.mode}
                    onChange={async (e) => {
                      await window.api.invoke('scanRoots:setMode', {
                        id: r.id,
                        mode: e.target.value as 'watch' | 'once' | 'excluded'
                      })
                      window.api.invoke('scanRoots:list', undefined).then(setRoots)
                    }}
                    style={{ padding: 4, background: '#14171c', color: '#d7dae0', border: '1px solid #333' }}
                  >
                    <option value="watch">Surveillé</option>
                    <option value="once">Une fois</option>
                    <option value="excluded">Exclu</option>
                  </select>
                  <button
                    onClick={async () => {
                      await window.api.invoke('scanRoots:remove', { id: r.id })
                      window.api.invoke('scanRoots:list', undefined).then(setRoots)
                      refreshSidebar()
                    }}
                  >
                    🗑
                  </button>
                </div>
              ))}
              {roots.length === 0 && <p style={{ opacity: 0.6, fontSize: 13 }}>Aucune racine.</p>}

              <h3>Migration de bibliothèque</h3>
              <p style={{ fontSize: 13, opacity: 0.7 }}>
                Tu as déplacé tes photos vers un nouveau disque ? Les fichiers sont reliés par
                empreinte (hash) — albums, tags, visages et éditions sont conservés.
              </p>
              <button onClick={relocate}>📦 Relier vers un nouveau dossier…</button>

              <h3 style={{ marginTop: 24 }}>Photos masquées — mot de passe</h3>
              <p style={{ fontSize: 13, opacity: 0.7 }}>
                {privacy.hasPassword
                  ? privacy.unlocked
                    ? 'Protégé, actuellement déverrouillé.'
                    : 'Protégé et verrouillé.'
                  : 'Aucun mot de passe : les photos masquées sont visibles par tous.'}
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="password"
                  placeholder="Mot de passe…"
                  value={pwInput}
                  onChange={(e) => setPwInput(e.target.value)}
                  style={{ padding: 6, background: '#14171c', border: '1px solid #333', borderRadius: 4, color: '#d7dae0' }}
                />
                {!privacy.hasPassword || privacy.unlocked ? (
                  <button
                    onClick={async () => {
                      const r = await window.api.invoke('privacy:setPassword', { password: pwInput })
                      if (!r.ok) alert('Déverrouille d’abord.')
                      setPwInput('')
                      window.api.invoke('privacy:status', undefined).then(setPrivacy)
                    }}
                  >
                    {privacy.hasPassword ? 'Changer' : 'Définir'}
                  </button>
                ) : (
                  <button
                    onClick={async () => {
                      const r = await window.api.invoke('privacy:unlock', { password: pwInput })
                      if (!r.ok) alert('Mot de passe incorrect.')
                      setPwInput('')
                      window.api.invoke('privacy:status', undefined).then(setPrivacy)
                    }}
                  >
                    Déverrouiller
                  </button>
                )}
                {privacy.hasPassword && privacy.unlocked && (
                  <>
                    <button
                      onClick={async () => {
                        await window.api.invoke('privacy:lock', undefined)
                        window.api.invoke('privacy:status', undefined).then(setPrivacy)
                      }}
                    >
                      Verrouiller
                    </button>
                    <button
                      onClick={async () => {
                        await window.api.invoke('privacy:setPassword', { password: '' })
                        window.api.invoke('privacy:status', undefined).then(setPrivacy)
                      }}
                    >
                      Supprimer
                    </button>
                  </>
                )}
              </div>
            </div>
          ) : view?.type === 'hidden' && !privacy.unlocked ? (
            <div style={{ flex: 1, padding: 24 }}>
              <h3>🙈 Photos masquées — verrouillé</h3>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="password"
                  placeholder="Mot de passe…"
                  value={pwInput}
                  onChange={(e) => setPwInput(e.target.value)}
                  onKeyDown={async (e) => {
                    if (e.key !== 'Enter') return
                    const r = await window.api.invoke('privacy:unlock', { password: pwInput })
                    setPwInput('')
                    if (r.ok) loadView({ type: 'hidden' })
                    else alert('Mot de passe incorrect.')
                  }}
                  style={{ padding: 6, background: '#14171c', border: '1px solid #333', borderRadius: 4, color: '#d7dae0' }}
                />
              </div>
            </div>
          ) : view?.type === 'duplicates' ? (
            <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
              {dupGroups.length === 0 ? (
                <p style={{ opacity: 0.7 }}>✨ Aucun doublon exact (même hash) dans la bibliothèque.</p>
              ) : (
                dupGroups.map((g) => (
                  <div
                    key={g.hash}
                    style={{
                      border: '1px solid #333',
                      borderRadius: 6,
                      padding: 12,
                      marginBottom: 12
                    }}
                  >
                    <div style={{ fontSize: 12, opacity: 0.5, marginBottom: 8 }}>
                      {g.photos.length} copies — hash {g.hash}
                    </div>
                    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                      {g.photos.map((p) => (
                        <div key={p.id} style={{ width: 180 }}>
                          <img
                            src={`thumb://library/256/${p.id}`}
                            style={{
                              width: '100%',
                              aspectRatio: '1',
                              objectFit: 'cover',
                              borderRadius: 4
                            }}
                          />
                          <div
                            title={p.filepath}
                            style={{
                              fontSize: 11,
                              opacity: 0.7,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap'
                            }}
                          >
                            {p.filepath}
                          </div>
                          <button
                            onClick={() => mergeGroup(g.hash, p.id)}
                            style={{ width: '100%', marginTop: 4, fontSize: 12 }}
                          >
                            Garder celle-ci
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : view?.type === 'map' ? (
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
      {slideshow && (
        <Slideshow
          photos={tray.size > 0 ? [...tray.values()] : photos}
          onClose={() => setSlideshow(false)}
        />
      )}

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
        <span style={{ width: 1, alignSelf: 'stretch', background: '#333' }} />
        <select
          value={exportPreset}
          onChange={(e) => setExportPreset(Number(e.target.value))}
          title="Taille d'export"
          style={{ padding: 6, background: '#14171c', color: '#d7dae0', border: '1px solid #333' }}
        >
          <option value={0}>Original</option>
          <option value={2048}>2048 px</option>
          <option value={1600}>1600 px</option>
          <option value={1024}>1024 px</option>
        </select>
        <input
          placeholder="Filigrane…"
          value={watermark}
          onChange={(e) => setWatermark(e.target.value)}
          style={{ padding: 6, width: 110, background: '#14171c', border: '1px solid #333', borderRadius: 4, color: '#d7dae0' }}
        />
        <button onClick={trayExport} disabled={tray.size === 0} title="Exporter (éditions appliquées)">
          💾
        </button>
        <button onClick={trayCsv} disabled={tray.size === 0} title="Exporter les métadonnées en CSV">
          📄
        </button>
        <button onClick={trayHide} disabled={tray.size === 0} title="Masquer / démasquer">
          {view?.type === 'hidden' ? '👁' : '🙈'}
        </button>
        <button
          onClick={() => window.api.invoke('photos:print', { photoIds: trayIds, perPage: 4 })}
          disabled={tray.size === 0}
          title="Imprimer (4 par page)"
        >
          🖨
        </button>
        <button
          onClick={() => window.api.invoke('share:email', { photoIds: trayIds })}
          disabled={tray.size === 0}
          title="Partager par email (copies 1600 px)"
        >
          ✉
        </button>
        <span style={{ width: 1, alignSelf: 'stretch', background: '#333' }} />
        <button
          onClick={() => setSlideshow(true)}
          disabled={tray.size === 0 && photos.length === 0}
          title="Diaporama plein écran (bac, sinon vue courante)"
        >
          ▶
        </button>
        <select
          value={collageLayout}
          onChange={(e) => setCollageLayout(e.target.value as typeof collageLayout)}
          title="Layout du collage"
          style={{ padding: 6, background: '#14171c', color: '#d7dae0', border: '1px solid #333' }}
        >
          <option value="grid">Grille</option>
          <option value="mosaic">Mosaïque</option>
          <option value="row">Bande H</option>
          <option value="column">Bande V</option>
        </select>
        <button onClick={trayCollage} disabled={tray.size === 0} title="Créer un collage">
          🧩
        </button>
        <button onClick={trayMovie} disabled={tray.size === 0 || movieBusy} title="Créer un film MP4">
          {movieBusy ? '⏳' : '🎬'}
        </button>
        {exportProgress && (
          <span style={{ fontSize: 12, opacity: 0.7 }}>
            {exportProgress.done}/{exportProgress.total}
          </span>
        )}
      </footer>
    </div>
  )
}
