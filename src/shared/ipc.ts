import type { EditStack } from './edit-engine'

/** Mode de tri commun aux requêtes de grille photos. */
export type SortMode = 'date_desc' | 'date_asc' | 'name' | 'rating'

/** Filtre de type média commun aux requêtes de grille photos. */
export type TypeFilter = 'all' | 'image' | 'video'

/** Paramètres de filtrage/tri optionnels pour les requêtes de grille photos.
 *  Déportés du renderer (Array.filter + Array.sort en JS) vers SQL côté main. */
export interface GridFilters {
  minStars?: number
  typeFilter?: TypeFilter
  sortMode?: SortMode
}

/**
 * Contrat IPC typé — source de vérité unique entre main, preload et renderer.
 * Chaque canal déclare son payload de requête et sa réponse.
 */

/**
 * Instantané pré-fusion d'un groupe de doublons — tout ce qu'il faut pour
 * annuler `duplicates:merge` : les lignes déplacées/écrasées, capturées
 * avant mutation. Restauration volontairement pragmatique (façon Picasa,
 * annulation immédiate d'un seul geste) : la photo gardée peut conserver
 * un tag/album « gagné » lors de la fusion même après annulation — sans
 * conséquence, à la différence de la perte de la photo ou de sa note.
 */
export interface MergeSnapshot {
  keepId: number
  /** rating/is_favorite de la photo gardée, avant l'écrasement par MAX(). */
  keepBefore: { rating: number; is_favorite: number }
  removed: Array<{
    id: number
    albumItems: Array<{ album_id: number; position: number; added_at: number }>
    tagIds: number[]
    faceIds: number[]
  }>
}

export interface PhotoRow {
  id: number
  folder_id: number
  filename: string
  filepath: string
  media_type: 'image' | 'video'
  duration_ms: number | null
  hash_xxh3: string
  file_size: number
  file_mtime: number
  width: number | null
  height: number | null
  taken_at: number | null
  gps_lat: number | null
  gps_lon: number | null
  rating: number
  is_favorite: 0 | 1
  caption: string | null
  status: 'active' | 'missing' | 'trashed'
}

export interface FolderRow {
  id: number
  path: string
  parent_id: number | null
  is_hidden: 0 | 1
}

export interface ScanProgress {
  phase: 'walking' | 'hashing' | 'exif' | 'thumbs' | 'done'
  filesFound: number
  filesProcessed: number
  currentPath?: string
}

export interface AlbumRow {
  id: number
  name: string
  kind: 'manual' | 'person' | 'smart'
  count: number
}

export interface FaceLite {
  id: number
  photo_id: number
  bbox_x: number
  bbox_y: number
  bbox_w: number
  bbox_h: number
  confidence: number
  assignment: 'auto' | 'suggested' | 'confirmed' | 'rejected'
}

export interface PersonRow {
  id: number
  name: string | null
  face_count: number
  samplePhotoId: number | null
  bbox_x: number | null
  bbox_y: number | null
  bbox_w: number | null
  bbox_h: number | null
}

export interface GpsPhoto {
  id: number
  filename: string
  gps_lat: number
  gps_lon: number
}

/** Bounding box pour le filtrage géographique. */
export interface BoundingBox {
  south: number // lat min
  west: number  // lon min
  north: number // lat max
  east: number  // lon max
}

/** Résultat du géocoding inverse (Nominatim). */
export interface ReverseGeocodeResult {
  displayName: string
  city?: string
  country?: string
}

export interface TagRow {
  id: number
  name: string
  count: number
}

