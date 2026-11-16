// Post numbers (views, likes...) as OneDraft shows them. The main process stores them under common names
// (src/core/inbox.ts normalizeStats); this file only labels, sums and displays them.

import { useEffect, useMemo, useState } from 'react'
import type { PlatformManifest, Target, TargetStats } from '@shared/types'
import { call, useData } from './api'
import { timeAgo, useApp } from './ui'

/** The common numbers, in the order shown. A platform's extras (coins, quotes, reach) follow. */
const ORDER = ['views', 'likes', 'comments', 'shares', 'saves']
/** Totals across platforms only add numbers that mean the same everywhere. */
const SUMMED = ['views', 'likes', 'comments']

/** [one, many] for each number, with what each platform calls it. */
const LABELS: Record<string, [string, string]> = {
  views: ['view', 'views'],
  likes: ['like', 'likes'],
  comments: ['comment', 'comments'],
  shares: ['share', 'shares'],
  saves: ['save', 'saves'],
  quotes: ['quote', 'quotes'],
  coins: ['coin', 'coins'],
  danmaku: ['danmaku', 'danmaku'],
  reach: ['reached', 'reached']
}
const PLATFORM_LABELS: Record<string, Record<string, [string, string]>> = {
  x: { shares: ['repost', 'reposts'], saves: ['bookmark', 'bookmarks'] },
  bilibili: { saves: ['favorite', 'favorites'] }
}

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
export const fmtCount = (n: number) => (Math.abs(n) < 1000 ? String(Math.round(n)) : compact.format(n))

function label(key: string, n: number, platform?: string): string {
  const pair = (platform && PLATFORM_LABELS[platform]?.[key]) ?? LABELS[key]
  if (pair) return n === 1 ? pair[0] : pair[1]
  // A plugin's own name: split camelCase and snake_case.
  return key
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
}

/** The numbers worth showing, in order: common ones first, then extras. */
export function statEntries(metrics: Record<string, number>, platform?: string): { key: string; n: number; text: string }[] {
  const keys = [...ORDER.filter((k) => k in metrics), ...Object.keys(metrics).filter((k) => !ORDER.includes(k))]
  return keys.map((k) => ({ key: k, n: metrics[k], text: `${fmtCount(metrics[k])} ${label(k, metrics[k], platform)}` }))
}

/** Every saved number, by target id. */
export function useStats() {
  const { data, reload } = useData<TargetStats[]>('stats.list', [], ['stats'])
  const stats = useMemo(() => new Map((data ?? []).map((s) => [s.targetId, s])), [data])
  return { stats, reload }
}

/** Views, likes and comments added up across a post's platforms (undefined when none has numbers). */
export function postTotals(targets: Target[], stats: Map<string, TargetStats>): Record<string, number> | undefined {
  const out: Record<string, number> = {}
  let any = false
  for (const t of targets) {
    const m = stats.get(t.id)?.metrics
    if (!m) continue
    for (const k of SUMMED) {
      if (typeof m[k] === 'number') {
        out[k] = (out[k] ?? 0) + m[k]
        any = true
      }
    }
  }
  return any ? out : undefined
}

/** Out on its platform: published, or scheduled there with the time passed. */
export const isLive = (t: Target) =>
  !!t.remoteId && (t.status === 'published' || (t.status === 'scheduled' && !!t.scheduledAt && new Date(t.scheduledAt).getTime() <= Date.now()))

/** Can this target have numbers yet? Live on a platform that reports them. */
export const canHaveStats = (t: Target, p?: PlatformManifest) => isLive(t) && !!p?.capabilities.stats

/** Targets refreshed automatically this session, so switching panels doesn't fetch again and again. */
const autoRefreshed = new Set<string>()
const STALE_MS = 60 * 60_000

/** One platform's numbers for a published post, refreshed when they're older than an hour. */
export function TargetStatsStrip({ target: t, platform: p, stats }: { target: Target; platform: PlatformManifest; stats?: TargetStats }) {
  const app = useApp()
  const [busy, setBusy] = useState(false)
  const refresh = async (quiet?: boolean) => {
    setBusy(true)
    try {
      const r = await call<{ failed: number; stats: TargetStats[] }>('stats.refresh', [t.id])
      if (!quiet && r.failed) app.toast(r.stats[0]?.error ?? `Couldn't read ${p.name}'s numbers.`, true)
    } catch (e) {
      if (!quiet) app.toast((e as Error).message, true)
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    const stale = !stats || Date.now() - new Date(stats.fetchedAt).getTime() > STALE_MS
    if (stale && !autoRefreshed.has(t.id)) {
      autoRefreshed.add(t.id)
      void refresh(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.id])
  const entries = stats ? statEntries(stats.metrics, p.id) : []
  return (
    <div className="stats-strip">
      {entries.length ? (
        entries.map((e) => (
          <span key={e.key} className={`st ${['views', 'likes', 'comments'].includes(e.key) ? 'main' : ''}`}>
            {e.text}
          </span>
        ))
      ) : (
        <span className="faint">{busy ? `Reading ${p.name}’s numbers…` : stats?.error ? `Couldn’t read the numbers: ${stats.error}` : 'No numbers yet.'}</span>
      )}
      <span className="grow" />
      {stats && entries.length > 0 && (
        <span className="faint small" title={stats.error ? `Last refresh failed: ${stats.error}` : undefined}>
          {stats.error ? '⚠ ' : ''}
          {timeAgo(stats.fetchedAt)}
        </span>
      )}
      <button className="btn sm ghost" disabled={busy} onClick={() => void refresh()} title={`Read ${p.name}'s numbers now`}>
        {busy ? '…' : '↻'}
      </button>
    </div>
  )
}
