# Polycast

An AI-native desktop app for running your own social media accounts from one place.
Write a post once, let the assistant tailor it for each platform, approve it, and Polycast publishes or
schedules it everywhere — YouTube, Bilibili, Rednote (小红书), Instagram, TikTok and X built in, and any
other platform through a plugin or an MCP server.

*Polycast is a working name.*

## Run it

```bash
npm install
npm run dev        # development, with hot reload
npm run build && npm start   # production build
npm test           # core tests (validation, publish state machine, media, OAuth, signing)
```

Windows 10/11 with Microsoft Edge (already installed) is all it needs; ffmpeg ships with it.
Data lives in `%APPDATA%\polycast` (set `POLYCAST_DATA` to use another folder). Logins and API keys are
encrypted with Windows' own protection (Electron `safeStorage`).

## How it works

```
 Compose (master post) ──► per-account variants ──► validate against platform rules
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
  and plugins (`%APPDATA%\polycast\connectors\<name>\index.js`).
- **Safe publishing**: the queue never re-sends something a platform may already have (`unconfirmed`),
  backs off on rate limits, and uses the platform's own scheduler when it has one (YouTube, Bilibili,
  Rednote), so your PC can be off at posting time. Otherwise Polycast keeps running in the tray.
- **AI-native**: the built-in assistant (Claude) and any MCP client share 25 tools. Drafting, checking rules,
  converting media (9:16, 3:4, blurred fill…), editing and generating video, and reading comments happen
  freely; **publishing and replies wait for your click** unless you turn on auto-approve.
- **Studio** ([docs/video.md](docs/video.md)): edit your own footage (trim, join, speed, text, burned-in captions,
  music with ducking, logo, crossfades, loudness, one-click silence removal), or have Claude make a video.
  Claude writes it as an HTML animation, Polycast renders it frame by frame to MP4, and it is always labelled
  AI-generated. Claude can *see* your footage (`view_frames`) to pick highlights and check its own renders.
- **AI labels**: mark a post AI-generated and each connector sets that platform's disclosure
  (`containsSyntheticMedia`, `is_aigc`, `made_with_ai`, `is_ai_generated`, Rednote's 内容类型声明).

## Platform setup (personal use)

| Platform | What you need | Caveats |
|---|---|---|
| YouTube | Google Cloud project → enable *YouTube Data API v3* → OAuth client type **Desktop app** → paste client ID/secret in Settings | While the OAuth app is in "Testing", Google expires logins every 7 days. 100 uploads/day. |
| Bilibili | Nothing — Polycast downloads [biliup](https://github.com/biliup/biliup) (MIT) when you connect; scan the QR code in its window | AI declaration (创作声明) must be ticked in the creator centre. Native schedule 4 h–15 days ahead. |
| Rednote | Nothing — a browser window opens; scan the QR code | Defaults to *handoff*: Polycast fills the note, you press 发布 (Rednote penalises automated accounts). |
| Instagram | Meta app (Business) → Instagram → *API setup with Instagram login* → generate a token for your Business/Creator account; paste it when connecting | Images need a public media host (Settings; any S3-compatible bucket such as Cloudflare R2). |
| TikTok | developers.tiktok.com app with Login Kit (Desktop) + Content Posting API; redirect `http://127.0.0.1:53682/callback/` | Until TikTok audits the app, posts are private and the account must be private. |
| X | console.x.com app, OAuth 2.0 type **Native App**, callback `http://127.0.0.1:53682/callback` | Pay-per-use: ~$0.015/post, ~$0.20 with a link. |

Research behind these choices: [docs/platform-research-2026-11.md](docs/platform-research-2026-11.md).

## The assistant: your Claude plan or an API key

Settings → AI → *Run the assistant on*:

- **Your Claude plan (default when Claude Code is installed).** Polycast starts the Claude Code on this computer
  (`claude`, signed in with your Pro/Max plan) with its built-in tools off and only Polycast's tools available
  through a private local MCP server. It uses your plan's usage limits and needs no API key. Polycast never reads
  or stores your Claude login, and removes any API key from Claude Code's environment so your plan is used.
  Your personal hooks, plugins and skills are not loaded into these runs.
  *For your own use:* Anthropic does not allow apps to offer Claude plan sign-in to other people, so a build
  for other users should use API keys (or have them connect their own Claude app over MCP, below).
- **A Claude API key**, billed per use (Messages API, Claude Opus 5.5 by default).

Either way, publishing and replies still wait for your click.

## Use it from Claude Code

Settings → *Use Polycast from Claude Code* → turn on the MCP server, then copy the command shown, e.g.

```bash
claude mcp add --transport http polycast http://127.0.0.1:7341/mcp --header "Authorization: Bearer <token>"
```

## Add a platform

See [docs/writing-a-connector.md](docs/writing-a-connector.md) — a plugin is one `index.js`; an MCP bridge is a
few lines of JSON. [examples/bluesky-plugin](examples/bluesky-plugin/index.js) is a complete example.

## Layout

```
src/shared/      types shared by UI and main process
src/core/        store (node:sqlite), engine (publish state machine), validation, media + edit (ffmpeg), studio, OAuth, tools
src/connectors/  youtube, bilibili, rednote, instagram, tiktok, x, mcp-bridge, plugin loader
src/main/        Electron main: IPC, browser profiles, AI agent, MCP server, HTML-to-video composer, Windows voices, tray
src/renderer/    React UI: Compose, Studio, Posts, Accounts, Activity, Settings, assistant panel
test/            vitest suite
```
