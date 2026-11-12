import { useEffect, useState } from 'react'
import type { Account, Post } from '@shared/types'
import { call, fileName, on, useData } from '../api'
import { fmtTime, PlatformDot, Status, useApp } from '../ui'

type Progress = Record<string, { fraction: number; note?: string }>

export function Posts() {
  const app = useApp()
  const { data: posts } = useData<Post[]>('posts.list', [], ['posts'])
  const { data: accounts } = useData<Account[]>('accounts.list', [], ['accounts'])
  const [progress, setProgress] = useState<Progress>({})
  const [filter, setFilter] = useState<'all' | 'active' | 'done' | 'drafts'>('all')

  useEffect(
    () =>
      on('progress', (p) => {
        const { scope, fraction, note } = p as { scope?: string; fraction: number; note?: string }
        if (scope) setProgress((s) => ({ ...s, [scope]: { fraction, note } }))
      }),
    []
  )

  const acct = (id: string) => accounts?.find((a) => a.id === id)
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn()
      if (ok) app.toast(ok)
    } catch (e) {
      app.toast((e as Error).message, true)
    }
  }

  const shown = (posts ?? []).filter((p) => {
    if (filter === 'drafts') return p.status === 'draft'
    if (filter === 'done') return p.status === 'published'
    if (filter === 'active') return ['queued', 'publishing', 'scheduled', 'partial', 'failed'].includes(p.status)
    return true
  })

  return (
    <div className="page">
      <h1>Posts</h1>
      <p className="sub">Everything you have drafted, scheduled and published, account by account.</p>
      <div className="tabs">
        {(['all', 'active', 'drafts', 'done'] as const).map((f) => (
          <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
            {f[0].toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>
      {!shown.length && (
        <div className="empty">
          Nothing here yet.{' '}
          <a href="#" onClick={() => app.go('compose')}>
            Write a post
          </a>
        </div>
      )}
      {shown.map((p) => (
        <div className="card" key={p.id}>
          <div className="row">
            <div className="grow">
              <div style={{ fontWeight: 600 }}>{p.title || p.body.slice(0, 70) || p.media.map(fileName).join(', ') || 'Untitled'}</div>
              <div className="small faint">
                {p.scheduledAt ? `For ${fmtTime(p.scheduledAt)} · ` : ''}edited {fmtTime(p.updatedAt)}
                {p.aiGenerated && ' · AI-labelled'}
              </div>
            </div>
            <Status s={p.status} />
            {p.status === 'draft' || p.targets.some((t) => t.status === 'draft') ? (
              <button className="btn sm" onClick={() => app.go('compose', p.id)}>
                Edit
              </button>
            ) : null}
            {p.targets.some((t) => t.status === 'queued') && (
              <button className="btn sm" onClick={() => act(() => call('posts.cancel', p.id), 'Canceled.')}>
                Cancel
              </button>
            )}
            <button
              className="btn ghost sm danger"
              onClick={() => {
                if (confirm('Delete this post from Polycast? Anything already published stays on the platforms.')) void act(() => call('posts.remove', p.id))
              }}
            >
              Delete
            </button>
          </div>
          {p.targets.map((t) => {
            const a = acct(t.accountId)
            const pr = progress[t.postId]
            return (
              <div className="target-row" key={t.id}>
                <PlatformDot color={app.platform(t.platform)?.color} size={12} />
                <div style={{ minWidth: 0 }}>
                  <div className="row">
                    <b>{a?.name ?? 'Removed account'}</b>
                    <span className="faint small">{app.platform(t.platform)?.name ?? t.platform}</span>
                    {t.url && (
                      <a href="#" className="small" onClick={() => call('shell.open', t.url)}>
                        Open ↗
                      </a>
                    )}
                  </div>
                  {t.error && <div className={`small ${t.status === 'failed' ? 'issue error' : 'muted'}`} style={{ marginTop: 4 }}>{t.error}</div>}
                  {t.status === 'publishing' && pr && (
                    <>
                      <div className="progress">
                        <div style={{ width: `${Math.round(pr.fraction * 100)}%` }} />
                      </div>
                      <div className="faint small">{pr.note}</div>
                    </>
                  )}
                </div>
                <div className="row">
                  <Status s={t.status} />
                  {t.status === 'failed' && (
                    <button className="btn sm" onClick={() => act(() => call('targets.retry', t.id), 'Retrying.')}>
                      Retry
                    </button>
                  )}
                  {(t.status === 'unconfirmed' || t.status === 'handoff') && (
                    <>
                      <button className="btn sm" onClick={() => act(() => call('targets.markDone', t.id), 'Marked as published.')}>
                        It’s live
                      </button>
                      <button
                        className="btn sm"
                        onClick={() => {
                          if (confirm('Post it again? Check the platform first, or it may appear twice.')) void act(() => call('targets.retry', t.id, true), 'Retrying.')
                        }}
                      >
                        Post again
                      </button>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
