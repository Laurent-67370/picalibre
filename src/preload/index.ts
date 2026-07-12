import { contextBridge, ipcRenderer } from 'electron'
import type { RendererApi } from '../shared/ipc'

const api: RendererApi = {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  on: (event, cb) => {
    const listener = (_e: Electron.IpcRendererEvent, data: unknown) =>
      (cb as (d: unknown) => void)(data)
    ipcRenderer.on(event, listener)
    return () => ipcRenderer.removeListener(event, listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
