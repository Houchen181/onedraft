import { useEffect, useRef, useState } from 'react'
import type { AgentItem } from '@shared/types'
import { call, on } from './api'

type AgentEvent =
  | { type: 'delta'; text: string }
  | { type: 'items'; items: AgentItem[] }
  | { type: 'busy'; busy: boolean }
  | { type: 'error'; message: string }

const TOOL_LABEL: Record<string, string> = {
  list_platforms: 'Looked at platforms',
  get_platform_rules: 'Read platform rules',
  list_accounts: 'Listed accounts',
  list_posts: 'Listed posts',
  get_post: 'Read post',
  create_post: 'Created a draft',
  update_post: 'Updated the draft',
  update_variant: 'Edited a version',
  validate_post: 'Checked the post',
  probe_media: 'Inspected media',
  fit_media: 'Made a rendition',
  cover_frame: 'Made a cover',
  approve_post: 'Asked to publish',
  cancel_post: 'Canceled',
  list_comments: 'Read comments',
  reply_comment: 'Replied to a comment',
  get_stats: 'Read stats',
  recent_activity: 'Read activity'
}

const SUGGESTIONS = [
  'Turn my newest draft into a tailored post for every connected account.',
  'Draft a Rednote note and a Bilibili video post in Chinese from a video I pick.',
  'What failed recently, and how do I fix it?',
  'Summarize the latest comments on my YouTube channel and draft replies.'
]

/** Very small formatter: **bold**, `code`, line breaks preserved by CSS. */
function Rich({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('**') && p.endsWith('**') ? (
          <b key={i}>{p.slice(2, -2)}</b>
        ) : p.startsWith('`') && p.endsWith('`') ? (
          <code key={i} className="mono">
            {p.slice(1, -1)}
          </code>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </>
  )
}

export function Assistant({ collapsed, onToggle, pending, onPendingTaken }: { collapsed: boolean; onToggle: () => void; pending?: string; onPendingTaken: () => void }) {
  const [items, setItems] = useState<AgentItem[]>([])
  const [stream, setStream] = useState('')
  const [busy, setBusy] = useState(false)
  const [engine, setEngine] = useState<string>()
  const [error, setError] = useState<string>()
  const [input, setInput] = useState('')
  const end = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void call<{ items: AgentItem[]; busy: boolean; engine: string }>('agent.history').then((h) => {
      setEngine(h.engine)
      setItems(h.items)
      setBusy(h.busy)
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
      setError((e as Error).message)
    }
  }

  useEffect(() => {
    if (pending && !busy) {
      void send(pending)
      onPendingTaken()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending])

  if (collapsed) {
    return (
      <aside className="assistant collapsed">
        <button className="btn ghost" style={{ margin: 6 }} onClick={onToggle} title="Open assistant">
          ✨
        </button>
      </aside>
    )
  }

  return (
    <aside className="assistant">
      <header>
        <span>✨ Assistant</span>
        {engine && <span className="pill" title={engine === "claude-code" ? "Runs on your Claude plan through Claude Code" : "Runs on a Claude API key"}>{engine === "claude-code" ? "Claude plan" : "API key"}</span>}
        {busy && <span className="pill accent">working…</span>}
        <span className="grow" />
        <button className="btn ghost sm" onClick={() => call('agent.reset')} title="Start a new conversation" disabled={busy}>
          New chat
        </button>
        <button className="btn ghost sm" onClick={onToggle} title="Hide">
          ⟩
        </button>
      </header>
      <div className="msgs">
        {!items.length && !stream && (
          <div className="stack">
            <div className="muted small">
              I can tailor one piece of content for every platform, convert media, schedule posts (you approve), and read comments. Try:
            </div>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {items.map((it, i) => {
          if (it.kind === 'user') return <div key={i} className="bubble user">{it.text}</div>
          if (it.kind === 'assistant')
            return (
              <div key={i} className="bubble assistant">
                <Rich text={it.text} />
              </div>
            )
          if (it.kind === 'tool')
            return (
              <details key={i} className="toolcall">
                <summary>
                  {it.result === undefined ? '⏳' : it.isError ? '⚠️' : '✓'} {TOOL_LABEL[it.name] ?? it.name}
                </summary>
                <pre>{JSON.stringify(it.input, null, 1)}</pre>
                {it.result && <pre>{it.result.slice(0, 4000)}</pre>}
              </details>
            )
          return (
            <div key={i} className="bubble error">
              {it.text}
            </div>
          )
        })}
        {stream && (
          <div className="bubble assistant">
            <Rich text={stream} />
          </div>
        )}
        {error && <div className="bubble error">{error}</div>}
        <div ref={end} />
      </div>
      <div className="composer stack">
        <textarea
          value={input}
          placeholder="Ask the assistant… (Enter to send, Shift+Enter for a new line)"
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
            Attach files
          </button>
          <span className="grow" />
          {busy ? (
            <button className="btn sm" onClick={() => call('agent.stop')}>
              Stop
            </button>
          ) : (
            <button className="btn primary sm" disabled={!input.trim()} onClick={() => send(input)}>
              Send
            </button>
          )}
        </div>
      </div>
    </aside>
  )
}
