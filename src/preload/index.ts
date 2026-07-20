import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcChannel, IpcEvent, IpcInvokeMap, IpcEventMap, RendererApi } from '../shared/ipc'

/**
 * Allowlist runtime des canaux IPC autorisés côté preload.
 *
 * Le typage TypeScript (RendererApi.invoke<C extends IpcChannel>) restreint
 * déjà à la compilation, mais un renderer compromis ou une extension
 * malveillante pourrait tenter d'appeler un canal non déclaré via
 * window.api.invoke avec un cast. Cette garde runtime empêche tout canal
 * inconnu d'atteindre ipcMain : la promesse est rejetée côté preload.
 *
 * Toute nouvelle entrée dans IpcInvokeMap/IpcEventMap DOIT être ajoutée aux
 * tableaux ci-dessous — la vérification de type `_ExhaustiveInvokeCheck` /
 * `_ExhaustiveEventCheck` échoue à la compilation si une clé est oubliée.
 */
const INVOKE_CHANNELS = [
  'scanRoots:list',
  'scanRoots:add',
  'scanRoots:remove',
  'scanRoots:setMode',
  'scan:start',
  'folders:tree',
  'folders:remove',
  'folders:undoRemove',
  'photos:timeline',
  'photos:details',
  'photos:byFolder',
  'photos:byAlbum',
  'photos:byPerson',
  'photos:search',
  'photos:searchGeo',
  'photos:setRating',
  'photos:setGps',
  'photos:setTrim',
  'photos:setHidden',
  'photos:hidden',
  'photos:trash',
  'photos:undoTrash',
  'photos:trashed',
  'photos:deleteForever',
  'photos:batchRename',
  'photos:undoBatchRename',
  'photos:withGps',
  'photos:withGeo',
  'photos:reverseGeocode',
  'photos:print',
  'photos:email',
  'photos:blogExport',
  'photos:batchExport',
  'photos:setWallpaper',
  'video:extractFrame',
  'albums:list',
  'albums:create',
  'albums:addPhotos',
  'tags:list',
  'tags:addToPhotos',
  'persons:list',
  'persons:rename',
  'persons:merge',
  'faces:byPerson',
  'faces:confirm',
  'faces:split',
  'faces:reject',
  'faces:scan',
  'trips:detect',
  'duplicates:list',
  'duplicates:merge',
  'duplicates:undoMerge',
  'library:relocate',
  'privacy:status',
  'privacy:setPassword',
  'privacy:unlock',
  'privacy:lock',
  'export:batch',
  'export:metadata',
  'share:email',
  'import:dropped',
  'import:run',
  'edits:get',
  'edits:save',
  'edits:undo',
  'edits:redo',
  'edits:batchApply',
  'edits:batchAutoFix',
  'edits:undoBatch',
  'edits:export',
  'update:install',
  'context:photoMenu',
  'websync:getConfig',
  'websync:setConfig',
  'websync:test',
  'websync:run',
  'dialog:pickFiles',
  'dialog:pickFolder',
  'dialog:pickFile',
  'dialog:saveFile',
  'create:collage',
  'create:movie'
] as const satisfies readonly IpcChannel[]

const EVENT_CHANNELS = [
  'websync:progress',
  'photo:action',
  'menu:action',
  'update:status',
  'scan:progress',
  'library:changed',
  'faces:progress',
  'persons:changed',
  'import:progress',
  'export:progress',
  'batch:progress',
  'movie:progress'
] as const satisfies readonly IpcEvent[]

// Garde d'exhaustivité à la compilation : si une clé de IpcInvokeMap manque
// dans INVOKE_CHANNELS, tsc échoue (le type union ne correspond pas).
type _ExhaustiveInvokeCheck = IpcChannel extends (typeof INVOKE_CHANNELS)[number]
  ? (typeof INVOKE_CHANNELS)[number] extends IpcChannel
    ? true
    : never
  : never
const _invokeCheck: _ExhaustiveInvokeCheck = true
type _ExhaustiveEventCheck = IpcEvent extends (typeof EVENT_CHANNELS)[number]
  ? (typeof EVENT_CHANNELS)[number] extends IpcEvent
    ? true
    : never
  : never
const _eventCheck: _ExhaustiveEventCheck = true

const ALLOWED_INVOKE = new Set<string>(INVOKE_CHANNELS)
const ALLOWED_EVENTS = new Set<string>(EVENT_CHANNELS)

function isAllowedInvoke(channel: string): channel is IpcChannel {
  return ALLOWED_INVOKE.has(channel)
}
function isAllowedEvent(event: string): event is IpcEvent {
  return ALLOWED_EVENTS.has(event)
}

// Références pour éviter l'avertissement "unused" si tsc les considère ainsi.
void ({} as IpcInvokeMap)
void ({} as IpcEventMap)
void _invokeCheck
void _eventCheck

const api: RendererApi & { pathForFile: (f: File) => string } = {
  invoke: (channel, payload) => {
    if (!isAllowedInvoke(channel)) {
      // Rejet côté preload : le canal inconnu n'atteint jamais ipcMain.
      return Promise.reject(
        new Error(`IPC invoke canal non autorisé: ${String(channel)}`)
      ) as never
    }
    return ipcRenderer.invoke(channel, payload)
  },
  on: (event, cb) => {
    if (!isAllowedEvent(event)) {
      return () => {}
    }
    const listener = (_e: Electron.IpcRendererEvent, data: unknown) =>
      (cb as (d: unknown) => void)(data)
    ipcRenderer.on(event, listener)
    return () => ipcRenderer.removeListener(event, listener)
  },
  platform: process.platform,
  pathForFile: (f) => webUtils.getPathForFile(f)
}

contextBridge.exposeInMainWorld('api', api)