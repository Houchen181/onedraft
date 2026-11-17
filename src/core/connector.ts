// The one interface every platform implements. Adding a platform = writing one of these.
// Built-in connectors live in src/connectors; user plugins load from <data>/connectors/<id>/index.js
// and MCP bridges wrap an external MCP server (see src/connectors/mcp-bridge.ts).

import type { BrowserContext } from 'playwright-core'
import type {
  Account,
  Comment,
  Issue,
  PlatformManifest,
  ResolvedContent
} from '../shared/types'

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export interface LoopbackOptions {
  /** Build the authorize URL from the redirect URI, state and PKCE challenge. */
  authorizeUrl: (p: { redirectUri: string; state: string; codeChallenge: string }) => string
  /** Fixed port when the platform needs an exact registered redirect URI; 0 = any free port. */
  port?: number
  host?: '127.0.0.1' | 'localhost'
  path?: string
  /** 'S256' = base64url(sha256) per RFC 7636; 'S256-hex' = hex(sha256) (TikTok desktop). */
  challengeMethod?: 'S256' | 'S256-hex'
  timeoutMs?: number
}

export interface WebCookie {
  name: string
  value: string
  domain: string
}

export interface LoopbackResult {
  code: string
  redirectUri: string
  codeVerifier: string
  params: Record<string, string>
}

export interface ConnectorContext {
  /** App-level setting for this connector (declared in manifest.settings). */
  setting(key: string): string | undefined
  /** App-wide setting shared by connectors, e.g. 'mediaHost.endpoint'. */
  globalSetting(key: string): string | undefined
  /** Encrypted per-account secret blob (tokens, cookies). */
  secrets: {
    get<T = Record<string, unknown>>(): T | undefined
    set(value: unknown): void
  }
  log(message: string, level?: 'info' | 'warn' | 'error'): void
  progress(fraction: number, note?: string): void
  fetch: typeof fetch
  oauthLoopback(opts: LoopbackOptions): Promise<LoopbackResult>
  openExternal(url: string): Promise<void>
  /** Persistent Playwright browser profile, one per account (or per pending login). */
  browser(profileKey: string, opts?: { headless?: boolean; locale?: string }): Promise<BrowserContext>
  /**
   * Sign in like in any browser: opens a plain window (no automation attached, so sites like Google don't refuse
   * it) on `url` with the profile `profileKey`, and resolves once `signedIn` says the cookies show a login (the
   * window then closes by itself). Rejects if the person closes the window first.
   */
  signInWindow?(profileKey: string, url: string, signedIn: (cookies: WebCookie[]) => boolean): Promise<WebCookie[]>
  /** Sign out of a browser profile: close its windows and delete it (its cookies are the sign-in). */
  forgetBrowser?(profileKey: string): Promise<void>
  /** Show a QR code in the Connect window, with what to do with it (replaces the previous one). */
  showQr?(text: string, note?: string): void
  /** Tell the Connect window what is happening now (replaces a QR code shown earlier). */
  connectStatus?(note: string): void
  exec(
    command: string,
    args: string[],
    opts?: { cwd?: string; onLine?: (line: string) => void; timeoutMs?: number; newConsole?: boolean }
  ): Promise<ExecResult>
  paths: { data: string; profiles: string; tools: string; temp: string }
  signal: AbortSignal
}

/** Result of an interactive connect: the account to save plus secrets to encrypt. */
export interface ConnectResult {
  name: string
  handle?: string
  avatarUrl?: string
  /** Stable id of the account on the platform (channel id, user id...). Used to avoid duplicates. */
  remoteUserId: string
  meta?: Record<string, unknown>
  secrets?: unknown
}

export interface PublishRequest {
  targetId: string
  content: ResolvedContent
  /** Set only when the connector supports native scheduling and the time is in the future. */
  publishAt?: string
}

export interface PublishResult {
  remoteId?: string
  url?: string
  /**
   * 'scheduled' = the platform holds it until publishAt. 'processing' = accepted, still processing.
   * 'handoff' = composer left open, prefilled, for the user to press Publish.
   */
  state: 'published' | 'scheduled' | 'processing' | 'handoff'
  note?: string
  /** For a handoff in a window OneDraft opened: settles, with a new note, once the person closes that window. */
  closed?: Promise<string>
}

export interface AccountCheck {
  ok: boolean
  note?: string
  name?: string
}

export interface Connector {
  manifest: PlatformManifest
  /** Extra platform-specific checks on top of the manifest constraints, for the account the post goes to. */
  validate?(content: ResolvedContent, account?: Account): Issue[]
  /** Adjust the manifest to the platform's settings (e.g. X Premium's longer posts). Called at start and on changes. */
  applySettings?(setting: (key: string) => string | undefined): void
  /** Interactive login. `input` holds the values of manifest.connectFields. */
  connect(ctx: ConnectorContext, input: Record<string, string>): Promise<ConnectResult>
  /** Is the saved login still good? Should refresh tokens when it can. */
  check?(ctx: ConnectorContext, account: Account): Promise<AccountCheck>
  publish(ctx: ConnectorContext, account: Account, req: PublishRequest): Promise<PublishResult>
  /**
   * Recent comments on the account's posts, or on one post (remoteId). Set `mine` on comments the account wrote
   * itself. `sinceId` is the newest comment OneDraft has seen on that post (the account's own included):
   * platforms that bill per read should return only newer ones.
   */
  listComments?(
    ctx: ConnectorContext,
    account: Account,
    opts: { remoteId?: string; limit?: number; sinceId?: string }
  ): Promise<Comment[]>
  reply?(
    ctx: ConnectorContext,
    account: Account,
    opts: { commentId: string; remoteId?: string; text: string }
  ): Promise<{ id: string }>
  stats?(ctx: ConnectorContext, account: Account, remoteId: string): Promise<Record<string, number>>
  disconnect?(ctx: ConnectorContext, account: Account): Promise<void>
}

/** Errors a connector throws when the user must log in again. */
export class NeedsLoginError extends Error {
  constructor(message = 'Login expired; reconnect this account.') {
    super(message)
    this.name = 'NeedsLoginError'
  }
}

/**
 * Errors worth retrying later (rate limits, network, 5xx) — only valid when the platform has NOT
 * accepted the post. Once a platform accepted it, throw UnconfirmedError instead.
 */
export class RetryableError extends Error {
  constructor(
    message: string,
    public retryAfterSec = 300
  ) {
    super(message)
    this.name = 'RetryableError'
  }
}

/**
 * Stopped by Cancel before anything reached the platform (e.g. while OneDraft filled in a website's form, which the
 * person submits themselves): the post is simply canceled, not "may already be live".
 */
export class CanceledError extends Error {
  constructor(message = 'Canceled.') {
    super(message)
    this.name = 'CanceledError'
  }
}

/** The content itself was rejected (too long, wrong format). Shown to the user, never retried. */
export class ContentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContentError'
  }
}

/** The platform wants a person (SMS code, captcha, identity check). Never automated. */
export class VerificationRequiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VerificationRequiredError'
  }
}

/**
 * The platform may already have the post (e.g. submit timed out after upload).
 * The target is marked 'unconfirmed' and never re-sent automatically, so nothing is posted twice.
 */
export class UnconfirmedError extends Error {
  constructor(
    message: string,
    public remoteId?: string
  ) {
    super(message)
    this.name = 'UnconfirmedError'
  }
}
