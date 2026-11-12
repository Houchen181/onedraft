# Adding a platform

There are three ways, from least to most work.

## 1. MCP bridge (no code)

If an MCP server can already post to the platform, describe it in **Settings → Connectors → MCP bridges**:

```json
[
  {
    "id": "xhs-mcp",
    "name": "Rednote via xiaohongshu-mcp",
    "url": "http://localhost:18060/mcp",
    "video": true,
    "image": true,
    "nativeSchedule": true,
    "constraints": { "title": { "max": 20 }, "caption": { "max": 1000 }, "media": { "required": true } },
    "tools": {
      "check": { "name": "check_login_status" },
      "publishVideo": {
        "name": "publish_with_video",
        "args": { "title": "{{title}}", "content": "{{caption}}", "video": "{{video}}", "tags": "{{tags}}", "schedule_at": "{{publishAt}}" }
      },
      "publishImages": {
        "name": "publish_content",
        "args": { "title": "{{title}}", "content": "{{caption}}", "images": "{{images}}", "tags": "{{tags}}" }
      }
    }
  }
]
```

- Use `"url"` for Streamable HTTP servers, or `"command"` + `"args"` for stdio servers.
- `"{{x}}"` on its own keeps the value's type (arrays stay arrays; empty values are dropped).
  Inside a longer string it is interpolated.
- Available values: `title caption tags video images media cover publishAt aiGenerated options.<key>`.

## 2. Plugin (one JavaScript file)

Create `%APPDATA%\polycast\connectors\<name>\index.js` (CommonJS) exporting `connector`, then
**Settings → Connectors → Reload connectors**. Ask Claude Code to write one: point it at this file,
`src/core/connector.ts` and the platform's API docs.

```js
exports.connector = {
  manifest: {
    id: 'myplatform',              // lowercase, unique
    name: 'My Platform',
    kind: 'plugin',
    color: '#0a7cff',
    capabilities: { video: false, image: true, text: true, nativeSchedule: false, comments: false, reply: false, stats: false },
    constraints: { caption: { max: 500 }, image: { maxCount: 4 }, tags: { style: 'hashtags' } },
    settings: [],                   // app-level fields (API client ids…)
    connectFields: [{ key: 'token', label: 'API token', type: 'secret', required: true }],
    options: [],                    // per-post fields
    notes: ['Anything the user should know.']
  },
  async connect(ctx, input) {
    ctx.secrets.set({ token: input.token })            // encrypted by Polycast
    const me = await (await ctx.fetch('https://api.example/me', { headers: { authorization: `Bearer ${input.token}` } })).json()
    return { name: me.name, handle: '@' + me.handle, remoteUserId: String(me.id) }
  },
  async publish(ctx, account, { content, publishAt }) {
    const { token } = ctx.secrets.get()
    // content: { title, caption, tags, media (absolute paths), cover, options, aiGenerated }
    const r = await ctx.fetch('https://api.example/posts', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: content.caption })
    })
    if (!r.ok) throw new Error(`Post failed: ${r.status} ${await r.text()}`)
    const post = await r.json()
    return { remoteId: post.id, url: post.url, state: 'published' }
  }
}
```

### Rules every connector follows

- **Throw the right error.** Import nothing — match by `name` if you're writing plain JS:
  `NeedsLoginError` (reconnect), `RetryableError` (rate limit / 5xx, *only before the platform accepted
  anything*), `ContentError` (shown to the user, no retry), `VerificationRequiredError` (captcha/SMS — never
  automate), `UnconfirmedError` (it may be live; Polycast will never re-send it automatically).
  Built-in connectors import these from `src/core/connector.ts`.
- **Never post twice.** Once a platform has accepted an upload, any later failure is `UnconfirmedError`.
- **Respect the AI label.** If `content.aiGenerated`, set the platform's disclosure flag.
- **Put limits in the manifest**, not in code, so the validator, the UI and the AI all see them.
- **Browser connectors** use `ctx.browser(profileKey)` (a persistent profile per account), set explicit
  timeouts on every wait, prefer handoff (fill the form, let the person click), and save a screenshot on failure.

`ctx` also gives you `setting(key)`, `globalSetting(key)`, `log()`, `progress()`, `oauthLoopback()` (PKCE +
loopback redirect), `exec()` (run a CLI) and `paths`.

## 3. Built-in connector

Add `src/connectors/<id>.ts`, register it in `src/connectors/index.ts`, and add tests.
