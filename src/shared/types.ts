// Types shared by the main process, the connectors and the UI.
// Everything here is plain data (JSON-safe) so it can cross the IPC bridge.

export type PlatformId = string

/** How a connector reaches its platform. */
export type ConnectorKind = 'api' | 'browser' | 'cli' | 'mcp' | 'plugin'

export type MediaKind = 'video' | 'image'

export interface MediaInfo {
  path: string
  kind: MediaKind
  width?: number
  height?: number
  durationSec?: number
  sizeBytes: number
  codec?: string
}

/** A form field the UI renders from a connector manifest (settings, connect form, post options). */
export interface FieldSpec {
  key: string
  label: string
  type: 'text' | 'secret' | 'number' | 'boolean' | 'select' | 'textarea' | 'path' | 'datetime'
  help?: string
  required?: boolean
  default?: string | number | boolean
  options?: { value: string; label: string }[]
  placeholder?: string
}

/** What a platform accepts. Used to validate variants before anything is sent. */
export interface Constraints {
  title?: { required?: boolean; max: number }
  /** overflow 'thread': text over the limit is split into a thread unless options.thread === false. */
  caption?: { max: number; required?: boolean; unit?: 'chars' | 'bytes' | 'weighted'; overflow?: 'thread' }
  tags?: { required?: boolean; max?: number; maxEach?: number; maxTotalChars?: number; style: 'field' | 'hashtags' }
  video?: {
    minSec?: number
    maxSec?: number
    maxBytes?: number
    /** Accepted aspect ratios like '9:16'. Empty = any. */
    aspects?: string[]
    preferredAspect?: string
    formats?: string[]
  }
  image?: { maxCount: number; maxBytes?: number; formats?: string[]; preferredAspect?: string }
  /** Whether a post must carry media, and whether video and images may be mixed. */
  media?: { required: boolean; mixed?: boolean; maxVideos?: number }
}

export interface Capabilities {
  video: boolean
  image: boolean
  text: boolean
  /** The platform itself can hold a post until a set time (so the app need not be running). */
  nativeSchedule: boolean
  /** How far ahead the platform accepts a scheduled post, in seconds. */
  scheduleWindow?: { minSec: number; maxSec: number }
  comments: boolean
  reply: boolean
  stats: boolean
}

export interface PlatformManifest {
  id: PlatformId
  name: string
  kind: ConnectorKind
  color: string
  capabilities: Capabilities
  constraints: Constraints
  /** App-level settings this connector needs once (API client ids, tool paths). */
  settings: FieldSpec[]
  /** Fields asked for when connecting an account. */
  connectFields: FieldSpec[]
  /** Per-post options (privacy, category...). */
  options: FieldSpec[]
  /** Caveats shown to the user, e.g. "private until audited". */
  notes: string[]
  docsUrl?: string
  /** Where this connector came from: built in, a user plugin folder, or an MCP bridge. */
  source?: 'builtin' | 'plugin' | 'mcp'
}

export type AccountStatus = 'connected' | 'needs_login' | 'error'

export interface Account {
  id: string
  platform: PlatformId
  name: string
  handle?: string
  avatarUrl?: string
  status: AccountStatus
  statusNote?: string
  meta: Record<string, unknown>
  createdAt: string
}

export type TargetStatus =
  | 'draft'
  | 'queued'
  | 'publishing'
  | 'scheduled'
  | 'published'
  /** The platform may have accepted it but we could not confirm. Never re-sent automatically. */
  | 'unconfirmed'
  /** Left open in a prefilled composer for the user to press Publish (handoff mode). */
  | 'handoff'
  | 'failed'
  | 'canceled'

export type PostStatus =
  | 'draft'
  | 'queued'
  | 'publishing'
  | 'scheduled'
  | 'published'
  | 'partial'
  | 'failed'
  | 'canceled'

/** Per-platform overrides of the master post. Anything left out falls back to the master. */
export interface Variant {
  title?: string
  caption?: string
  tags?: string[]
  media?: string[]
  cover?: string
  options?: Record<string, unknown>
}

export interface Target {
  id: string
  postId: string
  accountId: string
  platform: PlatformId
  variant: Variant
  status: TargetStatus
  scheduledAt?: string
  remoteId?: string
  url?: string
  error?: string
  attempts: number
  updatedAt: string
}

export interface Post {
  id: string
  title: string
  body: string
  tags: string[]
  media: string[]
  /** Content made or substantially altered by AI: connectors set the platform's disclosure flag. */
  aiGenerated: boolean
  scheduledAt?: string
  status: PostStatus
  createdAt: string
  updatedAt: string
  targets: Target[]
}

/** Input for creating or updating a post (ids optional). */
export interface PostDraft {
  id?: string
  title: string
  body: string
  tags: string[]
  media: string[]
  aiGenerated: boolean
  scheduledAt?: string
  targets: { accountId: string; variant: Variant }[]
}

export interface Issue {
  level: 'error' | 'warning'
  field: string
  message: string
}

export interface LogEvent {
  id: number
  ts: string
  level: 'info' | 'warn' | 'error'
  scope?: string
  message: string
}

/** The content a connector actually receives for one target, after merging master + variant. */
export interface ResolvedContent {
  title: string
  caption: string
  tags: string[]
  media: string[]
  cover?: string
  options: Record<string, unknown>
  aiGenerated: boolean
}

export interface Comment {
  id: string
  author: string
  text: string
  publishedAt?: string
  likeCount?: number
  replyCount?: number
  postRemoteId?: string
  url?: string
}

export interface SettingsView {
  values: Record<string, unknown>
  /** Keys of secret settings that hold a value (secret values never reach the UI). */
  secretsSet: string[]
}

/** Agent chat items the UI renders. */
export type AgentItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; id: string; name: string; input: unknown; result?: string; isError?: boolean }
  | { kind: 'error'; text: string }

export interface ApprovalRequest {
  id: string
  title: string
  detail: string
  source: 'agent' | 'mcp'
}
