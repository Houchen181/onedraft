import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

type Channel = 'changed' | 'progress' | 'agent' | 'approval' | 'approval-closed' | 'navigate' | 'connect'
const CHANNELS: Channel[] = ['changed', 'progress', 'agent', 'approval', 'approval-closed', 'navigate', 'connect']

const api = {
  call: (method: string, ...args: unknown[]) => ipcRenderer.invoke('call', method, ...args),
  on: (channel: Channel, fn: (payload: unknown) => void) => {
    if (!CHANNELS.includes(channel)) throw new Error(`Unknown channel ${channel}`)
    const listener = (_e: IpcRendererEvent, payload: unknown) => fn(payload)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  }
}

contextBridge.exposeInMainWorld('onedraft', api)

export type OneDraftBridge = typeof api
