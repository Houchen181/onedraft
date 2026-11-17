import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Account, ApprovalRequest, InboxStatus, PlatformManifest, Post, UpdateStatus } from '@shared/types'
import { call, on, useData } from './api'
import { Calendar } from './pages/Calendar'
import { Chat } from './pages/Chat'
import { Inbox } from './pages/Inbox'
import { PostEditor } from './pages/PostEditor'
import { Posts } from './pages/Posts'
import { Settings } from './pages/Settings'
import { Studio } from './pages/Studio'
import { Ctx, Modal, type AppCtx, type Page } from './ui'

const NAV: [Page, string, string][] = [
  ['chat', '✦', 'Chat'],
  ['posts', '✎', 'Posts'],
  ['inbox', '✉', 'Inbox'],
  ['calendar', '▦', 'Calendar'],
  ['studio', '▶', 'Studio']
]
const PAGES: Page[] = ['chat', 'posts', 'post', 'inbox', 'calendar', 'studio', 'settings']

export function App() {
  const [page, setPage] = useState<Page>('chat')
  const [postId, setPostId] = useState<string>()
  const [inboxPost, setInboxPost] = useState<string>()
  const [postKey, setPostKey] = useState(0)
  const [seedMedia, setSeedMedia] = useState<string[]>()
  const [studioSeed, setStudioSeed] = useState<string>()
  const [platforms, setPlatforms] = useState<PlatformManifest[]>([])
  const [toasts, setToasts] = useState<{ id: number; text: string; error?: boolean }[]>([])
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const [pendingAsk, setPendingAsk] = useState<string>()
  const [assistantBusy, setAssistantBusy] = useState(false)
  const { data: accounts } = useData<Account[]>('accounts.list', [], ['accounts'])
  const { data: posts } = useData<Post[]>('posts.list', [], ['posts'])
  const { data: profile } = useData<{ values: Record<string, unknown> }>('settings.get', [], ['accounts'])
  const { data: inbox } = useData<InboxStatus>('inbox.status', [], ['inbox', 'accounts'])
  const { data: update } = useData<UpdateStatus>('update.status', [], ['update'])

  const loadPlatforms = useCallback(() => void call<PlatformManifest[]>('platforms').then(setPlatforms), [])
  useEffect(loadPlatforms, [loadPlatforms, page])
  useEffect(() => on('changed', (k) => k === 'platforms' && loadPlatforms()), [loadPlatforms])
  // A desktop notification was clicked (e.g. new comments): show that page, also when it opened this window.
  useEffect(() => {
    const show = (p: unknown) => {
      if (!PAGES.includes(p as Page) || p === 'post') return
      setInboxPost(undefined)
      setPage(p as Page)
    }
    void call<string | undefined>('app.takePage').then(show)
    return on('navigate', show)
  }, [])
  useEffect(() => {
    // Cards still waiting (e.g. after a reload), new ones as they come, and ones that expired or were answered.
    void call<ApprovalRequest[]>('approvals.list').then((list) => setApprovals((a) => [...a, ...list.filter((r) => !a.some((x) => x.id === r.id))]))
    const offNew = on('approval', (r) => setApprovals((a) => (a.some((x) => x.id === (r as ApprovalRequest).id) ? a : [...a, r as ApprovalRequest])))
    const offClosed = on('approval-closed', (id) => setApprovals((a) => a.filter((x) => x.id !== id)))
    return () => {
      offNew()
      offClosed()
    }
  }, [])
  // A double click must not approve the next card unread: buttons wake up a moment after a card appears.
  // Armed per card id, so a new card is never clickable until its own delay has passed.
  const [armedFor, setArmedFor] = useState<string>()
  const shownId = approvals[0]?.id
  const armed = !!shownId && armedFor === shownId
  useEffect(() => {
    if (!shownId) return
    const t = setTimeout(() => setArmedFor(shownId), 700)
    return () => clearTimeout(t)
  }, [shownId])
  useEffect(() => {
    void call<{ busy: boolean }>('agent.history').then((h) => setAssistantBusy(h.busy))
    return on('agent', (e) => {
      const ev = e as { type: string; busy?: boolean }
      if (ev.type === 'busy') setAssistantBusy(!!ev.busy)
    })
  }, [])

  const toast = useCallback((text: string, error?: boolean) => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, text, error }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), error ? 9000 : 4000)
  }, [])

  const ctx: AppCtx = useMemo(
    () => ({
      toast,
      go: (p, id) => {
        if (p === 'post') {
          setPostId(id)
          setSeedMedia(undefined)
          setPostKey((k) => k + 1)
        }
        if (p === 'inbox') setInboxPost(id)
        setPage(p)
      },
      ask: (text, opts) => {
        if (opts?.background) {
          call('agent.send', text).then(
            () => toast('Claude is on it — you can keep working.'),
            (e: Error) => toast(e.message, true)
          )
        } else {
          setPendingAsk(text)
          setPage('chat')
        }
      },
      newPost: (media) => {
        setPostId(undefined)
        setSeedMedia(media)
        setPostKey((k) => k + 1)
        setPage('post')
      },
      openStudio: (path) => {
        setStudioSeed(path)
        setPage('studio')
      },
      platforms,
      platform: (id) => platforms.find((p) => p.id === id),
      accounts: accounts ?? [],
      accountFor: (platform) => (accounts ?? []).find((a) => a.platform === platform),
      assistantBusy
    }),
    [toast, platforms, accounts, assistantBusy]
  )

  const active = (posts ?? []).filter((p) => ['queued', 'publishing', 'partial', 'failed'].includes(p.status)).length
  const approval = approvals[0]
  const answer = (ok: boolean) => {
    if (!armed) return
    const id = approval.id
    setApprovals((a) => a.filter((x) => x.id !== id))
    call('approvals.respond', id, ok).catch((e: Error) => toast(e.message, true))
  }
  const name = String(profile?.values['profile.name'] ?? '') || accounts?.[0]?.name || 'You'
  const connected = accounts?.filter((a) => a.status === 'connected').length ?? 0

  return (
    <Ctx.Provider value={ctx}>
      <div className="app">
        <aside className="side">
          <div className="me">
            <span className="logo">{name.slice(0, 1).toUpperCase()}</span>
            <div style={{ minWidth: 0 }}>
              <b>{name}</b>
              <small>
                {connected} platform{connected === 1 ? '' : 's'}
              </small>
            </div>
          </div>
          {NAV.map(([id, icon, label]) => (
            <button key={id} className={`nav ${page === id || (id === 'posts' && page === 'post') ? 'on' : ''}`} onClick={() => ctx.go(id)}>
              <span className="ico">{icon}</span>
              {label}
              {id === 'chat' && assistantBusy && <span className="pulse" title="Claude is working" />}
              {id === 'posts' && active > 0 && <span className="count">{active}</span>}
              {id === 'inbox' && (inbox?.open ?? 0) > 0 && (
                <span className="count new" title={`${inbox!.open} comment${inbox!.open === 1 ? '' : 's'} to answer`}>
                  {inbox!.open}
                </span>
              )}
            </button>
          ))}
          <div className="spacer" />
          {update?.state === 'ready' && (
            <button
              className="nav update"
              title={`Install OneDraft ${update.version} and start it again`}
              onClick={() => call('update.install').catch((e: Error) => toast(e.message, true))}
            >
              <span className="ico">⟳</span>Restart to update
            </button>
          )}
          <button className={`nav ${page === 'settings' ? 'on' : ''}`} onClick={() => ctx.go('settings')}>
            <span className="ico">⚙</span>Settings
          </button>
        </aside>
        <main className="main">
          {page === 'chat' && <Chat pending={pendingAsk} onPendingTaken={() => setPendingAsk(undefined)} />}
          {page === 'posts' && <Posts />}
          {page === 'post' && <PostEditor key={postKey} postId={postId} seedMedia={seedMedia} onCreated={setPostId} />}
          {page === 'inbox' && <Inbox postFilter={inboxPost} onClearFilter={() => setInboxPost(undefined)} />}
          {page === 'calendar' && <Calendar />}
          {page === 'studio' && <Studio seed={studioSeed} onSeedTaken={() => setStudioSeed(undefined)} />}
          {page === 'settings' && <Settings />}
        </main>
      </div>

      {approval && (
        <Modal>
          <div className="pill custom" style={{ marginBottom: 10 }}>
            {approval.source === 'mcp' ? 'An app connected over MCP' : 'Claude'} is asking
          </div>
          <h2>{approval.title}</h2>
          <div className="note" style={{ whiteSpace: 'pre-wrap', marginTop: 10 }}>
            {approval.detail}
          </div>
          <div className="actions">
            <button className="btn" disabled={!armed} onClick={() => answer(false)}>
              Decline
            </button>
            <button className="btn primary" disabled={!armed} onClick={() => answer(true)}>
              Approve
            </button>
          </div>
        </Modal>
      )}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.error ? 'err' : ''}`}>
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}
