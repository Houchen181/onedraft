import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

const api = {
  call: (method: string, ...args: unknown[]) => ipcRenderer.invoke('call', method, ...args),
  on: (channel: 'changed' | 'progress' | 'agent' | 'approval', fn: (payload: unknown) => void) => {
    const listener = (_e: IpcRendererEvent, payload: unknown) => fn(payload)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  }
}

contextBridge.exposeInMainWorld('onedraft', api)

export type OneDraftBridge = typeof api
