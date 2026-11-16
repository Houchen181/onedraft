import { useState } from 'react'
import type { Post, Target } from '@shared/types'
import { call, fileName, isVideoPath, mediaUrl, useData } from '../api'
import { canHaveStats, postTotals, statEntries, useStats } from '../stats'
import { fmtTime, PlatformIcon, Status, useApp } from '../ui'

export const TARGET_DOT: Record<string, string> = {
  published: 'var(--ok)',
  scheduled: 'var(--info)',
  queued: 'var(--custom)',
  publishing: 'var(--custom)',
  failed: 'var(--err)',
  unconfirmed: 'var(--warn)',
  handoff: 'var(--warn)'
}

export function Thumb({ path }: { path?: string }) {
  if (!path) return <div className="thumb">✎</div>
  return <div className="thumb">{isVideoPath(path) ? <video src={`${mediaUrl(path)}#t=1`} muted preload="metadata" /> : <img src={mediaUrl(path)} alt="" />}</div>
}

const FILTERS: [string, string, (p: Post) => boolean][] = [
  ['all', 'All', () => true],
  ['drafts', 'Drafts', (p) => p.status === 'draft'],
  ['scheduled', 'Scheduled', (p) => ['queued', 'scheduled'].includes(p.status)],
  ['published', 'Published', (p) => p.status === 'published'],
  ['attention', 'Needs attention', (p) => ['failed', 'partial'].includes(p.status) || p.targets.some((t) => ['failed', 'unconfirmed', 'handoff'].includes(t.status))]
]

export function postTitle(p: Post) {
  return p.title || p.body.split('\n')[0].slice(0, 80) || (p.media[0] ? fileName(p.media[0]) : 'Untitled post')
}

export function Posts() {
  const app = useApp()
  const { data: posts } = useData<Post[]>('posts.list', [], ['posts'])
  const { stats } = useStats()
  const [filter, setFilter] = useState('all')
  const [reading, setReading] = useState(false)
  const test = FILTERS.find((f) => f[0] === filter)![2]
  const shown = (posts ?? []).filter(test)
  const withNumbers = (posts ?? []).some((p) => p.targets.some((t) => canHaveStats(t, app.platform(t.platform))))
  const refreshNumbers = async () => {
    setReading(true)
    try {
      const r = await call<{ updated: number; failed: number }>('stats.refresh')
      if (!r.updated && !r.failed) app.toast('Nothing to read: numbers come from posts of the last 30 days on platforms that report them.')
      else if (r.failed) app.toast(`${r.failed} platform${r.failed === 1 ? '' : 's'} couldn’t be read; open the post to see why.${r.updated ? ` The other ${r.updated} are up to date.` : ''}`, !r.updated)
      else app.toast('Numbers updated.')
    } catch (e) {
      app.toast((e as Error).message, true)
    } finally {
      setReading(false)
    }
  }
  const when = (p: Post) => {
    if (p.scheduledAt) return `${p.status === 'published' ? 'Posted' : 'For'} ${fmtTime(p.scheduledAt)}`
    const done = p.targets.find((t) => t.status === 'published')
    return done ? `Posted ${fmtTime(done.updatedAt)}` : `Edited ${fmtTime(p.updatedAt)}`
  }
  const icon = (t: Target) => (
    <span key={t.id} title={`${app.platform(t.platform)?.name ?? t.platform}: ${t.status}`} style={{ position: 'relative' }}>
      <PlatformIcon p={app.platform(t.platform)} size={20} />
      {TARGET_DOT[t.status] && (
        <i style={{ position: 'absolute', right: -3, bottom: -3, width: 9, height: 9, borderRadius: '50%', border: '2px solid var(--bg)', background: TARGET_DOT[t.status] }} />
      )}
    </span>
  )

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow">
          <h1>Posts</h1>
          <p className="sub">Everything you’ve drafted, scheduled and posted.</p>
        </div>
        {withNumbers && (
          <button className="btn" disabled={reading} onClick={() => void refreshNumbers()} title="Read views, likes and comments from the platforms (posts from the last 30 days)">
            {reading ? 'Reading numbers…' : '↻ Numbers'}
          </button>
        )}
        <button className="btn primary" onClick={() => app.newPost()}>
          + New post
        </button>
      </div>
      <div className="seg" style={{ marginBottom: 14 }}>
        {FILTERS.map(([id, label]) => (
          <button key={id} className={filter === id ? 'on' : ''} onClick={() => setFilter(id)}>
            {label}
          </button>
        ))}
      </div>
      {!shown.length && (
        <div className="empty">
          {posts?.length ? 'Nothing here.' : 'No posts yet.'}{' '}
          <a href="#" onClick={() => app.newPost()}>
            Write one
          </a>{' '}
          or ask Claude in{' '}
          <a href="#" onClick={() => app.go('chat')}>
            Chat
          </a>
          .
        </div>
      )}
      <div className="stack" style={{ gap: 2 }}>
        {shown.map((p) => {
          const totals = postTotals(p.targets, stats)
          return (
            <div key={p.id} className="plist-row" onClick={() => app.go('post', p.id)}>
              <Thumb path={p.media[0]} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{postTitle(p)}</div>
                <div className="small muted">
                  {when(p)}
                  {p.aiGenerated && ' · AI-labelled'}
                </div>
                {totals && (
                  <div className="pstats" title="Added up across platforms">
                    {statEntries(totals)
                      .map((e) => e.text)
                      .join(' · ')}
                  </div>
                )}
                <div className="ptargets">{p.targets.map(icon)}</div>
              </div>
              <Status s={p.status} />
            </div>
          )
        })}
      </div>
    </div>
  )
}
