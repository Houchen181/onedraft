import { useEffect, useRef, useState } from 'react'
import type { AgentItem } from '@shared/types'
import { call, on } from '../api'
import { useApp } from '../ui'

type AgentEvent =
  | { type: 'delta'; text: string }
  | { type: 'items'; items: AgentItem[] }
  | { type: 'busy'; busy: boolean }
  | { type: 'error'; message: string }

const STEP: Record<string, string> = {
  list_platforms: 'Looked at platforms',
  get_platform_rules: 'Checked platform rules',
  list_accounts: 'Listed your platforms',
  list_posts: 'Looked at posts',
  get_post: 'Read the post',
  create_post: 'Created a draft',
  update_post: 'Updated the draft',
  update_variant: 'Edited a platform version',
  validate_post: 'Checked limits',
  probe_media: 'Inspected media',
  fit_media: 'Made a resized version',
  cover_frame: 'Made a cover',
  approve_post: 'Asked you to approve',
  cancel_post: 'Canceled',
  list_comments: 'Read comments',
  reply_comment: 'Replied to a comment',
  get_stats: 'Read stats',
  recent_activity: 'Read activity',
  analyze_video: 'Analyzed the video',
  view_frames: 'Watched the video',
  edit_video: 'Edited a video',
  generate_video: 'Made a video',
  list_voices: 'Listed voices',
  list_projects: 'Looked at Studio',
  get_project: 'Opened a Studio project'
}

const SUGGESTIONS = [
  'Turn my newest video into posts for every platform I’ve connected.',
  'Edit my talking video: cut the ums, retakes and long pauses, and add word-by-word captions.',
  'What’s scheduled this week, and is anything failing?',
  'Make a 15-second animated teaser for my next post.'
]

/** Group consecutive tool calls into one row of step chips. */
type Block = { kind: 'user' | 'ai' | 'err'; text: string } | { kind: 'steps'; items: Extract<AgentItem, { kind: 'tool' }>[] }
function blocks(items: AgentItem[]): Block[] {
  const out: Block[] = []
  for (const it of items) {
    if (it.kind === 'tool') {
      const last = out[out.length - 1]
      if (last?.kind === 'steps') last.items.push(it)
      else out.push({ kind: 'steps', items: [it] })
    } else out.push({ kind: it.kind === 'user' ? 'user' : it.kind === 'assistant' ? 'ai' : 'err', text: it.text })
  }
  return out
}

function Steps({ items }: { items: Extract<AgentItem, { kind: 'tool' }>[] }) {
  const [open, setOpen] = useState<string>()
  const shown = items.find((i) => i.id === open)
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="steps">
        {items.map((t) => (
          <span key={t.id} className={`step ${t.isError ? 'err' : ''}`} onClick={() => setOpen(open === t.id ? undefined : t.id)}>
            {t.result === undefined ? '… ' : t.isError ? '! ' : '✓ '}
            {STEP[t.name] ?? t.name}
          </span>
        ))}
      </div>
      {shown && (
        <div className="step-detail">
          {JSON.stringify(shown.input, null, 1)}
          {shown.result ? `\n\n${shown.result.slice(0, 3000)}` : ''}
        </div>
      )}
    </div>
  )
}

export function Chat({ pending, onPendingTaken }: { pending?: string; onPendingTaken: () => void }) {
  const app = useApp()
  const [items, setItems] = useState<AgentItem[]>([])
  const [stream, setStream] = useState('')
  const [busy, setBusy] = useState(false)
  const [engine, setEngine] = useState<string>()
  const [error, setError] = useState<string>()
  const [input, setInput] = useState('')
  const end = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void call<{ items: AgentItem[]; busy: boolean; engine: string }>('agent.history').then((h) => {
      setItems(h.items)
      setBusy(h.busy)
      setEngine(h.engine)
    })
    return on('agent', (e) => {
      const ev = e as AgentEvent
      if (ev.type === 'delta') setStream((s) => s + ev.text)
      else if (ev.type === 'items') {
        setItems(ev.items)
        setStream('')
      } else if (ev.type === 'busy') setBusy(ev.busy)
      else if (ev.type === 'error') setError(ev.message)
    })
  }, [])

  // Braces matter: newer Chromium returns a Promise from scrollIntoView, which React would take as a cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [items, stream, error])

  const send = async (text: string) => {
    const t = text.trim()
    if (!t || busy) return
    setError(undefined)
    setInput('')
    try {
      await call('agent.send', t)
    } catch (e) {
      // Not sent (e.g. Claude was still busy): give the text back instead of losing it.
      setInput((cur) => cur || t)
      setError((e as Error).message)
    }
  }

  useEffect(() => {
    // A request handed over from another page: send it, or keep it in the box if Claude is busy.
    if (pending) {
      if (busy) setInput(pending)
      else void send(pending)
      onPendingTaken()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending])

  return (
    <div className="chat">
      <div className="chat-head">
        <h1>Chat</h1>
        {engine && <span className="pill">{engine === 'claude-code' ? 'Claude plan' : 'Claude API'}</span>}
        {busy && <span className="pill custom">working…</span>}
        <span className="grow" />
        <button className="btn ghost sm" onClick={() => app.newPost()}>
          + New post
        </button>
        <button className="btn ghost sm" disabled={busy} onClick={() => call('agent.reset')}>
          New chat
        </button>
      </div>
      <div className="chat-feed">
        <div className="chat-col">
          {!items.length && !stream && (
            <div style={{ marginTop: '8vh' }}>
              <h1 style={{ fontSize: 30 }}>What are we posting?</h1>
              <p className="sub">
                Ask for a post, a video edit or a whole new video. Claude drafts it; nothing goes out until you approve.
              </p>
              <div className="suggest">
                {SUGGESTIONS.map((s) => (
                  <button key={s} onClick={() => send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {blocks(items).map((b, i) =>
            b.kind === 'steps' ? (
              <Steps key={i} items={b.items} />
            ) : (
              <div key={i} className={b.kind === 'user' ? 'msg-user' : b.kind === 'ai' ? 'msg-ai' : 'msg-err'}>
                {b.text}
              </div>
            )
          )}
          {stream && <div className="msg-ai">{stream}</div>}
          {error && <div className="msg-err">{error}</div>}
          <div ref={end} />
        </div>
      </div>
      <div className="composer">
        <textarea
          value={input}
          placeholder="Ask for a post, an edit, a video…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send(input)
            }
          }}
        />
        <div className="row">
          <button
            className="btn sm"
            onClick={async () => {
              const files = await call<string[]>('media.pick')
              if (files.length) setInput((s) => `${s}${s ? '\n' : ''}${files.join('\n')}`)
            }}
          >
            + Media
          </button>
          <span className="grow" />
          {busy ? (
            <button className="btn sm" onClick={() => call('agent.stop')}>
              Stop
            </button>
          ) : (
            <button className="send" disabled={!input.trim()} onClick={() => send(input)} title="Send">
              ↑
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