/** Canaux invoke (requête → réponse) */
export interface IpcInvokeMap {
  'scanRoots:list': { req: void; res: { id: number; path: string; mode: string }[] }
  'scanRoots:add': { req: { path: string; mode?: 'watch' | 'once' }; res: { id: number } }
  'scanRoots:remove': { req: { id: number }; res: void }
  'scan:start': { req: { rootId?: number }; res: { jobId: number } }
  'folders:tree': { req: void; res: FolderRow[] }
  'photos:timeline': { req: { offset: number; limit: number } & GridFilters; res: PhotoRow[] }
  'photos:details': {
    req: { photoId: number }
    res: { photo: PhotoRow; tags: string[]; faces: number; albums: string[] }
  }
  'photos:byFolder': { req: { folderId: number; offset: number; limit: number } & GridFilters; res: PhotoRow[] }
  'photos:byAlbum': { req: { albumId: number; offset: number; limit: number } & GridFilters; res: PhotoRow[] }
  'photos:search': { req: { query: string; offset: number; limit: number } & GridFilters; res: PhotoRow[] }
  'photos:setRating': { req: { photoId: number; rating: number }; res: void }
  'albums:list': { req: void; res: AlbumRow[] }
  'albums:create': { req: { name: string }; res: { id: number } }
  'albums:addPhotos': { req: { albumId: number; photoIds: number[] }; res: void }
  'tags:list': { req: void; res: TagRow[] }
  'tags:addToPhotos': { req: { name: string; photoIds: number[] }; res: void }
  'persons:list': { req: void; res: PersonRow[] }
  'persons:rename': { req: { personId: number; name: string }; res: void }
  'persons:merge': { req: { targetId: number; sourceIds: number[] }; res: void }
  'faces:byPerson': { req: { personId: number }; res: FaceLite[] }
  'faces:confirm': { req: { faceIds: number[] }; res: void }
  'faces:split': { req: { faceIds: number[] }; res: { newPersonId: number | null } }
  'faces:reject': { req: { faceIds: number[] }; res: { newPersonId: number | null } }
  'photos:byPerson': { req: { personId: number; offset: number; limit: number } & GridFilters; res: PhotoRow[] }
  'faces:scan': { req: void; res: { started: boolean } }
  'photos:withGps': { req: void; res: GpsPhoto[] }
  'photos:withGeo': { req: { bbox: BoundingBox } & GridFilters; res: GpsPhoto[] }
  'photos:reverseGeocode': { req: { lat: number; lon: number }; res: ReverseGeocodeResult | null }
  'duplicates:list': { req: void; res: Array<{ hash: string; photos: PhotoRow[] }> }
  'duplicates:merge': { req: { keepId: number; removeIds: number[] }; res: MergeSnapshot }
  'duplicates:undoMerge': { req: MergeSnapshot; res: void }
  'scanRoots:setMode': { req: { id: number; mode: 'watch' | 'once' | 'excluded' }; res: void }
  'library:relocate': { req: { newRoot: string }; res: { markedMissing: number; relinked: number; stillMissing: number } }
  'photos:setHidden': { req: { photoIds: number[]; hidden: boolean }; res: { ok: boolean; error?: string } }
  'photos:hidden': { req: void; res: PhotoRow[] }
  'privacy:status': { req: void; res: { hasPassword: boolean; unlocked: boolean } }
  'privacy:setPassword': { req: { password: string }; res: { ok: boolean; error?: string } }
  'privacy:unlock': { req: { password: string }; res: { ok: boolean } }
  'privacy:lock': { req: void; res: void }
  'export:batch': { req: { photoIds: number[]; destDir: string; maxSize: number | null; quality: number; watermark: string | null }; res: { exported: number; errors: number } }
  'export:metadata': { req: { photoIds: number[]; destFile: string }; res: { rows: number } }
  'photos:print': {
    req: {
      photoIds: number[]
      layout: 'contact' | 'full' | 'grid2x3' | 'grid3x3'
      paperSize: 'A4' | 'A3' | 'Letter' | 'Legal'
      marginMm: number
    }
    res: void
  }
  'share:email': { req: { photoIds: number[] }; res: { dir: string } }
  'photos:email': { req: { photoId: number }; res: { ok: boolean; error?: string } }
  'photos:blogExport': { req: { photoId: number }; res: { ok: boolean; error?: string } }
  'photos:batchExport': {
    req: { photoIds: number[]; maxSize: number | null; format: 'jpeg' | 'webp' | 'png'; quality: number }
    res: { exported: number; errors: number; canceled: boolean }
  }
  'photos:setWallpaper': { req: { photoId: number }; res: { ok: boolean; error?: string } }
  'import:dropped': {
    req: { paths: string[] }
    res: { addedRoots: number; imported: { copied: number; skippedDuplicates: number; errors: number } | null }
  }
  'import:run': { req: { sourceDir: string; destDir: string }; res: { found: number; copied: number; skippedDuplicates: number; errors: number } }
  'photos:setGps': { req: { photoIds: number[]; lat: number; lon: number }; res: void }
  'edits:get': { req: { photoId: number }; res: { stack: EditStack; canUndo: boolean; canRedo: boolean } }
  'edits:save': { req: { photoId: number; stack: EditStack; action: string }; res: { canUndo: boolean; canRedo: boolean } }
  'edits:undo': { req: { photoId: number }; res: { stack: EditStack; canUndo: boolean; canRedo: boolean } }
  'edits:redo': { req: { photoId: number }; res: { stack: EditStack; canUndo: boolean; canRedo: boolean } }
  'edits:export': { req: { photoId: number; format?: 'jpeg' | 'webp' | 'png'; maxSize?: number }; res: { outPath: string | null } }
  'update:install': { req: void; res: void }
  'context:photoMenu': { req: { photoId: number; selectedCount: number }; res: void }
  'websync:getConfig': { req: void; res: { url: string; token: string } | null }
  'websync:setConfig': { req: { url: string; token: string }; res: void }
  'websync:test': { req: { url: string; token: string }; res: { ok: boolean; message: string } }
  'websync:run': { req: void; res: void }
  'dialog:pickFiles': { req: { name: string; extensions: string[] }; res: string[] }
  'dialog:pickFolder': { req: void; res: string | null }
  'dialog:pickFile': { req: { name: string; extensions: string[] }; res: string | null }
  'dialog:saveFile': { req: { defaultName: string; name: string; extensions: string[] }; res: string | null }
  'create:collage': { req: { photoIds: number[]; layout: 'grid' | 'row' | 'column' | 'mosaic'; outFile: string; format?: 'jpeg' | 'webp' | 'png' }; res: { width: number; height: number } }
  'create:movie': { req: { photoIds: number[]; durationSec: number; audioPaths: string[]; transition: 'none' | 'fade'; outFile: string }; res: { totalDuration: number; segments: number } }
}

