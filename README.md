# OneDraft

An AI-native desktop app for posting everywhere from one draft.
Write a post once, let Claude tailor it for each platform, approve it, and OneDraft publishes or
schedules it everywhere — YouTube, Bilibili, Rednote, Instagram, TikTok and X built in, and any
other platform through a plugin or an MCP server. Then answer the comments from one Inbox.

![The post editor: one panel per platform](docs/screenshots/4-editor-rednote.png)

## How you use it

- **One you, one account per platform.** Connect your YouTube, Rednote, Bilibili, Instagram, TikTok and X in
  Settings → Platforms. Signing in with a different account replaces the old one.
- **Chat** is home: ask Claude for a post, an edit or a new video. Nothing goes out until you approve.
- **Posts** opens the editor. The **main post** is shared by every platform; click a platform on the left to
  open its own panel. Fields it hasn't changed follow the main post (*↳ from main*); edit one and it becomes
  *● custom* for that platform only; *↺ use main* puts it back. The right side previews how that platform shows it.
- **Inbox** gathers the comments on your YouTube, X and Instagram posts. Answer them in place, or let Claude
  draft replies (✨); nothing is sent until you press *Send reply*. It looks for new ones when you open it and every
  30 minutes in the background (or only when you ask). TikTok, Bilibili and Rednote don't let apps read comments.
- **Numbers**: published posts show their views, likes and comments, added up on the Posts list and per platform
  in the editor (with a *Comments* link to that post's comments).
- **Calendar** shows the week's scheduled and published posts. **Studio** edits and makes videos.

| | |
|---|---|
| ![Chat](docs/screenshots/1-chat.png) | ![Posts](docs/screenshots/2-posts.png) |
| ![Main post](docs/screenshots/3-editor-main.png) | ![YouTube follows the main post](docs/screenshots/5-editor-youtube.png) |
| ![Inbox with a reply Claude drafted](docs/screenshots/10-inbox.png) | ![A published post's numbers on YouTube](docs/screenshots/11-post-numbers.png) |
| ![Calendar](docs/screenshots/7-calendar.png) | ![Settings → Platforms](docs/screenshots/8-settings.png) |

## Run it

```bash
npm install
npm run dev        # development, with hot reload
npm run build && npm start   # production build
npm test           # core tests (validation, publish state machine, inbox, media, OAuth, signing)
```

Windows 10/11 with Microsoft Edge (already installed) is all it needs; ffmpeg ships with it.
Data lives in `%APPDATA%\onedraft` (set `ONEDRAFT_DATA` to use another folder). Logins and API keys are
encrypted with Windows' own protection (Electron `safeStorage`).

## How it works

```
 Main post ──► one version per platform ──► validate against platform rules
        ▲                                                   │
   AI assistant ─┐                                          ▼
   MCP clients ──┴─► same tool set ──► approval card ──► queue (SQLite state machine)
                                                            │
                         ┌──────────────┬──────────────┬────┴─────────┬───────────────┐
                    official API     browser        CLI (biliup)    MCP bridge      plugin
                  YouTube IG TikTok X   Rednote       Bilibili       any MCP server   any JS
```

- **One connector interface** (`src/core/connector.ts`): a manifest (capabilities, limits, settings,
  per-post options, caveats) plus `connect / check / publish` and optional `listComments / reply / stats`.
  The UI, the validator and the AI all read the same manifest.
- **Five kinds of connector**: official API, browser automation (Playwright driving your installed Edge,
  one persistent profile per account), CLI (biliup for Bilibili), MCP bridge (any MCP server that can post),
  and plugins (`%APPDATA%\onedraft\connectors\<name>\index.js`).
- **Safe publishing**: the queue never re-sends something a platform may already have (`unconfirmed`),
  backs off on rate limits, and uses the platform's own scheduler when it has one (YouTube, Bilibili,
  Rednote), so your PC can be off at posting time. Otherwise OneDraft keeps running in the tray.
- **AI-native**: the built-in assistant (Claude) and any MCP client share 27 tools. Drafting, checking rules,
  converting media (9:16, 3:4, blurred fill…), editing and generating video, reading comments and drafting
  replies (`draft_reply` leaves them in the Inbox) happen freely; **publishing waits for your click** unless you
  turn on auto-approve, and **replies always do**.
- **Inbox** (`src/core/inbox.ts`): YouTube and Instagram are read for the whole account; X per post, for posts
  from the last 7 days (its search window), asking only for replies newer than the last one seen, because X bills
  every read. Comments that were already two weeks old when first seen are filed as done. Your own replies and
  thread parts are left out. Each platform's numbers are stored under common names (views, likes, comments,
  shares, saves) plus its extras (Bilibili coins, X quotes, Instagram reach).
