import type { EditStack } from './edit-engine'

/**
 * Contrat IPC typé — source de vérité unique entre main, preload et renderer.
 * Chaque canal déclare son payload de requête et sa réponse.
 */

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
  'photos:byFolder': { req: { folderId: number; offset: number; limit: number }; res: PhotoRow[] }
  'photos:byAlbum': { req: { albumId: number; offset: number; limit: number }; res: PhotoRow[] }
  'photos:search': { req: { query: string; offset: number; limit: number }; res: PhotoRow[] }
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
  'photos:byPerson': { req: { personId: number; offset: number; limit: number }; res: PhotoRow[] }
  'faces:scan': { req: void; res: { started: boolean } }
  'photos:withGps': { req: void; res: GpsPhoto[] }
  'duplicates:list': { req: void; res: Array<{ hash: string; photos: PhotoRow[] }> }
  'duplicates:merge': { req: { keepId: number; removeIds: number[] }; res: void }
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
  'photos:print': { req: { photoIds: number[]; perPage: 1 | 2 | 4 }; res: void }
  'share:email': { req: { photoIds: number[] }; res: { dir: string } }
  'import:run': { req: { sourceDir: string; destDir: string }; res: { found: number; copied: number; skippedDuplicates: number; errors: number } }
  'photos:setGps': { req: { photoIds: number[]; lat: number; lon: number }; res: void }
  'edits:get': { req: { photoId: number }; res: { stack: EditStack; canUndo: boolean; canRedo: boolean } }
  'edits:save': { req: { photoId: number; stack: EditStack; action: string }; res: { canUndo: boolean; canRedo: boolean } }
  'edits:undo': { req: { photoId: number }; res: { stack: EditStack; canUndo: boolean; canRedo: boolean } }
  'edits:redo': { req: { photoId: number }; res: { stack: EditStack; canUndo: boolean; canRedo: boolean } }
  'edits:export': { req: { photoId: number; format?: 'jpeg' | 'webp' | 'png'; maxSize?: number }; res: { outPath: string | null } }
  'update:install': { req: void; res: void }
  'dialog:pickFiles': { req: { name: string; extensions: string[] }; res: string[] }
  'dialog:pickFolder': { req: void; res: string | null }
  'dialog:pickFile': { req: { name: string; extensions: string[] }; res: string | null }
  'dialog:saveFile': { req: { defaultName: string; name: string; extensions: string[] }; res: string | null }
  'create:collage': { req: { photoIds: number[]; layout: 'grid' | 'row' | 'column' | 'mosaic'; outFile: string }; res: { width: number; height: number } }
  'create:movie': { req: { photoIds: number[]; durationSec: number; audioPaths: string[]; transition: 'none' | 'fade'; outFile: string }; res: { totalDuration: number; segments: number } }
}

/** Canaux d'événements main → renderer */
export interface IpcEventMap {
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
}
