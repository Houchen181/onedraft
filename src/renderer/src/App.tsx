import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ApprovalRequest, PlatformManifest, Post } from '@shared/types'
import { Assistant } from './Assistant'
import { call, on, useData } from './api'
import { Accounts } from './pages/Accounts'
import { Activity } from './pages/Activity'
import { Compose } from './pages/Compose'
import { Posts } from './pages/Posts'
import { Settings } from './pages/Settings'
import { Ctx, Modal, type AppCtx, type Page } from './ui'

const NAV: [Page, string, string][] = [
  ['compose', '✎', 'Compose'],
  ['posts', '☰', 'Posts'],
  ['accounts', '◎', 'Accounts'],
  ['activity', '↻', 'Activity'],
  ['settings', '⚙', 'Settings']
]

export function App() {
  const [page, setPage] = useState<Page>('compose')
  const [composeId, setComposeId] = useState<string>()
  const [composeKey, setComposeKey] = useState(0)
  const [platforms, setPlatforms] = useState<PlatformManifest[]>([])
  const [toasts, setToasts] = useState<{ id: number; text: string; error?: boolean }[]>([])
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const [collapsed, setCollapsed] = useState(false)
  const [pendingAsk, setPendingAsk] = useState<string>()
  const { data: posts } = useData<Post[]>('posts.list', [], ['posts'])

  const loadPlatforms = useCallback(() => void call<PlatformManifest[]>('platforms').then(setPlatforms), [])
  useEffect(loadPlatforms, [loadPlatforms, page])
  useEffect(
    () =>
      on('approval', (r) => {
        setApprovals((a) => [...a, r as ApprovalRequest])
      }),
    []
  )

  const toast = useCallback((text: string, error?: boolean) => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, text, error }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), error ? 9000 : 4000)
  }, [])

  const ctx: AppCtx = useMemo(
    () => ({
      toast,
      go: (p, postId) => {
        if (p === 'compose') {
          setComposeId(postId)
          setComposeKey((k) => k + 1)
        }
        setPage(p)
      },
      ask: (text) => {
        setCollapsed(false)
        setPendingAsk(text)
      },
      platforms,
      platform: (id) => platforms.find((p) => p.id === id)
    }),
    [toast, platforms]
  )

  const active = (posts ?? []).filter((p) => ['queued', 'publishing', 'partial', 'failed'].includes(p.status)).length
  const approval = approvals[0]
  const answer = (ok: boolean) => {
    void call('approvals.respond', approval.id, ok)
    setApprovals((a) => a.slice(1))
  }

  return (
    <Ctx.Provider value={ctx}>
      <div className="app">
        <nav className="nav">
          <div className="brand">
            <span className="logo" />
            Polycast
          </div>
          {NAV.map(([id, icon, label]) => (
            <button key={id} className={page === id ? 'active' : ''} onClick={() => ctx.go(id)}>
              <span className="icon">{icon}</span>
              {label}
              {id === 'posts' && active > 0 && <span className="count">{active}</span>}
            </button>
          ))}
          <div className="spacer" />
          <div className="faint small" style={{ padding: '0 10px' }}>
            v0.1 · your accounts, your machine
          </div>
        </nav>
        <main className="main">
          {page === 'compose' && <Compose key={composeKey} postId={composeId} onSaved={setComposeId} />}
          {page === 'posts' && <Posts />}
          {page === 'accounts' && <Accounts />}
          {page === 'activity' && <Activity />}
          {page === 'settings' && <Settings />}
        </main>
        <Assistant collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} pending={pendingAsk} onPendingTaken={() => setPendingAsk(undefined)} />
      </div>

      {approval && (
        <Modal>
          <div className="pill accent" style={{ marginBottom: 10 }}>
            {approval.source === 'mcp' ? 'An MCP client' : 'The assistant'} is asking
          </div>
          <h2>{approval.title}</h2>
          <div className="note" style={{ whiteSpace: 'pre-wrap', marginTop: 10 }}>
            {approval.detail}
          </div>
          <div className="actions">
            <button className="btn" onClick={() => answer(false)}>
              Decline
            </button>
            <button className="btn primary" onClick={() => answer(true)}>
              Approve
            </button>
          </div>
        </Modal>
      )}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.error ? 'err' : ''}`} style={{ whiteSpace: 'pre-wrap' }}>
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}
