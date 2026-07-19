import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { AlbumRow, FaceLite, FolderRow, MergeSnapshot, PersonRow, PhotoRow, ScanProgress, RendererApi, TripGroup } from '@shared/ipc'
import { useVolatileStore } from './store'
import type { EditStack } from '@shared/edit-engine'
import Lightbox from './Lightbox'
import InfoPanel from './InfoPanel'
import ThumbCanvas from './ThumbCanvas'
import { prefetchBidirectionalThumbs, cleanupPrefetch } from './thumb-prefetch'

// Composants rarement utilisés → chargés à la demande (React.lazy + Suspense)
// pour alléger le bundle initial. MapView notamment entraîne Leaflet (~140 ko)
// qu'on ne veut pas payer au démarrage.
const MapView = lazy(() => import('./MapView'))
const Slideshow = lazy(() => import('./Slideshow'))
const FaceMovie = lazy(() => import('./FaceMovie'))
const Editor = lazy(() => import('./Editor'))
const CollagePreview = lazy(() => import('./CollagePreview'))
const PrintDialog = lazy(() => import('./PrintDialog'))
const HelpCenter = lazy(() => import('./HelpCenter'))
const OnboardingTour = lazy(() => import('./OnboardingTour'))

// Types nommés exportés par les composants lazy — importés comme types purs
// (sans tirer le module au runtime) pour rester compatibles avec React.lazy.
import type { CollageLayout, CollageFormat } from './CollagePreview'
import type { PrintLayout, PaperSize } from './PrintDialog'

/** onboardingDone() — inliné ici (et non importé depuis ./OnboardingTour) pour
 *  éviter de tirer le module complet au démarrage, ce qui annulerait le bénéfice
 *  du React.lazy. Même clé localStorage que dans OnboardingTour.tsx. */
function onboardingDone(): boolean {
  return localStorage.getItem('picalibre.onboarding.done') === '1'
}

declare global {
  interface Window {
    api: RendererApi
  }
}

const PAGE_SIZE = 500 // chargement incrémental : page initiale, puis scroll

/**
 * Overscan adaptatif pour TanStack Virtual.
 * Plus de cœurs CPU = overscan plus élevé pour pré-rendre plus de vignettes
 * hors écran et réduire le scintillement au scroll.
 * - ≤4 cœurs : 4 (défaut, prudent)
 * - 6-8 cœurs : 6
 * - ≥10 cœurs : 8
 */