/** Canaux d'événements main → renderer */
export interface IpcEventMap {
  'websync:progress': {
    phase: 'checking' | 'metadata' | 'thumbnails' | 'done' | 'error'
    done: number
    total: number
    message?: string
  }
  'photo:action': { action: 'open' | 'edit' | 'tagFocus' | 'hide'; photoId: number }
  'menu:action': { action: 'addFolder' | 'import' }
  'update:status': {
    status: 'available' | 'downloading' | 'ready' | 'error'
    info?: { version?: string; percent?: number; message?: string }
  }
  'scan:progress': ScanProgress
  'library:changed': { folderIds: number[] }
  'faces:progress': { done: number; total: number }
  'persons:changed': Record<string, never>
  'import:progress': { done: number; total: number; copied: number; skipped: number }
  'export:progress': { done: number; total: number }
  'batch:progress': { current: number; total: number }
  'movie:progress': { done: number; total: number }
}

export type IpcChannel = keyof IpcInvokeMap
export type IpcEvent = keyof IpcEventMap

/** API exposée au renderer via contextBridge (window.api) */
export interface RendererApi {
  invoke<C extends IpcChannel>(
    channel: C,
    payload: IpcInvokeMap[C]['req']
  ): Promise<IpcInvokeMap[C]['res']>
  on<E extends IpcEvent>(event: E, cb: (data: IpcEventMap[E]) => void): () => void
  platform: NodeJS.Platform
}
