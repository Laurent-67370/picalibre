import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { AlbumRow, FaceLite, FolderRow, PersonRow, PhotoRow, ScanProgress, RendererApi } from '@shared/ipc'
import MapView from './MapView'
import Slideshow from './Slideshow'
import Editor from './Editor'
import Lightbox from './Lightbox'
import InfoPanel from './InfoPanel'

declare global {
  interface Window {
    api: RendererApi
  }
}

const PAGE = 10000 // la virtualisation rend l'affichage indolore

const MONTHS_FR = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre']
const monthLabel = (t: number | null): string =>
  t ? `${MONTHS_FR[new Date(t * 1000).getMonth()]} ${new Date(t * 1000).getFullYear()}` : 'Sans date'

type GridRow =
  | { kind: 'header'; label: string; count: number }
  | { kind: 'photos'; label: string; items: { p: PhotoRow; gi: number }[] }
const HEADER_H = 42

/**
 * ThumbImg — <img> qui se re-tente automatiquement si la miniature
 * n'est pas encore disponible (scan en cours, hash en cours de calcul).
 *
 * Backoff: 500 ms → 1 s → 2 s → 4 s → 8 s, puis abandon.
 */
function ThumbImg({
  photoId,
  v,
  size = 256,
  alt,
  style,
  onClick,
  onDoubleClick,
  onContextMenu,
  loading = 'lazy'
}: {
  photoId: number
  v?: string
  size?: number
  alt?: string
  style?: React.CSSProperties
  onClick?: (e: React.MouseEvent) => void
  onDoubleClick?: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  loading?: 'lazy' | 'eager'
}): JSX.Element {
  const [attempt, setAttempt] = useState(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const handleError = () => {
    if (attempt >= 5) return // abandon après 5 essais (~15 s cumulées)
    const delay = 500 * Math.pow(2, attempt)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setAttempt((a) => a + 1), delay)
  }

  // Le paramètre `_retry` force Chromium à recharger l'URL même s'il l'a déjà
  // demandée (paranoia, en complément du Cache-Control: no-store côté main).
  const src = `thumb://library/${size}/${photoId}?v=${v ?? ''}${attempt > 0 ? `&_retry=${attempt}` : ''}`

  return (
    <img
      key={attempt}
      src={src}
      alt={alt}
      loading={loading}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenu?.(e)
      }}
      onError={handleError}
      style={style}
    />
  )
}

const ROW_H = 214 // vignette + nom + étoiles