- **Studio** ([docs/video.md](docs/video.md)): edit your own footage (trim, join, speed, text, burned-in captions,
  music with ducking, logo, crossfades, loudness, one-click silence removal), or have Claude make a video.
  Claude writes it as an HTML animation, OneDraft renders it frame by frame to MP4, and it is always labelled
  AI-generated. Claude can *see* your footage (`view_frames`) to pick highlights and check its own renders.
- **AI labels**: mark a post AI-generated and each connector sets that platform's disclosure
  (`containsSyntheticMedia`, `is_aigc`, `made_with_ai`, `is_ai_generated`, Rednote's AI-content declaration).

## Platform setup (personal use)

| Platform | What you need | Caveats |
|---|---|---|
| YouTube | Google Cloud project → enable *YouTube Data API v3* → OAuth client type **Desktop app** → paste client ID/secret in Settings | While the OAuth app is in "Testing", Google expires logins every 7 days. 100 uploads/day. |
| Bilibili | Nothing — OneDraft downloads [biliup](https://github.com/biliup/biliup) (MIT) when you connect; scan the QR code in its window | The AI-content declaration must be turned on in the creator centre. Native schedule 4 h–15 days ahead. |
| Rednote | Nothing — a browser window opens; scan the QR code | Defaults to *handoff*: OneDraft fills the note, you press Publish (Rednote penalises automated accounts). |
| Instagram | Meta app (Business) → Instagram → *API setup with Instagram login* → generate a token for your Business/Creator account; paste it when connecting | Images need a public media host (Settings; any S3-compatible bucket such as Cloudflare R2). |
| TikTok | developers.tiktok.com app with Login Kit (Desktop) + Content Posting API; redirect `http://127.0.0.1:53682/callback/` | Until TikTok audits the app, posts are private and the account must be private. |
| X | console.x.com app, OAuth 2.0 type **Native App**, callback `http://127.0.0.1:53682/callback` | Pay-per-use: ~$0.015/post, ~$0.20 with a link; reading a reply ~$0.005 (the Inbox reads each one once). |

Research behind these choices: [docs/platform-research-2026-11.md](docs/platform-research-2026-11.md).

## The assistant: your Claude plan or an API key

Settings → AI → *Run the assistant on*:

- **Your Claude plan (default when Claude Code is installed).** OneDraft starts the Claude Code on this computer
  (`claude`, signed in with your Pro/Max plan) with its built-in tools off and only OneDraft's tools available
  through a private local MCP server. It uses your plan's usage limits and needs no API key. OneDraft never reads
  or stores your Claude login, and removes any API key from Claude Code's environment so your plan is used.
  Your personal hooks, plugins and skills are not loaded into these runs.
  *For your own use:* Anthropic does not allow apps to offer Claude plan sign-in to other people, so a build
  for other users should use API keys (or have them connect their own Claude app over MCP, below).
- **A Claude API key**, billed per use (Messages API, Claude Opus 5.5 by default).

Either way, publishing and replies still wait for your click.

## Use it from Claude Code

Settings → *Use OneDraft from Claude Code* → turn on the MCP server, then copy the command shown, e.g.

```bash
claude mcp add --transport http onedraft http://127.0.0.1:7341/mcp --header "Authorization: Bearer <token>"
```

## Add a platform

See [docs/writing-a-connector.md](docs/writing-a-connector.md) — a plugin is one `index.js`; an MCP bridge is a
few lines of JSON. [examples/bluesky-plugin](examples/bluesky-plugin/index.js) is a complete example.

## Layout

```
src/shared/      types shared by UI and main process
src/core/        store (node:sqlite), engine (publish state machine), inbox (comments + numbers), validation, media + edit (ffmpeg), studio, OAuth, tools
src/connectors/  youtube, bilibili, rednote, instagram, tiktok, x, mcp-bridge, plugin loader
src/main/        Electron main: IPC, browser profiles, AI agent, MCP server, HTML-to-video composer, Windows voices, tray
src/renderer/    React UI: Chat, Posts + post editor (platform panels), Inbox, Calendar, Studio, Settings
test/            vitest suite
```
