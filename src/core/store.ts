// SQLite store on Node's built-in node:sqlite (no native module to rebuild for Electron).
// Secrets (tokens, cookies, API keys) are encrypted by the injected Cipher before they touch disk.

import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
export type ChangeKind = 'posts' | 'accounts' | 'events' | 'projects'

import type {
  Account,
  AccountStatus,
  CompositionSpec,
  EditProject,
  EditSpec,
  LogEvent,
  Post,
  PostDraft,
  PostStatus,
  Target,
  TargetStatus,
  Variant
} from '../shared/types'

export interface Cipher {
  encrypt(plain: string): Uint8Array
  decrypt(data: Uint8Array): string
}

export const plainCipher: Cipher = {
  encrypt: (s) => Buffer.from(s, 'utf8'),
  decrypt: (b) => Buffer.from(b).toString('utf8')
}

const SCHEMA = `
create table if not exists accounts (
  id text primary key,
  platform text not null,
  remote_user_id text,
  name text not null,
  handle text,
  avatar_url text,
  status text not null,
  status_note text,
  meta text not null default '{}',
  secret blob,
  created_at text not null
);
create table if not exists posts (
  id text primary key,
  title text not null default '',
  body text not null default '',
  tags text not null default '[]',
  media text not null default '[]',
  ai_generated integer not null default 0,
  scheduled_at text,
  created_at text not null,
  updated_at text not null
);
create table if not exists targets (
  id text primary key,
  post_id text not null references posts(id) on delete cascade,
  account_id text not null,
  platform text not null,
  variant text not null default '{}',
  status text not null,
  scheduled_at text,
  remote_id text,
  url text,
  error text,
  attempts integer not null default 0,
  next_attempt_at text,
  updated_at text not null
);
create index if not exists targets_due on targets(status, next_attempt_at);
create table if not exists settings (
  key text primary key,
  value text,
  secret blob
);
create table if not exists events (
  id integer primary key autoincrement,
  ts text not null,
  level text not null,
  scope text,
  message text not null
);
create table if not exists edits (
  id text primary key,
  name text not null,
  kind text not null,
  spec text,
  composition text,
  prompt text,
  output text,
  ai_generated integer not null default 0,
  created_at text not null,
  updated_at text not null
);
create table if not exists agent_messages (
  id integer primary key autoincrement,
  conversation text not null,
  message text not null,
  ts text not null
);
`

const now = () => new Date().toISOString()
const json = (v: unknown) => JSON.stringify(v ?? null)
const parse = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== 'string') return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

type Row = Record<string, unknown>

export class Store {
  readonly db: DatabaseSync
  private listeners = new Set<(kind: ChangeKind) => void>()

  constructor(
    path: string,
    private cipher: Cipher = plainCipher
  ) {
    this.db = new DatabaseSync(path)
    this.db.exec('pragma journal_mode = wal; pragma foreign_keys = on;')
    this.db.exec(SCHEMA)
  }