type View =
  | { type: 'timeline' }
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
  const [dragOverAlbum, setDragOverAlbum] = useState<number | null>(null)
  const [osDragging, setOsDragging] = useState(false)
  const [dupGroups, setDupGroups] = useState<Array<{ hash: string; photos: PhotoRow[] }>>([])
  const [roots, setRoots] = useState<Array<{ id: number; path: string; mode: string }>>([])
  const [privacy, setPrivacy] = useState<{ hasPassword: boolean; unlocked: boolean }>({ hasPassword: false, unlocked: true })
  const [pwInput, setPwInput] = useState('')
  const [websyncUrl, setWebsyncUrl] = useState('')
  const [websyncToken, setWebsyncToken] = useState('')
  const [websyncMsg, setWebsyncMsg] = useState('')
  const [websyncProgress, setWebsyncProgress] = useState<{
    phase: 'checking' | 'metadata' | 'thumbnails' | 'done' | 'error'
    done: number
    total: number
    message?: string
  } | null>(null)
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
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)
  const [cellSize, setCellSize] = useState<number>(() => {
    const v = Number(localStorage.getItem('picalibre.cellSize'))
    return Number.isFinite(v) && v >= 100 && v <= 320 ? v : 160
  })
  type SortMode = 'date_desc' | 'date_asc' | 'name' | 'rating'
  const [sortMode, setSortMode] = useState<SortMode>(
    (localStorage.getItem('picalibre.sort') as SortMode) || 'date_desc'
  )
  const [minStars, setMinStars] = useState<number>(Number(localStorage.getItem('picalibre.minStars')) || 0)
  const [typeFilter, setTypeFilter] = useState<'all' | 'image' | 'video'>(
    (localStorage.getItem('picalibre.typeFilter') as 'all' | 'image' | 'video') || 'all'
  )
  const [fitMode, setFitMode] = useState<'cover' | 'contain'>(
    (localStorage.getItem('picalibre.fit') as 'cover' | 'contain') || 'cover'
  )
  useEffect(() => localStorage.setItem('picalibre.sort', sortMode), [sortMode])
  useEffect(() => localStorage.setItem('picalibre.minStars', String(minStars)), [minStars])
  useEffect(() => localStorage.setItem('picalibre.typeFilter', typeFilter), [typeFilter])
  useEffect(() => localStorage.setItem('picalibre.fit', fitMode), [fitMode])

  /** Photos réellement affichées : filtres + tri appliqués. */
  const shown = useMemo(() => {
    let list = photos
    if (minStars > 0) list = list.filter((p) => p.rating >= minStars)
    if (typeFilter !== 'all') list = list.filter((p) => p.media_type === typeFilter)
    const key = (p: PhotoRow): number => p.taken_at ?? p.file_mtime
    switch (sortMode) {
      case 'date_asc':
        return [...list].sort((a, b) => key(a) - key(b))
      case 'name':
        return [...list].sort((a, b) => a.filename.localeCompare(b.filename, 'fr'))
      case 'rating':
        return [...list].sort((a, b) => b.rating - a.rating || key(b) - key(a))
      default:
        return [...list].sort((a, b) => key(b) - key(a))
    }
  }, [photos, sortMode, minStars, typeFilter])

  const [infoOpen, setInfoOpen] = useState<boolean>(
    localStorage.getItem('picalibre.infoOpen') !== '0'
  )
  useEffect(() => localStorage.setItem('picalibre.cellSize', String(cellSize)), [cellSize])
  useEffect(() => localStorage.setItem('picalibre.infoOpen', infoOpen ? '1' : '0'), [infoOpen])
  const anchorIndex = useRef<number>(-1)
  const photosRef = useRef<PhotoRow[]>([])
  const trayHideRef = useRef<(() => Promise<void>) | null>(null)
  const addFolderRef = useRef<(() => Promise<void>) | null>(null)
  const importRef = useRef<(() => Promise<void>) | null>(null)
  const [update, setUpdate] = useState<{ status: string; version?: string; percent?: number } | null>(null)

  // ---- Tray (bac Picasa) ----
  const [tray, setTray] = useState<Map<number, PhotoRow>>(new Map())
  const [trayName, setTrayName] = useState('')
  const [trayAlbumId, setTrayAlbumId] = useState<number | ''>('')
  const trayIds = useMemo(() => [...tray.keys()], [tray])

  /** Sélection façon explorateur : clic = seule, Ctrl = bascule, Shift = plage. */
  const selectPhoto = (p: PhotoRow, i: number, e: React.MouseEvent): void => {
    if (e.shiftKey && anchorIndex.current >= 0) {
      const [a, b] = [Math.min(anchorIndex.current, i), Math.max(anchorIndex.current, i)]
      setTray((prev) => {
        const next = e.ctrlKey || e.metaKey ? new Map(prev) : new Map<number, PhotoRow>()
        for (let k = a; k <= b; k++) next.set(shown[k].id, shown[k])
        return next
      })
    } else if (e.ctrlKey || e.metaKey) {
      anchorIndex.current = i
      setTray((prev) => {
        const next = new Map(prev)
        next.has(p.id) ? next.delete(p.id) : next.set(p.id, p)
        return next
      })
    } else {
      anchorIndex.current = i
      setTray((prev) =>
        prev.size === 1 && prev.has(p.id) ? new Map() : new Map([[p.id, p]])
      )
    }
  }

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
        : v.type === 'timeline'
          ? window.api.invoke('photos:timeline', { offset: 0, limit: PAGE })
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
    const off2 = window.api.on('library:changed', (ev: unknown) => {
      refreshSidebar()
      const folderIds = (ev as { folderIds?: number[] } | undefined)?.folderIds ?? []
      // Correctif: si l'utilisateur vient d'ajouter un dossier et qu'aucune vue
      // n'est encore sélectionnée, on ouvre automatiquement le 1er dossier
      // touché. Sinon l'utilisateur voit "Sélectionne un dossier..." alors
      // que le scan vient de finir.
      if (
        !viewRef.current &&
        Array.isArray(folderIds) &&
        folderIds.length > 0
      ) {
        loadView({ type: 'folder', id: folderIds[0] })
        return
      }
      if (viewRef.current && viewRef.current.type !== 'map') loadView(viewRef.current)
    })
    const off3 = window.api.on('faces:progress', (p) => {
      setFaceProgress(p.done >= p.total ? null : p)
      if (p.done >= p.total) refreshSidebar()
    })
    const off4 = window.api.on('persons:changed', () => refreshSidebar())
    const offP = window.api.on('photo:action', ({ action, photoId }) => {
      const i = photosRef.current.findIndex((x) => x.id === photoId)
      if (action === 'open' && i >= 0) setLightboxIndex(i)
      if (action === 'edit' && i >= 0) setEditing(photosRef.current[i])
      if (action === 'tagFocus') document.querySelector<HTMLInputElement>('.ft input')?.focus()
      if (action === 'hide') void trayHideRef.current?.()
    })
    window.api.invoke('websync:getConfig', undefined).then((cfg) => {
      if (cfg) {
        setWebsyncUrl(cfg.url)
        setWebsyncToken(cfg.token)
      }
    })
    const offWS = window.api.on('websync:progress', setWebsyncProgress)
    const offM = window.api.on('menu:action', ({ action }) => {
      if (action === 'addFolder') void addFolderRef.current?.()
      if (action === 'import') void importRef.current?.()
    })
    const offU = window.api.on('update:status', (u) => {
      if (u.status === 'error') return
      setUpdate({ status: u.status, version: u.info?.version, percent: u.info?.percent })
    })
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
      offU()
      offM()
      offWS()
      offP()
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
    let audioPaths: string[] = []
    if (wantAudio) {
      audioPaths = await window.api.invoke('dialog:pickFiles', {
        name: 'Audio (sélection multiple = pistes enchaînées)',
        extensions: ['mp3', 'm4a', 'wav', 'ogg', 'flac']
      })
    }
    const transition = confirm('Ajouter des transitions en fondu entre les éléments ?')
      ? ('fade' as const)
      : ('none' as const)
    const outFile = await window.api.invoke('dialog:saveFile', {
      defaultName: 'film.mp4',
      name: 'Vidéo MP4',
      extensions: ['mp4']
    })
    if (!outFile) return
    setMovieBusy(true)
    try {
      const r = await window.api.invoke('create:movie', {
        photoIds: trayIds,
        durationSec: 3,
        audioPaths,
        transition,
        outFile
      })
      alert(`🎬 Film créé (${r.totalDuration.toFixed(1)} s, ${r.segments} segment(s)) : ${outFile}`)
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const inField = (e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT'
      if (editing || lightboxIndex !== null || inField) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        setTray(new Map(shown.map((p) => [p.id, p])))
      } else if (e.key === 'Escape') {
        setTray(new Map())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [photos, editing, lightboxIndex])

  photosRef.current = photos
  trayHideRef.current = trayHide
  addFolderRef.current = addFolder
  importRef.current = runImport

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

  const CELL = cellSize + 12
  const ROW_H = cellSize + 54
  const columns = Math.max(1, Math.floor((gridWidth - 16) / CELL))

  // Lignes groupées par mois : [header, photos, photos, header, …]
  const grouped = sortMode === 'date_desc' || sortMode === 'date_asc'
  const gridRows = useMemo<GridRow[]>(() => {
    const rows: GridRow[] = []
    if (!grouped) {
      for (let j = 0; j < shown.length; j += columns) {
        rows.push({
          kind: 'photos',
          label: '',
          items: shown.slice(j, j + columns).map((p, k) => ({ p, gi: j + k }))
        })
      }
      return rows
    }
    let i = 0
    while (i < shown.length) {
      const label = monthLabel(shown[i].taken_at)
      const start = i
      while (i < shown.length && monthLabel(shown[i].taken_at) === label) i++
      rows.push({ kind: 'header', label, count: i - start })
      for (let j = start; j < i; j += columns) {
        rows.push({
          kind: 'photos',
          label,
          items: shown.slice(j, Math.min(j + columns, i)).map((p, k) => ({ p, gi: j + k }))
        })
      }
    }
    return rows
  }, [shown, columns, grouped])

  const virtualizer = useVirtualizer({
    count: gridRows.length,
    getScrollElement: () => gridRef.current,
    estimateSize: (i) => (gridRows[i]?.kind === 'header' ? HEADER_H : ROW_H),
    overscan: 4
  })
  useEffect(() => {
    virtualizer.measure()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellSize, columns, gridRows.length])

  // Mois « épinglé » = groupe de la première ligne visible
  const firstVisible = virtualizer.getVirtualItems()[0]
  const pinnedMonth =
    grouped && firstVisible && gridRows[firstVisible.index]
      ? (gridRows[firstVisible.index] as GridRow & { label: string }).label
      : null

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

  const onOsDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    setOsDragging(false)
    if (e.dataTransfer.types.includes('application/x-picalibre-ids')) return // drag interne
    const paths = [...e.dataTransfer.files]
      .map((f) => (window.api as unknown as { pathForFile: (f: File) => string }).pathForFile(f))
      .filter(Boolean)
    if (paths.length === 0) return
    const r = await window.api.invoke('import:dropped', { paths })
    const parts: string[] = []
    if (r.addedRoots > 0) parts.push(`${r.addedRoots} dossier(s) ajouté(s) au scan`)
    if (r.imported)
      parts.push(
        `${r.imported.copied} fichier(s) importé(s), ${r.imported.skippedDuplicates} doublon(s) ignoré(s)`
      )
    if (parts.length > 0) alert('📥 ' + parts.join(' · '))
  }

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setOsDragging(true)
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setOsDragging(false)
      }}
      onDrop={onOsDrop}
    >
      {osDragging && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 200,
            background: '#0f172aee',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
            border: '3px dashed #f97316',
            borderRadius: 12,
            margin: 10
          }}
        >
          <div style={{ textAlign: 'center', fontSize: 18 }}>
            📥 Dépose ici
            <div style={{ fontSize: 13, color: '#94a3b8', marginTop: 6 }}>
              Dossiers → ajoutés au scan · Fichiers → import avec choix de destination
            </div>
          </div>
        </div>
      )}
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
            onClick={() => loadView({ type: 'timeline' })}
            style={sidebarItem(view?.type === 'timeline')}
          >
            🕒 Chronologie
          </div>
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
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes('application/x-picalibre-ids')) {
                  e.preventDefault()
                  setDragOverAlbum(a.id)
                }
              }}
              onDragLeave={() => setDragOverAlbum(null)}
              onDrop={async (e) => {
                e.preventDefault()
                setDragOverAlbum(null)
                const raw = e.dataTransfer.getData('application/x-picalibre-ids')
                if (!raw) return
                await window.api.invoke('albums:addPhotos', { albumId: a.id, photoIds: JSON.parse(raw) })
                refreshSidebar()
              }}
              style={{
                ...sidebarItem(view?.type === 'album' && view.id === a.id),
                outline: dragOverAlbum === a.id ? '2px dashed #f97316' : 'none',
                outlineOffset: -2
              }}
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

              <h3 style={{ marginTop: 24 }}>📱 Galerie mobile (web)</h3>
              <p style={{ fontSize: 13, opacity: 0.7 }}>
                Consulte tes photos depuis ton téléphone via un serveur que tu héberges (VPS).
                Seules les miniatures et les métadonnées sont envoyées — jamais les originaux.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 420 }}>
                <input
                  placeholder="https://photos.mondomaine.fr"
                  value={websyncUrl}
                  onChange={(e) => setWebsyncUrl(e.target.value)}
                  style={{ padding: 6, background: '#14171c', border: '1px solid #333', borderRadius: 4, color: '#d7dae0' }}
                />
                <input
                  type="password"
                  placeholder="Jeton d'accès (SYNC_TOKEN du serveur)"
                  value={websyncToken}
                  onChange={(e) => setWebsyncToken(e.target.value)}
                  style={{ padding: 6, background: '#14171c', border: '1px solid #333', borderRadius: 4, color: '#d7dae0' }}
                />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={async () => {
                      setWebsyncMsg('Test en cours…')
                      const r = await window.api.invoke('websync:test', { url: websyncUrl, token: websyncToken })
                      setWebsyncMsg(r.message)
                    }}
                    disabled={!websyncUrl || !websyncToken}
                  >
                    Tester la connexion
                  </button>
                  <button
                    className="primary"
                    onClick={async () => {
                      await window.api.invoke('websync:setConfig', { url: websyncUrl, token: websyncToken })
                      await window.api.invoke('websync:run', undefined)
                    }}
                    disabled={!websyncUrl || !websyncToken || websyncProgress?.phase === 'thumbnails' || websyncProgress?.phase === 'metadata'}
                  >
                    🔄 Synchroniser maintenant
                  </button>
                </div>
                {websyncMsg && <p style={{ fontSize: 12, opacity: 0.8 }}>{websyncMsg}</p>}
                {websyncProgress && (
                  <p style={{ fontSize: 12, opacity: 0.8 }}>
                    {websyncProgress.phase === 'checking' && 'Vérification…'}
                    {websyncProgress.phase === 'thumbnails' && `Envoi des miniatures… ${websyncProgress.done}/${websyncProgress.total}`}
                    {websyncProgress.phase === 'metadata' && `Envoi des métadonnées… ${websyncProgress.done}/${websyncProgress.total}`}
                    {websyncProgress.phase === 'done' && `✅ ${websyncProgress.message ?? `${websyncProgress.done} photo(s) synchronisée(s)`}`}
                    {websyncProgress.phase === 'error' && `❌ ${websyncProgress.message}`}
                  </p>
                )}
                <p style={{ fontSize: 11, opacity: 0.5 }}>
                  Instructions de déploiement du serveur : dossier <code>web-server/</code> du
                  dépôt (Coolify, Docker, ou Node nu).
                </p>
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
                            src={`thumb://library/256/${p.id}?v=${p.hash_xxh3}`}
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
          <>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '6px 16px',
              borderBottom: '1px solid #26334a',
              fontSize: 13,
              flexWrap: 'wrap'
            }}
          >
            <select value={sortMode} onChange={(e) => setSortMode(e.target.value as typeof sortMode)} title="Tri">
              <option value="date_desc">📅 Plus récentes d'abord</option>
              <option value="date_asc">📅 Plus anciennes d'abord</option>
              <option value="name">🔤 Nom</option>
              <option value="rating">⭐ Note</option>
            </select>
            <span title="Note minimale" style={{ letterSpacing: 2, cursor: 'pointer', userSelect: 'none' }}>
              {[1, 2, 3, 4, 5].map((n) => (
                <span
                  key={n}
                  onClick={() => setMinStars(minStars === n ? 0 : n)}
                  style={{ color: n <= minStars ? '#f5c518' : '#475569', fontSize: 15 }}
                >
                  ★
                </span>
              ))}
            </span>
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)} title="Type de média">
              <option value="all">Tous</option>
              <option value="image">🖼 Photos</option>
              <option value="video">🎬 Vidéos</option>
            </select>
            <button
              onClick={() => setFitMode(fitMode === 'cover' ? 'contain' : 'cover')}
              title={fitMode === 'cover' ? 'Vignettes carrées (recadrées) — cliquer pour ratio préservé' : 'Ratio préservé — cliquer pour carrées'}
              style={{ padding: '5px 10px' }}
            >
              {fitMode === 'cover' ? '▣ Carré' : '⬒ Ratio'}
            </button>
            <span style={{ color: '#64748b', marginLeft: 'auto' }}>
              {shown.length}{shown.length !== photos.length ? ` / ${photos.length}` : ''} élément(s)
            </span>
          </div>
          <div style={{ flex: 1, position: 'relative', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div ref={gridRef} style={{ flex: 1, overflow: 'auto', padding: '8px 16px' }}>
            {view === null ? (
              <p style={{ opacity: 0.7 }}>
                Sélectionne un dossier ou un album, ou ajoute un dossier à indexer.
              </p>
            ) : shown.length === 0 ? (
              <p style={{ opacity: 0.6 }}>Aucune photo ici{minStars > 0 || typeFilter !== 'all' ? ' avec ces filtres' : ''}.</p>
            ) : (
              <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                {virtualizer.getVirtualItems().map((row) => {
                  const r = gridRows[row.index]
                  if (!r) return null
                  if (r.kind === 'header') {
                    return (
                      <div
                        key={row.key}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          transform: `translateY(${row.start}px)`,
                          height: HEADER_H,
                          display: 'flex',
                          alignItems: 'flex-end',
                          gap: 8,
                          paddingBottom: 6
                        }}
                      >
                        <span style={{ fontSize: 15, fontWeight: 600, textTransform: 'capitalize' }}>
                          {r.label}
                        </span>
                        <span style={{ fontSize: 12, color: '#94a3b8' }}>{r.count} élément(s)</span>
                        <span style={{ flex: 1, height: 1, background: '#26334a', marginBottom: 5 }} />
                      </div>
                    )
                  }
                  return (
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
                    {r.items
                      .map(({ p, gi }) => {
                        const inTray = tray.has(p.id)
                        return (
                          <figure
                            key={p.id}
                            style={{ margin: 0, position: 'relative' }}
                            draggable
                            onDragStart={(e) => {
                              const ids = tray.has(p.id) ? [...tray.keys()] : [p.id]
                              e.dataTransfer.setData('application/x-picalibre-ids', JSON.stringify(ids))
                              e.dataTransfer.effectAllowed = 'copy'
                            }}
                          >
                            <ThumbImg
                              photoId={p.id}
                              v={p.hash_xxh3}
                              size={256}
                              alt={p.filename}
                              onClick={(e) => selectPhoto(p, gi, e)}
                              onDoubleClick={() => setLightboxIndex(gi)}
                              onContextMenu={() => {
                                if (!tray.has(p.id)) selectPhoto(p, gi, { ctrlKey: false, metaKey: false, shiftKey: false } as React.MouseEvent)
                                void window.api.invoke('context:photoMenu', { photoId: p.id, selectedCount: Math.max(1, tray.size) })
                              }}
                              style={{
                                width: '100%',
                                aspectRatio: '1',
                                objectFit: fitMode,
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
                            {p.media_type === 'video' && (
                              <span
                                style={{
                                  position: 'absolute',
                                  bottom: 42,
                                  left: 6,
                                  background: '#000a',
                                  borderRadius: 4,
                                  padding: '1px 5px',
                                  fontSize: 11
                                }}
                              >
                                🎬{p.duration_ms ? ` ${Math.round(p.duration_ms / 1000)}s` : ''}
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
                  )
                })}
              </div>
            )}
          </div>

            {/* Mois épinglé + curseur de taille, par-dessus la grille */}
            {shown.length > 0 && pinnedMonth && (
              <div
                style={{
                  position: 'absolute',
                  top: 8,
                  left: 24,
                  background: '#0f172acc',
                  border: '1px solid #334155',
                  borderRadius: 999,
                  padding: '3px 12px',
                  fontSize: 12,
                  textTransform: 'capitalize',
                  pointerEvents: 'none',
                  backdropFilter: 'blur(4px)'
                }}
              >
                📅 {pinnedMonth}
              </div>
            )}
            {shown.length > 0 && (
              <div
                style={{
                  position: 'absolute',
                  bottom: 10,
                  right: 20,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  background: '#0f172acc',
                  border: '1px solid #334155',
                  borderRadius: 999,
                  padding: '4px 12px',
                  backdropFilter: 'blur(4px)'
                }}
                title="Taille des vignettes"
              >
                <span style={{ fontSize: 12 }}>🔍</span>
                <input
                  type="range"
                  min={100}
                  max={320}
                  step={10}
                  value={cellSize}
                  onChange={(e) => setCellSize(Number(e.target.value))}
                  style={{ width: 130, padding: 0 }}
                />
              </div>
            )}
          </div>
          </>
          )}
        </main>

        {tray.size === 1 && infoOpen && !editing && lightboxIndex === null && (
          <InfoPanel
            photoId={[...tray.keys()][0]}
            onClose={() => setInfoOpen(false)}
            onShowOnMap={() => loadView({ type: 'map' })}
          />
        )}
      </div>

      {lightboxIndex !== null && shown[lightboxIndex] && !editing && (
        <Lightbox
          photos={shown}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onEdit={(p) => {
            setLightboxIndex(null)
            setEditing(p)
          }}
          onRate={(photoId, rating) => {
            void window.api.invoke('photos:setRating', { photoId, rating })
            setPhotos((prev) => prev.map((x) => (x.id === photoId ? { ...x, rating } : x)))
          }}
        />
      )}
      {editing && <Editor photo={editing} onClose={() => setEditing(null)} />}
      {slideshow && (
        <Slideshow
          photos={tray.size > 0 ? [...tray.values()] : shown}
          onClose={() => setSlideshow(false)}
        />
      )}

      {update && update.status !== 'available' && (
        <div
          style={{
            borderTop: '1px solid #333',
            background: '#1d2d1f',
            padding: '6px 16px',
            fontSize: 13,
            display: 'flex',
            alignItems: 'center',
            gap: 12
          }}
        >
          {update.status === 'downloading' && (
            <span>⬇️ Mise à jour {update.version ?? ''} en téléchargement… {update.percent ?? 0} %</span>
          )}
          {update.status === 'ready' && (
            <>
              <span>✅ PicaLibre {update.version} est prête à être installée.</span>
              <button onClick={() => window.api.invoke('update:install', undefined)}>
                Redémarrer et installer
              </button>
              <button onClick={() => setUpdate(null)} style={{ opacity: 0.7 }}>
                Plus tard (au prochain arrêt)
              </button>
            </>
          )}
        </div>
      )}

      {/* ---- Tray (bac Picasa) ---- */}
      <footer className="ft">
        {tray.size === 0 ? (
          <div className="ftempty">
            <span className="hint">🖱 Clic : sélectionner · Ctrl+clic : ajouter · Shift+clic : plage · Double-clic : afficher · Clic droit : actions</span>
            <button
              onClick={() => setSlideshow(true)}
              disabled={shown.length === 0}
              title="Diaporama de la vue courante"
            >
              ▶ Diaporama
            </button>
          </div>
        ) : (
          <>
            <div className="ftgroup" style={{ maxWidth: 330 }}>
              <span className="traycount">{tray.size}</span>
              <div style={{ display: 'flex', gap: 4, overflow: 'auto' }}>
                {[...tray.values()].slice(0, 6).map((p) => (
                  <img
                    key={p.id}
                    className="traythumb"
                    src={`thumb://library/256/${p.id}?v=${p.hash_xxh3}`}
                    onClick={() => toggleTray(p)}
                    title={`${p.filename} — clic pour retirer`}
                  />
                ))}
                {tray.size > 6 && (
                  <span style={{ fontSize: 12, alignSelf: 'center', color: '#94a3b8' }}>
                    +{tray.size - 6}
                  </span>
                )}
              </div>
              <button className="danger" onClick={() => setTray(new Map())} title="Vider le bac">
                ✕
              </button>
            </div>

            <div className="ftgroup">
              <span className="ftlabel">Organiser</span>
              <input
                placeholder="Nom d'album ou tag…"
                value={trayName}
                onChange={(e) => setTrayName(e.target.value)}
                style={{ width: 150 }}
              />
              <button className="primary" onClick={trayCreateAlbum} disabled={!trayName.trim()}>
                ➕ Album
              </button>
              <button onClick={trayTag} disabled={!trayName.trim()}>
                🏷 Tag
              </button>
              <select
                value={trayAlbumId}
                onChange={(e) => setTrayAlbumId(e.target.value === '' ? '' : Number(e.target.value))}
              >
                <option value="">Album existant…</option>
                {albums.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              <button onClick={trayAddToAlbum} disabled={trayAlbumId === ''}>
                Ajouter
              </button>
            </div>

            <div className="ftgroup">
              <span className="ftlabel">Créer</span>
              <button onClick={() => setSlideshow(true)} title="Diaporama plein écran du bac">
                ▶ Diaporama
              </button>
              <select value={collageLayout} onChange={(e) => setCollageLayout(e.target.value as typeof collageLayout)} title="Disposition du collage">
                <option value="grid">Grille</option>
                <option value="mosaic">Mosaïque</option>
                <option value="row">Bande H</option>
                <option value="column">Bande V</option>
              </select>
              <button onClick={trayCollage} title="Assembler les photos du bac en une image">
                🧩 Collage
              </button>
              <button className="primary" onClick={trayMovie} disabled={movieBusy} title="Film MP4 : photos + vidéos, fondus, musique">
                {movieBusy ? '⏳ Film…' : '🎬 Film'}
              </button>
            </div>

            <div className="ftgroup">
              <span className="ftlabel">Partager</span>
              <select value={exportPreset} onChange={(e) => setExportPreset(Number(e.target.value))} title="Taille d'export">
                <option value={0}>Original</option>
                <option value={2048}>2048 px</option>
                <option value={1600}>1600 px</option>
                <option value={1024}>1024 px</option>
              </select>
              <input
                placeholder="Filigrane…"
                value={watermark}
                onChange={(e) => setWatermark(e.target.value)}
                style={{ width: 100 }}
                title="Texte du filigrane (optionnel)"
              />
              <button onClick={trayExport} title="Exporter les photos (éditions appliquées)">
                💾 Exporter
              </button>
              <button onClick={() => window.api.invoke('photos:print', { photoIds: trayIds, perPage: 4 })} title="Imprimer, 4 par page">
                🖨 Imprimer
              </button>
              <button onClick={() => window.api.invoke('share:email', { photoIds: trayIds })} title="Email avec copies 1600 px">
                ✉ Email
              </button>
              <button onClick={trayCsv} title="Métadonnées en CSV">
                📄 CSV
              </button>
              <button onClick={trayHide} title="Masquer / démasquer">
                {view?.type === 'hidden' ? '👁 Démasquer' : '🙈 Masquer'}
              </button>
            </div>

            {exportProgress && (
              <span style={{ fontSize: 12, color: '#94a3b8', flexShrink: 0 }}>
                {exportProgress.done}/{exportProgress.total}
              </span>
            )}
          </>
        )}
      </footer>
    </div>
  )
}
