import { useMemo, useState } from 'react'
import type { Post } from '@shared/types'
import { useData } from '../api'
import { PlatformIcon, useApp } from '../ui'
import { postTitle, TARGET_DOT, Thumb } from './Posts'

const FIRST_HOUR = 6
const LAST_HOUR = 23
const ROW = 46 // px per hour (matches .cal .hr)

function startOfWeek(d: Date) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7)) // Monday
  return x
}
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

/** When a post goes (or went) out: its scheduled time, else when it was published. */
function postTime(p: Post): Date | undefined {
  if (p.scheduledAt) return new Date(p.scheduledAt)
  const done = p.targets.find((t) => t.status === 'published')
  return done ? new Date(done.updatedAt) : undefined
}

export function Calendar() {
  const app = useApp()
  const { data: posts } = useData<Post[]>('posts.list', [], ['posts'])
  const [week, setWeek] = useState(() => startOfWeek(new Date()))
  const days = Array.from({ length: 7 }, (_, i) => new Date(week.getFullYear(), week.getMonth(), week.getDate() + i))
  const today = new Date()
  const placed = useMemo(() => (posts ?? []).map((p) => ({ p, at: postTime(p) })).filter((x) => x.at), [posts])
  const unscheduled = (posts ?? []).filter((p) => !postTime(p) && p.status === 'draft')
  const month = (d: Date) => d.toLocaleDateString(undefined, { month: 'long' })
  const label =
    days[0].getMonth() === days[6].getMonth()
      ? `${month(days[0])} ${days[0].getDate()} – ${days[6].getDate()}, ${days[6].getFullYear()}`
      : `${month(days[0])} ${days[0].getDate()} – ${month(days[6])} ${days[6].getDate()}, ${days[6].getFullYear()}`

  return (
    <div className="page" style={{ maxWidth: 1240 }}>
      <div className="page-head">
        <div className="grow">
          <h1>Calendar</h1>
          <p className="sub">{label}</p>
        </div>
        <button className="btn sm" onClick={() => setWeek(new Date(week.getFullYear(), week.getMonth(), week.getDate() - 7))}>
          ‹
        </button>
        <button className="btn sm" onClick={() => setWeek(startOfWeek(new Date()))}>
          This week
        </button>
        <button className="btn sm" onClick={() => setWeek(new Date(week.getFullYear(), week.getMonth(), week.getDate() + 7))}>
          ›
        </button>
        <button className="btn primary" onClick={() => app.newPost()}>
          + New post
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: unscheduled.length ? 'minmax(0,1fr) 230px' : 'minmax(0,1fr)', gap: 16, alignItems: 'start' }}>
        <div className="cal">
          <div />
          {days.map((d) => (
            <div key={d.toISOString()} className={`dh ${sameDay(d, today) ? 'today' : ''}`}>
              {d.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase()}
              <b>{d.getDate()}</b>
            </div>
          ))}
          <div>
            {Array.from({ length: LAST_HOUR - FIRST_HOUR + 1 }, (_, i) => (
              <div key={i} className="hr">
                {new Date(2000, 0, 1, FIRST_HOUR + i).toLocaleTimeString(undefined, { hour: 'numeric' })}
              </div>
            ))}
          </div>
          {days.map((d) => (
            <div key={d.toISOString()} className={`day ${sameDay(d, today) ? 'today' : ''}`}>
              {placed
                .filter((x) => sameDay(x.at!, d))
                .map(({ p, at }) => {
                  const h = Math.min(LAST_HOUR, Math.max(FIRST_HOUR, at!.getHours() + at!.getMinutes() / 60))
                  const color = p.status === 'published' ? 'var(--ok)' : p.status === 'failed' || p.status === 'partial' ? 'var(--err)' : 'var(--custom)'
                  return (
                    <div key={p.id} className="cpost" style={{ top: (h - FIRST_HOUR) * ROW + 2, borderLeftColor: color }} onClick={() => app.go('post', p.id)} title={postTitle(p)}>
                      <b>{postTitle(p)}</b>
                      <span className="faint">{at!.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
                      <div className="ic">
                        {p.targets.map((t) => (
                          <span key={t.id} style={{ position: 'relative', display: 'inline-block' }}>
                            <PlatformIcon p={app.platform(t.platform)} size={14} />
                            {TARGET_DOT[t.status] && <i style={{ position: 'absolute', right: -2, bottom: -2, width: 6, height: 6, borderRadius: '50%', background: TARGET_DOT[t.status] }} />}
                          </span>
                        ))}
                      </div>
                    </div>
                  )
                })}
            </div>
          ))}
        </div>
        {unscheduled.length > 0 && (
          <div className="card" style={{ padding: 12 }}>
            <div className="small muted" style={{ fontWeight: 600, marginBottom: 8 }}>
              Drafts without a time
            </div>
            <div className="stack" style={{ gap: 8 }}>
              {unscheduled.slice(0, 12).map((p) => (
                <div key={p.id} className="row" style={{ cursor: 'pointer' }} onClick={() => app.go('post', p.id)}>
                  <Thumb path={p.media[0]} />
                  <div className="small" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {postTitle(p)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
