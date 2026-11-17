// Typed access to the main process.

import { useCallback, useEffect, useRef, useState } from 'react'

type Channel = 'changed' | 'progress' | 'agent' | 'approval' | 'approval-closed' | 'navigate' | 'connect'

interface Bridge {
  call(method: string, ...args: unknown[]): Promise<unknown>
  on(channel: Channel, fn: (payload: unknown) => void): () => void
}

declare global {
  interface Window {
    onedraft: Bridge
  }
}

export async function call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
  try {
    return (await window.onedraft.call(method, ...args)) as T
  } catch (e) {
    const msg = (e as Error).message.replace(/^Error invoking remote method 'call': (Error: )?/, '')
    throw new Error(msg)
  }
}

export const on = (channel: Channel, fn: (payload: unknown) => void) => window.onedraft.on(channel, fn)

/** Load data from the main process and reload when it reports a change of `kind`. */
export function useData<T>(method: string, args: unknown[], kinds: ('posts' | 'accounts' | 'events' | 'projects' | 'inbox' | 'stats' | 'speech' | 'transcripts' | 'update')[] = []) {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<string>()
  const key = JSON.stringify([method, args])
  const keyRef = useRef(key)
  keyRef.current = key
  const load = useCallback(() => {
    call<T>(method, ...args)
      .then((d) => {
        if (keyRef.current === key) {
          setData(d)
          setError(undefined)
        }
      })
      .catch((e: Error) => setError(e.message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  useEffect(() => {
    load()
    if (!kinds.length) return
    return on('changed', (k) => {
      if (kinds.includes(k as 'posts')) load()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load])
  return { data, error, reload: load }
}

export const mediaUrl = (path: string) => `onedraft-media://local/${encodeURIComponent(path)}`

export const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p

export const isVideoPath = (p: string) => /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(p)