function computeAdaptiveOverscan(): number {
  const cores = navigator.hardwareConcurrency ?? 4
  if (cores >= 10) return 8
  if (cores >= 6) return 6
  return 4
}

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
  | { type: 'trash' }
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
  // --- États volatiles migrés vers Zustand (store externe) ---
  // Ces états ne touchent pas la grille: les consommer via selectors ciblés
  // (useVolatileStore(s => s.xxx)) évite que leur mutation re-render
  // l'intégralité de App.tsx — et donc la grille, la sidebar et la barre
  // d'outils. On récupère setters et valeurs à l'entrée du composant.
  const renameValue = useVolatileStore(s => s.renameValue)
  const setRenameValue = useVolatileStore(s => s.setRenameValue)
  const [manageFaces, setManageFaces] = useState(false)
  const [faceList, setFaceList] = useState<FaceLite[]>([])
  const [selFaces, setSelFaces] = useState<Set<number>>(new Set())
  const [mergeTarget, setMergeTarget] = useState<number | ''>('')
  const [dragOverAlbum, setDragOverAlbum] = useState<number | null>(null)
  const [osDragging, setOsDragging] = useState(false)
  const [dupGroups, setDupGroups] = useState<Array<{ hash: string; photos: PhotoRow[] }>>([])
  const [roots, setRoots] = useState<Array<{ id: number; path: string; mode: string }>>([])
  const [privacy, setPrivacy] = useState<{ hasPassword: boolean; unlocked: boolean }>({ hasPassword: false, unlocked: true })
  const pwInput = useVolatileStore(s => s.pwInput)
  const setPwInput = useVolatileStore(s => s.setPwInput)
  const websyncUrl = useVolatileStore(s => s.websyncUrl)
  const setWebsyncUrl = useVolatileStore(s => s.setWebsyncUrl)
  const websyncToken = useVolatileStore(s => s.websyncToken)
  const setWebsyncToken = useVolatileStore(s => s.setWebsyncToken)
  const websyncMsg = useVolatileStore(s => s.websyncMsg)
  const setWebsyncMsg = useVolatileStore(s => s.setWebsyncMsg)
  const websyncProgress = useVolatileStore(s => s.websyncProgress)
  const setWebsyncProgress = useVolatileStore(s => s.setWebsyncProgress)
  const [exportPreset, setExportPreset] = useState<number | 0>(0)
  const watermark = useVolatileStore(s => s.watermark)
  const setWatermark = useVolatileStore(s => s.setWatermark)
  const [exportProgress, setExportProgress] = useState<{ done: number; total: number } | null>(null)
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(null)
  const [batchExportOpen, setBatchExportOpen] = useState(false)
  const renameOpen = useVolatileStore(s => s.renameOpen)
  const setRenameOpen = useVolatileStore(s => s.setRenameOpen)
  const renamePattern = useVolatileStore(s => s.renamePattern)
  const setRenamePattern = useVolatileStore(s => s.setRenamePattern)
  const renameStart = useVolatileStore(s => s.renameStart)
  const setRenameStart = useVolatileStore(s => s.setRenameStart)
  const renameBusy = useVolatileStore(s => s.renameBusy)
  const setRenameBusy = useVolatileStore(s => s.setRenameBusy)
  const tripsOpen = useVolatileStore(s => s.tripsOpen)
  const setTripsOpen = useVolatileStore(s => s.setTripsOpen)
  const tripsLoading = useVolatileStore(s => s.tripsLoading)
  const setTripsLoading = useVolatileStore(s => s.setTripsLoading)
  const tripGroups = useVolatileStore(s => s.tripGroups)
  const setTripGroups = useVolatileStore(s => s.setTripGroups)
  const tripsCreating = useVolatileStore(s => s.tripsCreating)
  const setTripsCreating = useVolatileStore(s => s.setTripsCreating)
  const tripsCreateProgress = useVolatileStore(s => s.tripsCreateProgress)
  const setTripsCreateProgress = useVolatileStore(s => s.setTripsCreateProgress)
  const helpOpen = useVolatileStore(s => s.helpOpen)
  const setHelpOpen = useVolatileStore(s => s.setHelpOpen)
  const showTour = useVolatileStore(s => s.showTour)
  const setShowTour = useVolatileStore(s => s.setShowTour)
  const [batchSize, setBatchSize] = useState<number | 0>(0)
  const [batchFormat, setBatchFormat] = useState<'jpeg' | 'webp' | 'png'>('jpeg')
  const [batchQuality, setBatchQuality] = useState(90)
  const [slideshow, setSlideshow] = useState(false)
  const [faceMovieActive, setFaceMovieActive] = useState(false)
  const [faceMovieFaces, setFaceMovieFaces] = useState<FaceLite[]>([])
  const [printDialogOpen, setPrintDialogOpen] = useState(false)
  const [screensaverActive, setScreensaverActive] = useState(false)
  const screensaverEnabled = useVolatileStore(s => s.screensaverEnabled)
  const setScreensaverEnabled = useVolatileStore(s => s.setScreensaverEnabled)
  const screensaverMinutes = useVolatileStore(s => s.screensaverMinutes)
  const setScreensaverMinutes = useVolatileStore(s => s.setScreensaverMinutes)
  const collageLayout = useVolatileStore(s => s.collageLayout)
  const setCollageLayout = useVolatileStore(s => s.setCollageLayout)
  const collagePreview = useVolatileStore(s => s.collagePreview)
  const setCollagePreview = useVolatileStore(s => s.setCollagePreview)
  const collageFormat = useVolatileStore(s => s.collageFormat)
  const setCollageFormat = useVolatileStore(s => s.setCollageFormat)
  const [movieBusy, setMovieBusy] = useState(false)
  const [importProgress, setImportProgress] = useState<{ done: number; total: number; copied: number; skipped: number } | null>(null)
  const [view, setView] = useState<View | null>(null)
  const [photos, setPhotos] = useState<PhotoRow[]>([])
  const [hasMore, setHasMore] = useState(false)
  const loadingMoreRef = useRef(false)
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const searchInput = useVolatileStore(s => s.searchInput)
  const setSearchInput = useVolatileStore(s => s.setSearchInput)
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
  const [theme, setTheme] = useState<'light' | 'dark'>(
    localStorage.getItem('picalibre.theme') === 'dark' ? 'dark' : 'light'
  )
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('picalibre.theme', theme)
  }, [theme])
  useEffect(() => localStorage.setItem('picalibre.sort', sortMode), [sortMode])
  useEffect(() => localStorage.setItem('picalibre.minStars', String(minStars)), [minStars])
  useEffect(() => localStorage.setItem('picalibre.typeFilter', typeFilter), [typeFilter])
  useEffect(() => localStorage.setItem('picalibre.fit', fitMode), [fitMode])
  useEffect(() => localStorage.setItem('picalibre.screensaver.enabled', String(screensaverEnabled)), [screensaverEnabled])
  useEffect(() => localStorage.setItem('picalibre.screensaver.minutes', String(screensaverMinutes)), [screensaverMinutes])

  // Initialisation du tour d'onboarding: le store Zustand ne peut pas appeler
  // onboardingDone() à sa création (il vit hors du cycle React et on veut garder
  // le comportement "n'afficher qu'au premier lancement"). On synchronise donc
  // une fois au montage, dépendances [] pour ne pas re-trigger.
  useEffect(() => {
    if (!onboardingDone()) setShowTour(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Photos réellement affichées : le filtrage (minStars, typeFilter) et le tri
   *  (sortMode) sont maintenant effectués côté SQL par les handlers IPC.
   *  Le renderer reçoit directement les photos dans le bon ordre — plus de
   *  Array.filter ni Array.sort sur 10k lignes en JS. */
  const shown = photos

  const [infoOpen, setInfoOpen] = useState<boolean>(
    localStorage.getItem('picalibre.infoOpen') !== '0'
  )
  useEffect(() => localStorage.setItem('picalibre.cellSize', String(cellSize)), [cellSize])
  useEffect(() => localStorage.setItem('picalibre.infoOpen', infoOpen ? '1' : '0'), [infoOpen])
  const anchorIndex = useRef<number>(-1)
  const photosRef = useRef<PhotoRow[]>([])
  const trayHideRef = useRef<(() => Promise<void>) | null>(null)
  const trayTrashRef = useRef<(() => Promise<void>) | null>(null)
  const addFolderRef = useRef<(() => Promise<void>) | null>(null)
  const importRef = useRef<(() => Promise<void>) | null>(null)
  // Une seule ref regroupant toutes les actions déclenchables depuis le menu
  // applicatif (barre de menus native) — évite de multiplier les refs
  // individuelles pour chaque fonctionnalité exposée. Peuplée plus bas, une
  // fois toutes les fonctions du composant définies.
  const menuActionsRef = useRef<Record<string, () => void>>({})
  const trayNameInputRef = useRef<HTMLInputElement>(null)
  const [update, setUpdate] = useState<{ status: string; version?: string; percent?: number } | null>(null)

  // ---- Screensaver (écran de veille photo) ----
  // Détection d'inactivité : mousemove, keydown, scroll, click resetent le timer.
  // Après N minutes d'inactivité, lance le diaporama plein écran.
  // N'importe quelle interaction quitte le screensaver.
  const screensaverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!screensaverEnabled || screensaverActive) return
    const resetTimer = (): void => {
      if (screensaverTimerRef.current) clearTimeout(screensaverTimerRef.current)
      screensaverTimerRef.current = setTimeout(() => {
        if (photosRef.current.length > 0) {
          setScreensaverActive(true)
        }
      }, screensaverMinutes * 60 * 1000)
    }
    resetTimer()
    const events = ['mousemove', 'keydown', 'scroll', 'click', 'wheel', 'touchstart']
    events.forEach((ev) => window.addEventListener(ev, resetTimer, { passive: true }))
    return () => {
      if (screensaverTimerRef.current) clearTimeout(screensaverTimerRef.current)
      events.forEach((ev) => window.removeEventListener(ev, resetTimer))
    }
  }, [screensaverEnabled, screensaverMinutes, screensaverActive])

  // ---- Tray (bac Picasa) ----
  const [tray, setTray] = useState<Map<number, PhotoRow>>(new Map())
  const [trayName, setTrayName] = useState('')
  const [trayAlbumId, setTrayAlbumId] = useState<number | ''>('')
  const trayIds = useMemo(() => [...tray.keys()], [tray])

  /**
   * Annulation façon Picasa : un seul niveau, la toute dernière action
   * destructive/réversible. Un bandeau "Annuler" apparaît quelques
   * secondes après l'action, et Ctrl/⌘+Z fait la même chose tant qu'il
   * est affiché. Conçu en union discriminée pour pouvoir couvrir d'autres
   * actions plus tard (notation, tag…) sans tout réécrire — seul 'hide'
   * est câblé pour l'instant, l'action la plus fréquente et la plus
   * "silencieusement destructive" (aucune confirmation avant de masquer).
   */
  type LastAction =
    | { type: 'hide'; photoIds: number[]; wasHidden: boolean; label: string }
    | { type: 'trash'; snapshot: MergeSnapshot; label: string }
    | { type: 'batchEdit'; before: Array<{ photoId: number; prevStack: EditStack }>; label: string }
    | {
        type: 'batchRename'
        items: Array<{ id: number; oldPath: string; oldFilename: string; newPath: string; newFilename: string }>
        label: string
      }
    | { type: 'folderRemove'; folderId: number; photoIds: number[]; label: string }
    | { type: 'moveToTrash'; photoIds: number[]; label: string }
    | { type: 'restoreFromTrash'; photoIds: number[]; label: string }
  const [lastAction, setLastAction] = useState<LastAction | null>(null)
  const lastActionTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const armUndo = (action: LastAction): void => {
    setLastAction(action)
    if (lastActionTimer.current) clearTimeout(lastActionTimer.current)
    lastActionTimer.current = setTimeout(() => setLastAction(null), 8000)
  }
  const undoLastAction = async (): Promise<void> => {
    if (!lastAction) return
    if (lastActionTimer.current) clearTimeout(lastActionTimer.current)
    if (lastAction.type === 'hide') {
      await window.api.invoke('photos:setHidden', {
        photoIds: lastAction.photoIds,
        hidden: lastAction.wasHidden
      })
      if (viewRef.current) loadView(viewRef.current)
    } else if (lastAction.type === 'trash') {
      await window.api.invoke('duplicates:undoMerge', lastAction.snapshot)
      window.api.invoke('duplicates:list', undefined).then(setDupGroups)
      refreshSidebar()
      if (viewRef.current) loadView(viewRef.current)
    } else if (lastAction.type === 'batchEdit') {
      await window.api.invoke('edits:undoBatch', lastAction.before)
      if (viewRef.current) loadView(viewRef.current)
    } else if (lastAction.type === 'batchRename') {
      await window.api.invoke('photos:undoBatchRename', lastAction.items)
      if (viewRef.current) loadView(viewRef.current)
    } else if (lastAction.type === 'folderRemove') {
      await window.api.invoke('folders:undoRemove', {
        folderId: lastAction.folderId,
        photoIds: lastAction.photoIds
      })
      window.api.invoke('folders:tree', undefined).then(setFolders)
      if (viewRef.current) loadView(viewRef.current)
    } else if (lastAction.type === 'moveToTrash') {
      await window.api.invoke('photos:undoTrash', { photoIds: lastAction.photoIds })
      refreshSidebar()
      if (viewRef.current) loadView(viewRef.current)
    } else if (lastAction.type === 'restoreFromTrash') {
      await window.api.invoke('photos:trash', { photoIds: lastAction.photoIds })
      refreshSidebar()
      if (viewRef.current) loadView(viewRef.current)
    }
    setLastAction(null)
  }
  useEffect(() => {
    return () => {
      if (lastActionTimer.current) clearTimeout(lastActionTimer.current)
    }
  }, [])

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

  // Refs pour les filtres — permettent à loadView de rester stable ( useCallback
  // sans dépendances) tout en passant les filtres courants aux requêtes SQL.
  // Les filtres sont maintenant appliqués côté SQL (main) au lieu de JS (renderer).
  const minStarsRef = useRef(minStars)
  const typeFilterRef = useRef(typeFilter)
  const sortModeRef = useRef(sortMode)
  minStarsRef.current = minStars
  typeFilterRef.current = typeFilter
  sortModeRef.current = sortMode

  const loadView = useCallback((v: View) => {
    setView(v)
    setManageFaces(false)
    setSelFaces(new Set())
    setHasMore(false)
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
        if (st.unlocked)
          window.api.invoke('photos:hidden', { offset: 0, limit: PAGE_SIZE }).then((r) => {
            setPhotos(r)
            setHasMore(r.length >= PAGE_SIZE)
          })
        else setPhotos([])
      })
      return
    }
    if (v.type === 'trash') {
      window.api.invoke('photos:trashed', { offset: 0, limit: PAGE_SIZE }).then((r) => {
        setPhotos(r)
        setHasMore(r.length >= PAGE_SIZE)
      })
      return
    }
    // Filtres passés au main pour filtrage SQL (minStars, typeFilter) et tri (sortMode)
    const filters = {
      minStars: minStarsRef.current,
      typeFilter: typeFilterRef.current,
      sortMode: sortModeRef.current
    }
    const req =
      v.type === 'folder'
        ? window.api.invoke('photos:byFolder', { folderId: v.id, offset: 0, limit: PAGE_SIZE, ...filters })
        : v.type === 'timeline'
          ? window.api.invoke('photos:timeline', { offset: 0, limit: PAGE_SIZE, ...filters })
        : v.type === 'album'
          ? window.api.invoke('photos:byAlbum', { albumId: v.id, offset: 0, limit: PAGE_SIZE, ...filters })
          : v.type === 'person'
            ? window.api.invoke('photos:byPerson', { personId: v.id, offset: 0, limit: PAGE_SIZE, ...filters })
            : window.api.invoke('photos:search', { query: v.query, offset: 0, limit: PAGE_SIZE, ...filters })
    req.then((result) => {
      setPhotos(result)
      setHasMore(result.length >= PAGE_SIZE)
    })
  }, [])

  /** Charge la page suivante de photos pour la vue courante et les concatène. */
  const loadMore = useCallback(() => {
    const v = viewRef.current
    if (!v || loadingMoreRef.current || !hasMore) return
    const filters = {
      minStars: minStarsRef.current,
      typeFilter: typeFilterRef.current,
      sortMode: sortModeRef.current
    }
    const offset = photosRef.current.length
    let req: Promise<PhotoRow[]>
    if (v.type === 'folder') {
      req = window.api.invoke('photos:byFolder', { folderId: v.id, offset, limit: PAGE_SIZE, ...filters })
    } else if (v.type === 'timeline') {
      req = window.api.invoke('photos:timeline', { offset, limit: PAGE_SIZE, ...filters })
    } else if (v.type === 'album') {
      req = window.api.invoke('photos:byAlbum', { albumId: v.id, offset, limit: PAGE_SIZE, ...filters })
    } else if (v.type === 'person') {
      req = window.api.invoke('photos:byPerson', { personId: v.id, offset, limit: PAGE_SIZE, ...filters })
    } else if (v.type === 'search') {
      req = window.api.invoke('photos:search', { query: v.query, offset, limit: PAGE_SIZE, ...filters })
    } else if (v.type === 'hidden') {
      req = window.api.invoke('photos:hidden', { offset, limit: PAGE_SIZE })
    } else if (v.type === 'trash') {
      req = window.api.invoke('photos:trashed', { offset, limit: PAGE_SIZE })
    } else {
      return
    }
    loadingMoreRef.current = true
    req.then((result) => {
      setPhotos((prev) => prev.concat(result))
      setHasMore(result.length >= PAGE_SIZE)
      loadingMoreRef.current = false
    })
  }, [hasMore])

  const viewRef = useRef<View | null>(null)
  viewRef.current = view

  // Recharger la vue courante quand les filtres/tri changent — les filtres
  // étant maintenant appliqués côté SQL, il faut refaire la requête IPC.
  useEffect(() => {
    if (viewRef.current && !['map', 'duplicates', 'settings', 'hidden', 'trash'].includes(viewRef.current.type)) {
      loadView(viewRef.current)
    }
  }, [minStars, typeFilter, sortMode, loadView])

  // ---- Throttle des handlers library:changed / persons:changed ----
  // Pendant un scan, l'évènement library:changed peut être émis plusieurs
  // fois par seconde. Sans throttle, chaque émission déclenche un
  // refreshSidebar() + setPhotos() → recalcule gridRows (useMemo) et
  // re-rend toute la grille. On amortit à 300 ms (leading + trailing).
  const libraryChangedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    return () => {
      if (libraryChangedTimerRef.current) clearTimeout(libraryChangedTimerRef.current)
    }
  }, [])

  useEffect(() => {
    // Marqueur « leading » : le 1er événement d'une rafale est traité tout de
    // suite, puis on ignore les suivants pendant 300 ms avant un flush
    // final (trailing) pour ne pas rater la dernière mise à jour.
    let lastLibraryFlush = 0
    let pendingLib: {
      folderIds: number[]
      isPersons: boolean
    } | null = null
    const flushLibraryChanged = (info: { folderIds: number[]; isPersons: boolean }) => {
      lastLibraryFlush = Date.now()
      pendingLib = null
      if (info.isPersons) {
        refreshSidebar()
        return
      }
      refreshSidebar()
      const folderIds = info.folderIds
      // Correctif: si l'utilisateur vient d'ajouter un dossier et qu'aucune vue
      // n'est encore sélectionnée, on ouvre automatiquement le 1er dossier
      // touché. Sinon l'utilisateur voit "Sélectionne un dossier..." alors
      // que le scan vient de finir.
      if (!viewRef.current && Array.isArray(folderIds) && folderIds.length > 0) {
        loadView({ type: 'folder', id: folderIds[0] })
        return
      }
      if (viewRef.current && viewRef.current.type !== 'map') loadView(viewRef.current)
    }
    const scheduleLibraryChanged = (info: { folderIds: number[]; isPersons: boolean }) => {
      pendingLib = info
      if (libraryChangedTimerRef.current) clearTimeout(libraryChangedTimerRef.current)
      const elapsed = Date.now() - lastLibraryFlush
      if (elapsed >= 300) {
        // Leading : déclenche immédiatement le 1er évènement
        flushLibraryChanged(info)
        return
      }
      // Trailing : flush final après le reste du délai de 300 ms
      libraryChangedTimerRef.current = setTimeout(() => {
        if (pendingLib) flushLibraryChanged(pendingLib)
      }, 300 - elapsed)
    }

    refreshSidebar()
    const off1 = window.api.on('scan:progress', (p) => {
      setProgress(p)
      if (p.phase === 'done') refreshSidebar()
    })
    const off2 = window.api.on('library:changed', (ev: unknown) => {
      const folderIds = (ev as { folderIds?: number[] } | undefined)?.folderIds ?? []
      scheduleLibraryChanged({ folderIds, isPersons: false })
    })
    const off3 = window.api.on('faces:progress', (p) => {
      setFaceProgress(p.done >= p.total ? null : p)
      if (p.done >= p.total) refreshSidebar()
    })
    const off4 = window.api.on('persons:changed', () => {
      scheduleLibraryChanged({ folderIds: [], isPersons: true })
    })
    const offP = window.api.on('photo:action', ({ action, photoId }) => {
      const i = photosRef.current.findIndex((x) => x.id === photoId)
      if (action === 'open' && i >= 0) setLightboxIndex(i)
      if (action === 'edit' && i >= 0) setEditing(photosRef.current[i])
      if (action === 'tagFocus') document.querySelector<HTMLInputElement>('.ft input')?.focus()
      if (action === 'hide') void trayHideRef.current?.()
      if (action === 'trash') void trayTrashRef.current?.()
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
      else if (action === 'import') void importRef.current?.()
      else menuActionsRef.current[action]?.()
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
    const offBP = window.api.on('batch:progress', (p) => {
      setBatchProgress(p.current >= p.total ? null : p)
    })
    return () => {
      off1()
      off2()
      off3()
      off4()
      off5()
      off6()
      offU()
      offM()
      offWS()
      offP()
      offBP()
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
    const snapshot = await window.api.invoke('duplicates:merge', { keepId, removeIds })
    window.api.invoke('duplicates:list', undefined).then(setDupGroups)
    refreshSidebar()
    armUndo({
      type: 'trash',
      snapshot,
      label: `${removeIds.length} doublon(s) fusionné(s)`
    })
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

  const trayBatchExport = async (): Promise<void> => {
    if (trayIds.length === 0) return
    setBatchExportOpen(true)
  }

  const doBatchExport = async (): Promise<void> => {
    setBatchExportOpen(false)
    setBatchProgress({ current: 0, total: trayIds.length })
    const r = await window.api.invoke('photos:batchExport', {
      photoIds: trayIds,
      maxSize: batchSize === 0 ? null : batchSize,
      format: batchFormat,
      quality: batchQuality
    })
    setBatchProgress(null)
    if (!r.canceled) {
      alert(`Export groupé : ${r.exported} réussie(s), ${r.errors} erreur(s).`)
    }
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

  const trayAutoFix = async () => {
    if (trayIds.length === 0) return
    const r = await window.api.invoke('edits:batchAutoFix', { photoIds: trayIds })
    if (r.before.length > 0) {
      armUndo({
        type: 'batchEdit',
        before: r.before,
        label: `Correction auto appliquée à ${r.before.length} photo(s)${r.failed.length ? ` (${r.failed.length} échec(s))` : ''}`
      })
    } else if (r.failed.length > 0) {
      alert(`Échec sur ${r.failed.length} photo(s) — vignettes pas encore prêtes ?`)
    }
  }

  const trayPasteSettings = async () => {
    if (trayIds.length === 0) return
    const raw = localStorage.getItem('picalibre.clipboardStack')
    if (!raw) {
      alert('Copie d’abord des réglages depuis l’éditeur (bouton « 📋 Copier les réglages »).')
      return
    }
    const stack = JSON.parse(raw) as EditStack
    const r = await window.api.invoke('edits:batchApply', {
      photoIds: trayIds,
      stack,
      action: 'paste_lot'
    })
    armUndo({
      type: 'batchEdit',
      before: r.before,
      label: `Réglages collés sur ${r.before.length} photo(s)`
    })
  }

  const runBatchRename = async () => {
    if (trayIds.length === 0 || renameBusy) return
    setRenameBusy(true)
    try {
      const r = await window.api.invoke('photos:batchRename', {
        photoIds: trayIds,
        pattern: renamePattern,
        startNumber: renameStart
      })
      if (r.renamed.length > 0) {
        armUndo({
          type: 'batchRename',
          items: r.renamed,
          label: `${r.renamed.length} photo(s) renommée(s)${r.errors.length ? ` (${r.errors.length} échec(s))` : ''}`
        })
        if (viewRef.current) loadView(viewRef.current)
        refreshSidebar()
      }
      if (r.errors.length > 0) {
        alert(
          `${r.errors.length} fichier(s) non renommé(s) :\n` +
            r.errors.map((e) => `${e.filename} — ${e.error}`).join('\n')
        )
      }
      setRenameOpen(false)
    } finally {
      setRenameBusy(false)
    }
  }

  /**
   * Lance la détection (lecture seule) sur TOUTE la bibliothèque active —
   * pas seulement la sélection — via le moteur backend (rupture temporelle
   * >2 jours OU géographique >60km, groupes <4 photos ignorés, nommage
   * par géocodage inversé). Ouvre l'écran de review, chaque groupe démarre
   * pré-coché avec le nom suggéré, modifiable avant création réelle.
   */
  const runTripDetection = async () => {
    setTripsOpen(true)
    setTripsLoading(true)
    setTripGroups([])
    try {
      const groups = await window.api.invoke('trips:detect', undefined)
      setTripGroups(groups.map((g) => ({ ...g, included: true, name: g.suggestedName })))
    } finally {
      setTripsLoading(false)
    }
  }

  /**
   * Création réelle des albums confirmés — réutilise intégralement
   * l'outillage albums existant (albums:create + albums:addPhotos), rien
   * de spécifique aux voyages côté base de données.
   */
  const createTripAlbums = async () => {
    const toCreate = tripGroups.filter((g) => g.included && g.name.trim())
    if (toCreate.length === 0 || tripsCreating) return
    setTripsCreating(true)
    setTripsCreateProgress({ done: 0, total: toCreate.length })
    try {
      for (let i = 0; i < toCreate.length; i++) {
        const g = toCreate[i]
        const { id } = await window.api.invoke('albums:create', { name: g.name.trim() })
        await window.api.invoke('albums:addPhotos', { albumId: id, photoIds: g.photoIds })
        setTripsCreateProgress({ done: i + 1, total: toCreate.length })
      }
      refreshSidebar()
      setTripsOpen(false)
      setTripGroups([])
    } finally {
      setTripsCreating(false)
      setTripsCreateProgress(null)
    }
  }

  const trayHide = async () => {
    const hide = view?.type !== 'hidden'
    const ids = [...trayIds]
    const r = await window.api.invoke('photos:setHidden', { photoIds: ids, hidden: hide })
    if (!r.ok) {
      alert('Déverrouille les photos masquées d’abord (⚙ Réglages).')
      return
    }
    armUndo({
      type: 'hide',
      photoIds: ids,
      wasHidden: !hide,
      label: hide
        ? `${ids.length} photo(s) masquée(s)`
        : `${ids.length} photo(s) affichée(s)`
    })
    setTray(new Map())
    if (viewRef.current) loadView(viewRef.current)
  }

  /** Mettre à la corbeille (bac) : réversible, comme trayHide — bandeau
   * "↩ Annuler" pendant 8s, aucune confirmation (cohérent avec le reste
   * de l'app : seule la suppression définitive demande confirmation). */
  const trayTrash = async () => {
    const ids = [...trayIds]
    if (ids.length === 0) return
    await window.api.invoke('photos:trash', { photoIds: ids })
    armUndo({
      type: 'moveToTrash',
      photoIds: ids,
      label: `${ids.length} photo(s)/vidéo(s) mise(s) à la corbeille`
    })
    setTray(new Map())
    refreshSidebar()
    if (viewRef.current) loadView(viewRef.current)
  }

  /** Restaurer depuis la vue Corbeille — réversible aussi (repasse en
   * corbeille via le bandeau Annuler). */
  const trayRestoreFromTrash = async () => {
    const ids = [...trayIds]
    if (ids.length === 0) return
    await window.api.invoke('photos:undoTrash', { photoIds: ids })
    armUndo({
      type: 'restoreFromTrash',
      photoIds: ids,
      label: `${ids.length} photo(s)/vidéo(s) restaurée(s)`
    })
    setTray(new Map())
    refreshSidebar()
    if (viewRef.current) loadView(viewRef.current)
  }

  /** Suppression définitive — irréversible, seule action de la Corbeille
   * qui touche réellement au fichier sur le disque. Confirmation requise. */
  const trayDeleteForever = async () => {
    const ids = [...trayIds]
    if (ids.length === 0) return
    const word = ids.length > 1 ? `ces ${ids.length} photos/vidéos` : 'cette photo/vidéo'
    if (
      !confirm(
        `Supprimer définitivement ${word} ? Le ou les fichiers seront effacés du disque. Cette action est irréversible.`
      )
    )
      return
    const r = await window.api.invoke('photos:deleteForever', { photoIds: ids })
    setTray(new Map())
    refreshSidebar()
    if (viewRef.current) loadView(viewRef.current)
    if (r.errors.length > 0) {
      alert(
        `${r.deleted} supprimée(s). ${r.errors.length} erreur(s) :\n` +
          r.errors.map((e) => `${e.filename} — ${e.error}`).join('\n')
      )
    }
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
    setCollagePreview(true)
  }

  const doCollageExport = async (format: CollageFormat): Promise<void> => {
    if (trayIds.length === 0) return
    const ext = format === 'jpeg' ? 'jpg' : format
    const outFile = await window.api.invoke('dialog:saveFile', {
      defaultName: `collage.${ext}`,
      name: format.toUpperCase(),
      extensions: [ext]
    })
    if (!outFile) return
    const r = await window.api.invoke('create:collage', {
      photoIds: trayIds,
      layout: collageLayout,
      outFile,
      format
    })
    setCollageFormat(format)
    alert(`🧩 Collage ${r.width}×${r.height} créé : ${outFile}`)
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
      if (e.key === 'F1') {
        e.preventDefault()
        setHelpOpen(true)
        return
      }
      if (editing || lightboxIndex !== null || inField) return
      if (e.key === '?') {
        e.preventDefault()
        setHelpOpen(true)
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        setTray(new Map(shown.map((p) => [p.id, p])))
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        if (lastAction) {
          e.preventDefault()
          void undoLastAction()
        }
      } else if (e.key === 'Escape') {
        setTray(new Map())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [photos, editing, lightboxIndex, lastAction])

  photosRef.current = photos
  trayHideRef.current = trayHide
  trayTrashRef.current = trayTrash
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

  // ---- Actions exposées dans le menu applicatif natif ('menu:action') ----
  // Beaucoup de ces fonctionnalités n'étaient auparavant accessibles que via
  // le panier (une fois des photos sélectionnées) ou la barre latérale —
  // invisibles pour qui ne les avait pas déjà découvertes. Le menu les rend
  // désormais toutes trouvables, avec un message clair si une sélection est
  // nécessaire mais absente.
  const needsSelection = (): boolean => {
    if (trayIds.length === 0) {
      alert('Sélectionne d’abord une ou plusieurs photos/vidéos dans la grille (clic, Ctrl+clic pour plusieurs), puis relance cette action.')
      return true
    }
    return false
  }
  menuActionsRef.current = {
    rescan: () => void window.api.invoke('scan:start', {}),
    goSettings: () => loadView({ type: 'settings' }),
    goTimeline: () => loadView({ type: 'timeline' }),
    goMap: () => loadView({ type: 'map' }),
    goDuplicates: () => loadView({ type: 'duplicates' }),
    goHidden: () => loadView({ type: 'hidden' }),
    goTrash: () => loadView({ type: 'trash' }),
    scanFaces: () => {
      void window.api.invoke('faces:scan', undefined).then((r) => {
        if (r.started) setFaceProgress({ done: 0, total: 1 })
      })
    },
    editSelected: () => {
      if (needsSelection()) return
      const p = [...tray.values()][0]
      if (p.media_type === 'video') {
        alert('L’éditeur ne prend pas encore en charge les vidéos — utilise la lecture dans la visionneuse (double-clic).')
        return
      }
      setEditing(p)
    },
    rate0: () => { if (!needsSelection()) trayIds.forEach((id) => void setRating(id, 0)) },
    rate1: () => { if (!needsSelection()) trayIds.forEach((id) => void setRating(id, 1)) },
    rate2: () => { if (!needsSelection()) trayIds.forEach((id) => void setRating(id, 2)) },
    rate3: () => { if (!needsSelection()) trayIds.forEach((id) => void setRating(id, 3)) },
    rate4: () => { if (!needsSelection()) trayIds.forEach((id) => void setRating(id, 4)) },
    rate5: () => { if (!needsSelection()) trayIds.forEach((id) => void setRating(id, 5)) },
    tagSelection: () => {
      if (needsSelection()) return
      trayNameInputRef.current?.focus()
    },
    toggleHideSelection: () => { if (!needsSelection()) void trayHideRef.current?.() },
    trashSelection: () => { if (!needsSelection()) void trayTrashRef.current?.() },
    detectTrips: () => void runTripDetection(),
    createAlbum: () => {
      if (needsSelection()) return
      trayNameInputRef.current?.focus()
    },
    clearSelection: () => setTray(new Map()),
    slideshow: () => {
      if (shown.length === 0) {
        alert('Aucune photo dans la vue courante à faire défiler.')
        return
      }
      setSlideshow(true)
    },
    collage: () => { if (!needsSelection()) void trayCollage() },
    movie: () => { if (!needsSelection()) void trayMovie() },
    print: () => { if (!needsSelection()) setPrintDialogOpen(true) },
    exportSelection: () => { if (!needsSelection()) void trayExport() },
    batchExport: () => { if (!needsSelection()) void trayBatchExport() },
    emailSelection: () => {
      if (needsSelection()) return
      void window.api.invoke('share:email', { photoIds: trayIds })
    },
    csvExport: () => { if (!needsSelection()) void trayCsv() },
    autoFix: () => { if (!needsSelection()) void trayAutoFix() },
    pasteSettings: () => { if (!needsSelection()) void trayPasteSettings() },
    batchRename: () => { if (!needsSelection()) setRenameOpen(true) },
    openHelp: () => setHelpOpen(true),
    replayTour: () => setShowTour(true)
  }

  // ---- Grille virtualisée ----
  const gridRef = useRef<HTMLDivElement>(null)
  const [gridWidth, setGridWidth] = useState(800)
  // La grille (et son ref gridRef) est complètement démontée quand on va
  // dans Réglages ou en gestion des visages d'une personne, puis remontée
  // en revenant — un nouvel élément DOM à chaque fois. Sans dépendre de
  // showingGrid, ce useEffect (déps vides à l'origine) ne s'exécutait
  // qu'au tout premier montage : le ResizeObserver restait attaché à
  // l'ANCIEN élément démonté, gridWidth ne se mettait plus jamais à jour
  // pour le nouveau conteneur.
  const showingGrid = !(view?.type === 'person' && manageFaces) && view?.type !== 'settings'
  useEffect(() => {
    if (!showingGrid) return
    const el = gridRef.current
    if (!el) return
    // Lecture immédiate (pas seulement à la prochaine notification du
    // ResizeObserver) : le nouveau conteneur peut déjà avoir sa taille
    // définitive dès le montage, inutile d'attendre un futur redimensionnement.
    setGridWidth(el.clientWidth)
    const ro = new ResizeObserver(() => setGridWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [showingGrid])

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

  const [adaptiveOverscan] = useState(computeAdaptiveOverscan)

  const virtualizer = useVirtualizer({
    count: gridRows.length,
    getScrollElement: () => gridRef.current,
    estimateSize: (i) => (gridRows[i]?.kind === 'header' ? HEADER_H : ROW_H),
    overscan: adaptiveOverscan
  })
  useEffect(() => {
    virtualizer.measure()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellSize, columns, gridRows.length])

  // La grille (avec son ref gridRef) est complètement démontée quand on va
  // dans Réglages ou en gestion des visages d'une personne (ternaire plus
  // bas), puis remontée en revenant — un nouvel élément DOM, jamais observé
  // par le virtualiseur. Sans ce re-mesurage explicite, le virtualiseur
  // continue d'utiliser ses positions calculées pour l'ANCIEN élément
  // (démonté), désynchronisées du nouveau conteneur qui repart d'un scroll à
  // zéro — d'où les vignettes qui se chevauchent à des positions
  // incohérentes jusqu'à un rechargement manuel.
  useEffect(() => {
    if (showingGrid) virtualizer.measure()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showingGrid])

  // ---- Infinite scroll : charger la page suivante quand on approche du bas ----
  useEffect(() => {
    const el = gridRef.current
    if (!el) return
    const onScroll = (): void => {
      const remaining = el.scrollHeight - el.scrollTop - el.clientHeight
      if (remaining < 500) loadMore()
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [loadMore])

  // ---- Préchargement prédictif (Optimisation 11) ----
  // Au scroll, pré-décode les miniatures des N prochaines lignes (avant et
  // après le viewport) via le Web Worker et les insère dans le cache LRU.
  // Debounce de 150 ms pour éviter de lancer le préchargement à chaque pixel.
  useEffect(() => {
    const el = gridRef.current
    if (!el) return

    let scrollTimer: ReturnType<typeof setTimeout> | null = null

    const triggerPrefetch = (): void => {
      const items = virtualizer.getVirtualItems()
      if (items.length === 0) return
      const visibleStart = items[0].index
      const visibleCount = items.length
      prefetchBidirectionalThumbs(gridRows, visibleStart, visibleCount)
    }

    const onScroll = (): void => {
      if (scrollTimer) clearTimeout(scrollTimer)
      scrollTimer = setTimeout(triggerPrefetch, 150)
    }

    // Préchargement initial (au montage des données)
    triggerPrefetch()

    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (scrollTimer) clearTimeout(scrollTimer)
    }
  }, [virtualizer, gridRows])

  // Nettoyage du Worker de préchargement au démontage
  useEffect(() => {
    return (): void => cleanupPrefetch()
  }, [])

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
            zIndex: 1005,
            background: '#0f172aee',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
            border: '3px dashed var(--accent)',
            borderRadius: 12,
            margin: 10
          }}
        >
          <div style={{ textAlign: 'center', fontSize: 18 }}>
            📥 Dépose ici
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6 }}>
              Dossiers → ajoutés au scan · Fichiers → import avec choix de destination
            </div>
          </div>
        </div>
      )}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* ---- Sidebar ---- */}
        <aside
          data-tour="sidebar-nav"
          style={{
            width: 260,
            borderRight: '1px solid var(--border-soft)',
            padding: 12,
            overflow: 'auto',
            flexShrink: 0
          }}
        >
          <button data-tour="add-folder" onClick={addFolder} style={{ width: '100%', padding: 8, marginBottom: 10 }}>
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
              background: 'var(--card)',
              border: '1px solid var(--border-soft)',
              borderRadius: 4,
              color: 'var(--text)',
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
            onClick={() => loadView({ type: 'trash' })}
            style={sidebarItem(view?.type === 'trash')}
          >
            🗑 Corbeille
          </div>
          <div onClick={() => void runTripDetection()} style={sidebarItem(false)} title="Détecte des groupes de photos par rupture temporelle/géographique sur toute la bibliothèque">
            🧳 Voyages / événements
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
                    background: 'var(--card)',
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
                outline: dragOverAlbum === a.id ? '2px dashed var(--accent)' : 'none',
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
              style={{ display: 'flex', alignItems: 'center', gap: 2 }}
            >
              <div
                onClick={() => loadView({ type: 'folder', id: f.id })}
                title={f.path}
                style={{ ...sidebarItem(view?.type === 'folder' && view.id === f.id), flex: 1, minWidth: 0 }}
              >
                📁 {folderName(f.path)}
              </div>
              <button
                onClick={async (e) => {
                  e.stopPropagation()
                  if (
                    !confirm(
                      `Retirer « ${folderName(f.path)} » de la bibliothèque ?\n\nLes photos de ce dossier disparaîtront de PicaLibre (fichiers intacts sur le disque, annulable juste après). Il ne sera plus réajouté lors des prochains scans.`
                    )
                  )
                    return
                  const r = await window.api.invoke('folders:remove', { folderId: f.id })
                  window.api.invoke('folders:tree', undefined).then(setFolders)
                  if (view?.type === 'folder' && view.id === f.id) loadView({ type: 'timeline' })
                  else if (viewRef.current) loadView(viewRef.current)
                  armUndo({
                    type: 'folderRemove',
                    folderId: f.id,
                    photoIds: r.photoIds,
                    label: `Dossier « ${folderName(f.path)} » retiré (${r.photoIds.length} photo(s))`
                  })
                }}
                title="Retirer ce dossier de la bibliothèque"
                style={{ fontSize: 11, padding: '2px 5px', opacity: 0.6 }}
              >
                🗑
              </button>
            </div>
          ))}
        </aside>

        {/* ---- Zone principale ---- */}
        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {progress && progress.phase !== 'done' && (
            <div style={{ padding: '8px 16px', background: 'var(--card-2)', fontSize: 13 }}>
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
                  background: 'var(--card)',
                  border: '1px solid var(--border-soft)',
                  borderRadius: 4,
                  color: 'var(--text)',
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
              <button
                onClick={async () => {
                  const fl = await window.api.invoke('faces:byPerson', { personId: view.id })
                  setFaceMovieFaces(fl)
                  setFaceMovieActive(true)
                }}
                disabled={photos.length === 0}
                title="Diaporama centré sur le visage de cette personne"
              >
                🎬 Face Movie
              </button>
              <select
                value={mergeTarget}
                onChange={(e) => setMergeTarget(e.target.value === '' ? '' : Number(e.target.value))}
                style={{ padding: 6, background: 'var(--card)', color: 'var(--text)', border: '1px solid var(--border-soft)' }}
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
                      .invoke('photos:byPerson', { personId: view.id, offset: 0, limit: PAGE_SIZE })
                      .then((result) => { setPhotos(result); setHasMore(result.length >= PAGE_SIZE) })
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
                      .invoke('photos:byPerson', { personId: view.id, offset: 0, limit: PAGE_SIZE })
                      .then((result) => { setPhotos(result); setHasMore(result.length >= PAGE_SIZE) })
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
                          background: 'var(--card)',
                          backgroundImage: `url("thumb://library/256/${f.photo_id}")`,
                          backgroundSize: `${100 / f.bbox_w}% ${100 / f.bbox_h}%`,
                          backgroundPosition: `${
                            f.bbox_w < 1 ? (f.bbox_x / (1 - f.bbox_w)) * 100 : 0
                          }% ${f.bbox_h < 1 ? (f.bbox_y / (1 - f.bbox_h)) * 100 : 0}%`,
                          outline: sel
                            ? '3px solid var(--select)'
                            : f.assignment === 'confirmed'
                              ? '2px solid var(--success)'
                              : '1px solid var(--border-soft)',
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
              <h3 style={{ marginTop: 0 }}>🎨 Apparence</h3>
              <p style={{ fontSize: 13, opacity: 0.7 }}>
                Clair : palette inspirée de Picasa 3. Sombre : palette navy/orange historique de PicaLibre.
              </p>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <button
                  className={theme === 'light' ? 'primary' : undefined}
                  onClick={() => setTheme('light')}
                  aria-pressed={theme === 'light'}
                >
                  ☀️ Clair
                </button>
                <button
                  className={theme === 'dark' ? 'primary' : undefined}
                  onClick={() => setTheme('dark')}
                  aria-pressed={theme === 'dark'}
                >
                  🌙 Sombre
                </button>
              </div>

              <h3>Dossiers surveillés</h3>
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

              <h3 style={{ marginTop: 24 }}>🖼️ Écran de veille (diaporama)</h3>
              <p style={{ fontSize: 13, opacity: 0.7 }}>
                Lance automatiquement un diaporama plein écran après une période d'inactivité.
                N'importe quelle interaction (souris, clavier) quitte l'écran de veille.
              </p>
              <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <input
                  type="checkbox"
                  checked={screensaverEnabled}
                  onChange={(e) => setScreensaverEnabled(e.target.checked)}
                />
                Activer l'écran de veille photo
              </label>
              {screensaverEnabled && (
                <label style={{ fontSize: 13, display: 'block', marginBottom: 8 }}>
                  Délai d'inactivité : {screensaverMinutes} minute(s)
                  <input
                    type="range"
                    min={1}
                    max={30}
                    step={1}
                    value={screensaverMinutes}
                    onChange={(e) => setScreensaverMinutes(Number(e.target.value))}
                    style={{ width: '100%' }}
                  />
                </label>
              )}

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
                  style={{ padding: 6, background: 'var(--card)', border: '1px solid var(--border-soft)', borderRadius: 4, color: 'var(--text)' }}
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
                  style={{ padding: 6, background: 'var(--card)', border: '1px solid var(--border-soft)', borderRadius: 4, color: 'var(--text)' }}
                />
                <input
                  type="password"
                  placeholder="Jeton d'accès (SYNC_TOKEN du serveur)"
                  value={websyncToken}
                  onChange={(e) => setWebsyncToken(e.target.value)}
                  style={{ padding: 6, background: 'var(--card)', border: '1px solid var(--border-soft)', borderRadius: 4, color: 'var(--text)' }}
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
                      const cfgR = await window.api.invoke('websync:setConfig', { url: websyncUrl, token: websyncToken })
                      if (!cfgR.ok) {
                        setWebsyncMsg(cfgR.error ?? 'Configuration refusée.')
                        return
                      }
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
                  style={{ padding: 6, background: 'var(--card)', border: '1px solid var(--border-soft)', borderRadius: 4, color: 'var(--text)' }}
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
                      border: '1px solid var(--border-soft)',
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
            <Suspense fallback={null}>
            <MapView
              trayIds={trayIds}
              filters={{ minStars, typeFilter, sortMode }}
              onPhotoClick={async (photoId: number) => {
                // Charger les photos géolocalisées pour la lightbox
                const geoPhotos = await window.api.invoke('photos:withGps', undefined)
                if (geoPhotos.length === 0) return
                // Récupérer les PhotoRow complètes via byFolder n'est pas idéal ;
                // on charge les photos dans `shown` pour la lightbox
                const ids = geoPhotos.map((p) => p.id)
                // Charger les photos par IDs — on utilise photos:search vide
                // qui retourne tout, puis on filtre. Plus simple : on charge
                // la timeline complète et on filtre sur les IDs géolocalisés.
                const all = await window.api.invoke('photos:timeline', {
                  offset: 0,
                  limit: 100000,
                  minStars,
                  typeFilter,
                  sortMode
                })
                const geoIds = new Set(ids)
                const filtered = all.filter((p) => geoIds.has(p.id))
                setPhotos(filtered)
                const idx = filtered.findIndex((p) => p.id === photoId)
                if (idx >= 0) setLightboxIndex(idx)
              }}
              onGeotagged={() => {
                /* les marqueurs se rechargent dans MapView */
              }}
            />
            </Suspense>
          ) : (
          <>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '6px 16px',
              borderBottom: '1px solid var(--border-soft)',
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
                  style={{ color: n <= minStars ? 'var(--star)' : 'var(--border)', fontSize: 15 }}
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
            <span style={{ color: 'var(--muted)', marginLeft: 'auto' }}>
              {shown.length}{shown.length !== photos.length ? ` / ${photos.length}` : ''} élément(s)
            </span>
            <button
              data-tour="help-button"
              onClick={() => setHelpOpen(true)}
              title="Centre d'aide (F1)"
              style={{ padding: '5px 10px' }}
            >
              ❓
            </button>
          </div>
          <div style={{ flex: 1, position: 'relative', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div data-tour="grid" ref={gridRef} style={{ flex: 1, overflow: 'auto', padding: '8px 16px' }}>
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
                        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{r.count} élément(s)</span>
                        <span style={{ flex: 1, height: 1, background: 'var(--border-soft)', marginBottom: 5 }} />
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
                            <ThumbCanvas
                              photoId={p.id}
                              v={p.hash_xxh3}
                              size={256}
                              alt={p.filename}
                              fitMode={fitMode}
                              onClick={(e) => selectPhoto(p, gi, e)}
                              onDoubleClick={() => setLightboxIndex(gi)}
                              onContextMenu={() => {
                                if (!tray.has(p.id)) selectPhoto(p, gi, { ctrlKey: false, metaKey: false, shiftKey: false } as React.MouseEvent)
                                void window.api.invoke('context:photoMenu', { photoId: p.id, selectedCount: Math.max(1, tray.size) })
                              }}
                              style={{
                                width: '100%',
                                aspectRatio: '1',
                                borderRadius: 4,
                                background: 'var(--card)',
                                cursor: 'pointer',
                                outline: inTray ? '3px solid var(--select)' : 'none',
                                outlineOffset: -3,
                                overflow: 'hidden'
                              }}
                            />
                            {inTray && (
                              <span
                                style={{
                                  position: 'absolute',
                                  top: 6,
                                  right: 6,
                                  background: 'var(--select)',
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
                                  style={{ color: n <= p.rating ? 'var(--star)' : 'var(--border)' }}
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
      {editing && (
        <Suspense fallback={null}>
          <Editor photo={editing} onClose={() => setEditing(null)} />
        </Suspense>
      )}
      {faceMovieActive && (
        <Suspense fallback={null}>
          <FaceMovie
            photos={shown}
            faces={faceMovieFaces}
            onClose={() => setFaceMovieActive(false)}
          />
        </Suspense>
      )}
      {slideshow && !screensaverActive && (
        <Suspense fallback={null}>
          <Slideshow
            photos={tray.size > 0 ? [...tray.values()] : shown}
            onClose={() => setSlideshow(false)}
          />
        </Suspense>
      )}

      {screensaverActive && (
        <div
          onMouseMove={() => setScreensaverActive(false)}
          onClick={() => setScreensaverActive(false)}
          onKeyDown={() => setScreensaverActive(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 1045, cursor: 'none' }}
        >
          <Suspense fallback={null}>
            <Slideshow
              photos={photosRef.current}
              onClose={() => setScreensaverActive(false)}
            />
          </Suspense>
        </div>
      )}

      {collagePreview && (
        <Suspense fallback={null}>
          <CollagePreview
            photos={tray.size > 0 ? [...tray.values()] : shown}
            layout={collageLayout}
            onClose={() => setCollagePreview(false)}
            onExport={doCollageExport}
          />
        </Suspense>
      )}

      {update && update.status !== 'available' && (
        <div
          style={{
            borderTop: '1px solid var(--border-soft)',
            background: 'color-mix(in srgb, var(--success) 18%, var(--card))',
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
          {update.status === 'ready' && window.api.platform === 'darwin' && (
            <>
              <span>
                ⬇️ PicaLibre {update.version} est disponible. L'installation automatique n'est pas
                possible sans certificat Apple payant — la page de téléchargement va s'ouvrir.
              </span>
              <button onClick={() => window.api.invoke('update:install', undefined)}>
                Ouvrir la page de téléchargement
              </button>
              <button onClick={() => setUpdate(null)} style={{ opacity: 0.7 }}>
                Plus tard
              </button>
            </>
          )}
          {update.status === 'ready' && window.api.platform !== 'darwin' && (
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

      {/* ---- Annulation façon Picasa (un seul niveau, ~8s) ---- */}
      {lastAction && (
        <div
          style={{
            position: 'fixed',
            bottom: 74,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 1072,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            background: 'var(--card)',
            border: '1px solid var(--border)',
            borderRadius: 999,
            padding: '8px 10px 8px 18px',
            boxShadow: '0 8px 24px var(--shadow)',
            fontSize: 13
          }}
        >
          <span>{lastAction.label}</span>
          <button className="primary" onClick={() => void undoLastAction()} title="Ctrl/⌘+Z">
            ↩ Annuler
          </button>
        </div>
      )}

      {/* ---- Tray (bac Picasa) ---- */}
      <footer className="ft" data-tour="tray">
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
                  <span style={{ fontSize: 12, alignSelf: 'center', color: 'var(--muted)' }}>
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
                ref={trayNameInputRef}
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
              <button onClick={trayBatchExport} title="Export groupé avec choix taille/format/qualité">
                📤 Export groupé
              </button>
              <button onClick={() => setPrintDialogOpen(true)} title="Imprimer avec choix du format et du layout">
                🖨 Imprimer
              </button>
              <button onClick={() => window.api.invoke('share:email', { photoIds: trayIds })} title="Email avec copies 1600 px">
                ✉ Email
              </button>
              <button onClick={trayCsv} title="Métadonnées en CSV">
                📄 CSV
              </button>
              <button onClick={trayAutoFix} title="Contraste + couleur calculés individuellement pour chaque photo (façon Picasa)">
                🪄 Correction auto
              </button>
              <button
                onClick={trayPasteSettings}
                disabled={!localStorage.getItem('picalibre.clipboardStack')}
                title="Colle les réglages copiés depuis l'éditeur (tuning, filtre, vignette, cadre) sur toute la sélection"
              >
                📥 Coller réglages
              </button>
              <button onClick={() => setRenameOpen(true)} title="Renommer tous les fichiers sélectionnés selon un modèle">
                ✏️ Renommer
              </button>
              <button onClick={trayHide} title="Masquer / démasquer">
                {view?.type === 'hidden' ? '👁 Démasquer' : '🙈 Masquer'}
              </button>
              {view?.type === 'trash' ? (
                <>
                  <button onClick={trayRestoreFromTrash} title="Restaurer depuis la corbeille">
                    ♻ Restaurer
                  </button>
                  <button
                    onClick={trayDeleteForever}
                    title="Supprimer définitivement du disque (irréversible)"
                    style={{ color: '#f87171' }}
                  >
                    ⛔ Supprimer définitivement
                  </button>
                </>
              ) : (
                <button onClick={trayTrash} title="Mettre à la corbeille (récupérable ensuite)">
                  🗑 Corbeille
                </button>
              )}
            </div>

            {exportProgress && (
              <span style={{ fontSize: 12, color: 'var(--muted)', flexShrink: 0 }}>
                {exportProgress.done}/{exportProgress.total}
              </span>
            )}
          </>
        )}
      </footer>

      {/* ---- Dialogue d'impression ---- */}
      {printDialogOpen && (
        <Suspense fallback={null}>
          <PrintDialog
            photos={tray.size > 0 ? [...tray.values()] : shown}
            onClose={() => setPrintDialogOpen(false)}
            onPrint={(layout: PrintLayout, paperSize: PaperSize, marginMm: number) => {
              const ids = tray.size > 0 ? trayIds : shown.map((p) => p.id)
              window.api.invoke('photos:print', { photoIds: ids, layout, paperSize, marginMm })
              setPrintDialogOpen(false)
            }}
          />
        </Suspense>
      )}

      {/* ---- Dialogue d'options pour l'export groupé ---- */}
      {batchExportOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1070,
            background: '#0f172acc',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
          onClick={() => setBatchExportOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--card)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              padding: 24,
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
              minWidth: 360
            }}
          >
            <h3 style={{ margin: 0 }}>📤 Export groupé ({trayIds.length} photo(s))</h3>
            <label style={{ fontSize: 13, display: 'flex', flexDirection: 'column', gap: 6 }}>
              Taille
              <select
                value={batchSize}
                onChange={(e) => setBatchSize(Number(e.target.value))}
              >
                <option value={0}>Original</option>
                <option value={1920}>1920 px</option>
                <option value={1024}>1024 px</option>
                <option value={800}>800 px</option>
              </select>
            </label>
            <label style={{ fontSize: 13, display: 'flex', flexDirection: 'column', gap: 6 }}>
              Format
              <select
                value={batchFormat}
                onChange={(e) => setBatchFormat(e.target.value as 'jpeg' | 'webp' | 'png')}
              >
                <option value="jpeg">JPEG</option>
                <option value="webp">WebP</option>
                <option value="png">PNG</option>
              </select>
            </label>
            <label style={{ fontSize: 13, display: 'flex', flexDirection: 'column', gap: 6 }}>
              Qualité : {batchQuality}
              <input
                type="range"
                min={50}
                max={100}
                step={5}
                value={batchQuality}
                onChange={(e) => setBatchQuality(Number(e.target.value))}
              />
            </label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setBatchExportOpen(false)}>Annuler</button>
              <button className="primary" onClick={doBatchExport}>
                Choisir le dossier et exporter
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- Renommage en lot ---- */}
      {renameOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1071,
            background: '#0f172acc',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
          onClick={() => !renameBusy && setRenameOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--card)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              padding: 24,
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
              minWidth: 400
            }}
          >
            <h3 style={{ margin: 0 }}>✏️ Renommer en lot ({trayIds.length} fichier(s))</h3>
            <label style={{ fontSize: 13, display: 'flex', flexDirection: 'column', gap: 6 }}>
              Modèle
              <input
                value={renamePattern}
                onChange={(e) => setRenamePattern(e.target.value)}
                placeholder="{name}"
              />
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                {'{n}'} = numéro séquentiel · {'{name}'} = nom d'origine · {'{date}'} = date de prise de vue
              </span>
            </label>
            <label style={{ fontSize: 13, display: 'flex', flexDirection: 'column', gap: 6 }}>
              Numéro de départ
              <input
                type="number"
                min={0}
                value={renameStart}
                onChange={(e) => setRenameStart(Number(e.target.value))}
                style={{ width: 100 }}
              />
            </label>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              Aperçu :
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {[...tray.values()].slice(0, 3).map((p, i) => {
                  const ext = p.filename.slice(p.filename.lastIndexOf('.'))
                  const base = p.filename.slice(0, p.filename.lastIndexOf('.'))
                  const date = p.taken_at
                    ? new Date(p.taken_at * 1000).toISOString().slice(0, 10)
                    : '????-??-??'
                  const n = String(renameStart + i).padStart(3, '0')
                  const preview =
                    renamePattern.replace(/\{n\}/g, n).replace(/\{name\}/g, base).replace(/\{date\}/g, date) +
                    ext
                  return (
                    <li key={p.id}>
                      {p.filename} → <strong>{preview}</strong>
                    </li>
                  )
                })}
                {tray.size > 3 && <li>… et {tray.size - 3} autre(s)</li>}
              </ul>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setRenameOpen(false)} disabled={renameBusy}>
                Annuler
              </button>
              <button className="primary" onClick={runBatchRename} disabled={renameBusy || !renamePattern.trim()}>
                {renameBusy ? 'Renommage…' : 'Renommer'}
              </button>
            </div>
          </div>
        </div>
      )}

      {helpOpen && (
        <Suspense fallback={null}>
          <HelpCenter onClose={() => setHelpOpen(false)} onNavigate={(view) => loadView({ type: view })} />
        </Suspense>
      )}

      {/* ---- Détection de voyages / événements ---- */}
      {tripsOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1071,
            background: '#0f172acc',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
          onClick={() => !tripsCreating && setTripsOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--card)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              padding: 24,
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
              minWidth: 460,
              maxWidth: 620,
              maxHeight: '80vh',
              overflowY: 'auto'
            }}
          >
            <h3 style={{ margin: 0 }}>🧳 Voyages / événements détectés</h3>
            {tripsLoading && (
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                🔍 Analyse de la bibliothèque en cours (chronologie + position + géocodage)…
              </div>
            )}
            {!tripsLoading && tripGroups.length === 0 && (
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                Aucun groupe détecté. Un voyage/événement nécessite au moins 4 photos séparées de
                moins de 2 jours et 60 km des voisines les plus proches dans la chronologie.
              </div>
            )}
            {!tripsLoading && tripGroups.length > 0 && (
              <>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {tripGroups.length} groupe(s) détecté(s) — décoche ou renomme avant de créer les
                  albums, rien n'est modifié tant que tu ne cliques pas sur « Créer ».
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {tripGroups.map((g, i) => {
                    const fmt = (ts: number): string =>
                      new Date(ts * 1000).toLocaleDateString('fr-FR', {
                        day: '2-digit',
                        month: 'short',
                        year: 'numeric'
                      })
                    return (
                      <div
                        key={i}
                        style={{
                          padding: '10px 12px',
                          borderRadius: 8,
                          background: 'var(--bg-elevated)',
                          border: '1px solid var(--border)',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 6,
                          opacity: g.included ? 1 : 0.5
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <input
                            type="checkbox"
                            checked={g.included}
                            onChange={(e) =>
                              setTripGroups((prev) =>
                                prev.map((x, xi) => (xi === i ? { ...x, included: e.target.checked } : x))
                              )
                            }
                          />
                          <input
                            value={g.name}
                            onChange={(e) =>
                              setTripGroups((prev) =>
                                prev.map((x, xi) => (xi === i ? { ...x, name: e.target.value } : x))
                              )
                            }
                            disabled={!g.included}
                            style={{ flex: 1, fontSize: 13 }}
                          />
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--muted)', paddingLeft: 24 }}>
                          {fmt(g.startDate)}
                          {g.startDate !== g.endDate ? ` → ${fmt(g.endDate)}` : ''} ·{' '}
                          <strong style={{ color: 'var(--accent)' }}>{g.count} photo(s)</strong>
                          {g.city ? ` · 📍 ${g.city}` : ''}
                        </div>
                      </div>
                    )
                  })}
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
                  {tripsCreateProgress && (
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                      Création… {tripsCreateProgress.done}/{tripsCreateProgress.total}
                    </span>
                  )}
                  <button onClick={() => setTripsOpen(false)} disabled={tripsCreating}>
                    Annuler
                  </button>
                  <button
                    className="primary"
                    onClick={createTripAlbums}
                    disabled={tripsCreating || tripGroups.filter((g) => g.included && g.name.trim()).length === 0}
                    title="Créer un album pour chaque groupe coché"
                  >
                    📁 Créer {tripGroups.filter((g) => g.included && g.name.trim()).length} album(s)
                  </button>
                </div>
              </>
            )}
            {!tripsLoading && tripGroups.length === 0 && (
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button onClick={() => setTripsOpen(false)}>Fermer</button>
              </div>
            )}
          </div>
        </div>
      )}

      {showTour && (
        <Suspense fallback={null}>
          <OnboardingTour onFinish={() => setShowTour(false)} />
        </Suspense>
      )}

      {/* ---- Barre de progression de l'export groupé ---- */}
      {batchProgress && (
        <div
          style={{
            position: 'fixed',
            bottom: 0,
            left: 0,
            right: 0,
            zIndex: 1073,
            background: 'var(--bg-elevated)',
            borderTop: '1px solid var(--border)',
            padding: '10px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            fontSize: 13
          }}
        >
          <span>📤 Export groupé…</span>
          <div
            style={{
              flex: 1,
              height: 8,
              background: 'var(--bg)',
              borderRadius: 4,
              overflow: 'hidden'
            }}
          >
            <div
              style={{
                width: `${batchProgress.total > 0 ? (batchProgress.current / batchProgress.total) * 100 : 0}%`,
                height: '100%',
                background: 'var(--accent)',
                borderRadius: 4,
                transition: 'width 0.2s ease'
              }}
            />
          </div>
          <span style={{ color: 'var(--muted)' }}>
            {batchProgress.current}/{batchProgress.total}
          </span>
        </div>
      )}
    </div>
  )
}