  onChange(fn: (kind: ChangeKind) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  private changed(kind: ChangeKind) {
    for (const fn of this.listeners) fn(kind)
  }

  // ---------- accounts ----------

  private toAccount(r: Row): Account {
    return {
      id: r.id as string,
      platform: r.platform as string,
      name: r.name as string,
      handle: (r.handle as string) ?? undefined,
      avatarUrl: (r.avatar_url as string) ?? undefined,
      status: r.status as AccountStatus,
      statusNote: (r.status_note as string) ?? undefined,
      meta: parse(r.meta, {}),
      createdAt: r.created_at as string
    }
  }

  listAccounts(): Account[] {
    return this.db
      .prepare('select * from accounts order by platform, name')
      .all()
      .map((r) => this.toAccount(r as Row))
  }

  getAccount(id: string): Account | undefined {
    const r = this.db.prepare('select * from accounts where id = ?').get(id)
    return r ? this.toAccount(r as Row) : undefined
  }

  /** The account connected for a platform (OneDraft keeps one account per platform). */
  accountFor(platform: string): Account | undefined {
    const r = this.db.prepare('select * from accounts where platform = ? order by created_at limit 1').get(platform)
    return r ? this.toAccount(r as Row) : undefined
  }

  /**
   * One account per platform: connecting again updates that platform's account in place (same id), so drafts and
   * scheduled posts keep pointing at it even when a different login replaces the old one.
   */
  upsertAccount(a: {
    platform: string
    remoteUserId: string
    name: string
    handle?: string
    avatarUrl?: string
    meta?: Record<string, unknown>
  }): Account {
    const existing = this.db.prepare('select id from accounts where platform = ? order by created_at limit 1').get(a.platform) as Row | undefined
    const id = (existing?.id as string) ?? randomUUID()
    if (existing) {
      this.db
        .prepare(
          `update accounts set remote_user_id = ?, name = ?, handle = ?, avatar_url = ?, meta = ?, status = 'connected', status_note = null where id = ?`
        )
        .run(a.remoteUserId, a.name, a.handle ?? null, a.avatarUrl ?? null, json(a.meta ?? {}), id)
    } else {
      this.db
        .prepare(
          `insert into accounts (id, platform, remote_user_id, name, handle, avatar_url, status, meta, created_at)
           values (?, ?, ?, ?, ?, ?, 'connected', ?, ?)`
        )
        .run(id, a.platform, a.remoteUserId, a.name, a.handle ?? null, a.avatarUrl ?? null, json(a.meta ?? {}), now())
    }
    this.changed('accounts')
    return this.getAccount(id)!
  }

  setAccountStatus(id: string, status: AccountStatus, note?: string) {
    this.db.prepare('update accounts set status = ?, status_note = ? where id = ?').run(status, note ?? null, id)
    this.changed('accounts')
  }

  updateAccountMeta(id: string, meta: Record<string, unknown>) {
    this.db.prepare('update accounts set meta = ? where id = ?').run(json(meta), id)
    this.changed('accounts')
  }

  removeAccount(id: string) {
    this.db.prepare('delete from accounts where id = ?').run(id)
    this.changed('accounts')
  }

  getAccountSecret<T>(id: string): T | undefined {
    const r = this.db.prepare('select secret from accounts where id = ?').get(id) as Row | undefined
    if (!r?.secret) return undefined
    return parse<T | undefined>(this.cipher.decrypt(r.secret as Uint8Array), undefined)
  }

  setAccountSecret(id: string, value: unknown) {
    const blob = value === undefined ? null : this.cipher.encrypt(JSON.stringify(value))
    this.db.prepare('update accounts set secret = ? where id = ?').run(blob, id)
  }

  // ---------- settings ----------

  getSetting<T = unknown>(key: string): T | undefined {
    const r = this.db.prepare('select value, secret from settings where key = ?').get(key) as Row | undefined
    if (!r) return undefined
    if (r.secret) return parse<T | undefined>(this.cipher.decrypt(r.secret as Uint8Array), undefined)
    return parse<T | undefined>(r.value, undefined)
  }

  setSetting(key: string, value: unknown, secret = false) {
    if (value === undefined || value === null || value === '') {
      this.db.prepare('delete from settings where key = ?').run(key)
      return
    }
    if (secret) {
      this.db
        .prepare('insert into settings (key, value, secret) values (?, null, ?) on conflict(key) do update set value = null, secret = excluded.secret')
        .run(key, this.cipher.encrypt(JSON.stringify(value)))
    } else {
      this.db
        .prepare('insert into settings (key, value, secret) values (?, ?, null) on conflict(key) do update set value = excluded.value, secret = null')
        .run(key, json(value))
    }
  }

  /** Non-secret values plus the names of secret keys that are set. */
  allSettings(): { values: Record<string, unknown>; secretsSet: string[] } {
    const values: Record<string, unknown> = {}
    const secretsSet: string[] = []
    for (const r of this.db.prepare('select key, value, secret from settings').all() as Row[]) {
      if (r.secret) secretsSet.push(r.key as string)
      else values[r.key as string] = parse(r.value, null)
    }
    return { values, secretsSet }
  }

  // ---------- posts & targets ----------

  private toTarget(r: Row): Target {
    return {
      id: r.id as string,
      postId: r.post_id as string,
      accountId: r.account_id as string,
      platform: r.platform as string,
      variant: parse<Variant>(r.variant, {}),
      status: r.status as TargetStatus,
      scheduledAt: (r.scheduled_at as string) ?? undefined,
      remoteId: (r.remote_id as string) ?? undefined,
      url: (r.url as string) ?? undefined,
      error: (r.error as string) ?? undefined,
      attempts: Number(r.attempts ?? 0),
      updatedAt: r.updated_at as string
    }
  }

  private toPost(r: Row, targets: Target[]): Post {
    return {
      id: r.id as string,
      title: r.title as string,
      body: r.body as string,
      tags: parse(r.tags, []),
      media: parse(r.media, []),
      aiGenerated: Boolean(r.ai_generated),
      scheduledAt: (r.scheduled_at as string) ?? undefined,
      status: derivePostStatus(targets),
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      targets
    }
  }

  getPost(id: string): Post | undefined {
    const r = this.db.prepare('select * from posts where id = ?').get(id) as Row | undefined
    if (!r) return undefined
    const targets = (this.db.prepare('select * from targets where post_id = ? order by rowid').all(id) as Row[]).map((t) =>
      this.toTarget(t)
    )
    return this.toPost(r, targets)
  }

  listPosts(limit = 200): Post[] {
    const rows = this.db.prepare('select * from posts order by updated_at desc limit ?').all(limit) as Row[]
    const byPost = new Map<string, Target[]>()
    for (const t of this.db.prepare('select * from targets order by rowid').all() as Row[]) {
      const target = this.toTarget(t)
      byPost.set(target.postId, [...(byPost.get(target.postId) ?? []), target])
    }
    return rows.map((r) => this.toPost(r, byPost.get(r.id as string) ?? []))
  }

  /**
   * Create or update a post. Targets that are already queued, publishing or done keep their state;
   * draft targets are replaced by the draft's list.
   */
  savePost(d: PostDraft, accountPlatform: (accountId: string) => string | undefined): Post {
    const id = d.id ?? randomUUID()
    const ts = now()
    const exists = d.id ? this.db.prepare('select 1 from posts where id = ?').get(d.id) : undefined
    if (exists) {
      this.db
        .prepare('update posts set title = ?, body = ?, tags = ?, media = ?, ai_generated = ?, scheduled_at = ?, updated_at = ? where id = ?')
        .run(d.title, d.body, json(d.tags), json(d.media), d.aiGenerated ? 1 : 0, d.scheduledAt ?? null, ts, id)
    } else {
      this.db
        .prepare(
          'insert into posts (id, title, body, tags, media, ai_generated, scheduled_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(id, d.title, d.body, json(d.tags), json(d.media), d.aiGenerated ? 1 : 0, d.scheduledAt ?? null, ts, ts)
    }
    // Targets keep their ids across saves (agents refer to them); queued/published ones are left alone.
    const current = (this.db.prepare('select * from targets where post_id = ?').all(id) as Row[]).map((r) => this.toTarget(r))
    const editable = (t: Target) => t.status === 'draft' || t.status === 'canceled'
    const wanted = new Map(d.targets.map((t) => [t.accountId, t]))
    for (const t of current) {
      if (editable(t) && !wanted.has(t.accountId)) this.db.prepare('delete from targets where id = ?').run(t.id)
    }
    for (const t of d.targets) {
      const existing = current.find((c) => c.accountId === t.accountId)
      if (existing && !editable(existing)) continue
      if (existing) {
        this.db
          .prepare(`update targets set variant = ?, status = 'draft', scheduled_at = ?, updated_at = ? where id = ?`)
          .run(json(t.variant ?? {}), d.scheduledAt ?? null, ts, existing.id)
        continue
      }
      const platform = accountPlatform(t.accountId)
      if (!platform) throw new Error(`Unknown account ${t.accountId}`)
      this.db
        .prepare(
          `insert into targets (id, post_id, account_id, platform, variant, status, scheduled_at, attempts, updated_at)
           values (?, ?, ?, ?, ?, 'draft', ?, 0, ?)`
        )
        .run(randomUUID(), id, t.accountId, platform, json(t.variant ?? {}), d.scheduledAt ?? null, ts)
    }
    this.changed('posts')
    return this.getPost(id)!
  }

  updateTargetVariant(targetId: string, patch: Variant) {
    const t = this.getTarget(targetId)
    if (!t) throw new Error(`Unknown target ${targetId}`)
    const variant = { ...t.variant, ...patch, options: { ...(t.variant.options ?? {}), ...(patch.options ?? {}) } }
    this.db.prepare('update targets set variant = ?, updated_at = ? where id = ?').run(json(variant), now(), targetId)
    this.touchPost(t.postId)
    this.changed('posts')
    return this.getTarget(targetId)!
  }

  getTarget(id: string): Target | undefined {
    const r = this.db.prepare('select * from targets where id = ?').get(id) as Row | undefined
    return r ? this.toTarget(r) : undefined
  }

  setTarget(
    id: string,
    patch: Partial<{
      status: TargetStatus
      remoteId: string | null
      url: string | null
      error: string | null
      scheduledAt: string | null
      attempts: number
      nextAttemptAt: string | null
    }>
  ) {
    const cols: string[] = []
    const vals: (string | number | null)[] = []
    const map: Record<string, string> = {
      status: 'status',
      remoteId: 'remote_id',
      url: 'url',
      error: 'error',
      scheduledAt: 'scheduled_at',
      attempts: 'attempts',
      nextAttemptAt: 'next_attempt_at'
    }
    for (const [k, col] of Object.entries(map)) {
      if (k in patch) {
        cols.push(`${col} = ?`)
        vals.push(((patch as Record<string, unknown>)[k] as string | number | null | undefined) ?? null)
      }
    }
    if (!cols.length) return
    cols.push('updated_at = ?')
    vals.push(now())
    this.db.prepare(`update targets set ${cols.join(', ')} where id = ?`).run(...vals, id)
    const t = this.getTarget(id)
    if (t) this.touchPost(t.postId)
    this.changed('posts')
  }

  private touchPost(postId: string) {
    this.db.prepare('update posts set updated_at = ? where id = ?').run(now(), postId)
  }

  removePost(id: string) {
    this.db.prepare('delete from targets where post_id = ?').run(id)
    this.db.prepare('delete from posts where id = ?').run(id)
    this.changed('posts')
  }

  /** Queued targets whose time has come (scheduled time and retry backoff both passed). */
  dueTargets(at = new Date()): Target[] {
    const iso = at.toISOString()
    return (
      this.db
        .prepare(
          `select * from targets where status = 'queued'
           and (next_attempt_at is null or next_attempt_at <= ?)
           order by coalesce(scheduled_at, updated_at)`
        )
        .all(iso) as Row[]
    )
      .map((r) => this.toTarget(r))
  }

  /** Targets interrupted mid-publish (app quit or crashed). */
  stuckTargets(): Target[] {
    return (this.db.prepare(`select * from targets where status = 'publishing'`).all() as Row[]).map((r) => this.toTarget(r))
  }

  // ---------- events ----------

  log(level: LogEvent['level'], message: string, scope?: string) {
    this.db.prepare('insert into events (ts, level, scope, message) values (?, ?, ?, ?)').run(now(), level, scope ?? null, message)
    this.changed('events')
  }

  listEvents(limit = 300, scope?: string): LogEvent[] {
    const rows = scope
      ? this.db.prepare('select * from events where scope = ? order by id desc limit ?').all(scope, limit)
      : this.db.prepare('select * from events order by id desc limit ?').all(limit)
    return (rows as Row[]).map((r) => ({
      id: Number(r.id),
      ts: r.ts as string,
      level: r.level as LogEvent['level'],
      scope: (r.scope as string) ?? undefined,
      message: r.message as string
    }))
  }

  // ---------- studio projects ----------

  private toProject(r: Row): EditProject {
    return {
      id: r.id as string,
      name: r.name as string,
      kind: r.kind as EditProject['kind'],
      spec: parse<EditSpec | undefined>(r.spec, undefined),
      composition: parse<CompositionSpec | undefined>(r.composition, undefined),
      prompt: (r.prompt as string) ?? undefined,
      output: (r.output as string) ?? undefined,
      aiGenerated: Boolean(r.ai_generated),
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string
    }
  }

  listProjects(): EditProject[] {
    return (this.db.prepare('select * from edits order by updated_at desc').all() as Row[]).map((r) => this.toProject(r))
  }

  getProject(id: string): EditProject | undefined {
    const r = this.db.prepare('select * from edits where id = ?').get(id) as Row | undefined
    return r ? this.toProject(r) : undefined
  }

  saveProject(p: Omit<EditProject, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): EditProject {
    const id = p.id ?? randomUUID()
    const ts = now()
    const exists = p.id ? this.db.prepare('select 1 from edits where id = ?').get(p.id) : undefined
    const vals = [p.name, p.kind, p.spec ? json(p.spec) : null, p.composition ? json(p.composition) : null, p.prompt ?? null, p.output ?? null, p.aiGenerated ? 1 : 0]
    if (exists) {
      this.db
        .prepare('update edits set name = ?, kind = ?, spec = ?, composition = ?, prompt = ?, output = ?, ai_generated = ?, updated_at = ? where id = ?')
        .run(...vals, ts, id)
    } else {
      this.db
        .prepare('insert into edits (name, kind, spec, composition, prompt, output, ai_generated, created_at, updated_at, id) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(...vals, ts, ts, id)
    }
    this.changed('projects')
    return this.getProject(id)!
  }

  removeProject(id: string) {
    this.db.prepare('delete from edits where id = ?').run(id)
    this.changed('projects')
  }

  // ---------- agent conversation ----------

  appendAgentMessage(conversation: string, message: unknown) {
    this.db.prepare('insert into agent_messages (conversation, message, ts) values (?, ?, ?)').run(conversation, json(message), now())
  }

  agentMessages<T>(conversation: string): T[] {
    return (this.db.prepare('select message from agent_messages where conversation = ? order by id').all(conversation) as Row[]).map(
      (r) => parse<T>(r.message, null as T)
    )
  }

  clearAgent(conversation: string) {
    this.db.prepare('delete from agent_messages where conversation = ?').run(conversation)
  }

  close() {
    this.db.close()
  }
}

export function derivePostStatus(targets: Target[]): PostStatus {
  if (!targets.length) return 'draft'
  const s = targets.map((t) => t.status)
  const all = (x: TargetStatus) => s.every((v) => v === x)
  const any = (x: TargetStatus) => s.includes(x)
  if (all('draft')) return 'draft'
  if (all('canceled')) return 'canceled'
  if (any('publishing')) return 'publishing'
  if (any('queued')) return 'queued'
  const done = s.filter((v) => v === 'published' || v === 'scheduled').length
  if (any('failed')) return done ? 'partial' : 'failed'
  if (any('unconfirmed') || any('handoff')) return 'partial'
  if (any('scheduled')) return 'scheduled'
  if (done) return 'published'
  return 'draft'
}
