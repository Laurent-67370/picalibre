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

/** Canaux invoke (requête → réponse) */
export interface IpcInvokeMap {
  'scanRoots:list': { req: void; res: { id: number; path: string; mode: string }[] }
  'scanRoots:add': { req: { path: string; mode?: 'watch' | 'once' }; res: { id: number } }
  'scanRoots:remove': { req: { id: number }; res: void }
  'scan:start': { req: { rootId?: number }; res: { jobId: number } }
  'folders:tree': { req: void; res: FolderRow[] }
  'photos:byFolder': { req: { folderId: number; offset: number; limit: number }; res: PhotoRow[] }
  'photos:setRating': { req: { photoId: number; rating: number }; res: void }
  'dialog:pickFolder': { req: void; res: string | null }
}

/** Canaux d'événements main → renderer */
export interface IpcEventMap {
  'scan:progress': ScanProgress
  'library:changed': { folderIds: number[] }
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
