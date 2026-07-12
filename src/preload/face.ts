import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('faceBridge', {
  ready: () => ipcRenderer.send('faces:ready'),
  result: (payload: unknown) => ipcRenderer.send('faces:result', payload),
  error: (message: string) => ipcRenderer.send('faces:error', { message }),
  onDetect: (cb: (photoIds: number[]) => void) =>
    ipcRenderer.on('faces:detect', (_e, { photoIds }) => cb(photoIds))
})
