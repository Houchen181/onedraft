# Platform research (checked 2026-11-12)

What each platform allows, and what we took from other tools. Re-check before relying on any number:
these change often. Sources are the official docs and the projects' own source files.

## YouTube — official Data API v3 (connector: `youtube`, kind `api`)
- OAuth: Google Cloud project → enable YouTube Data API v3 (+ Analytics API) → consent screen → client type **Desktop app**.
  Loopback `http://127.0.0.1:<any port>` + PKCE S256. Desktop client secrets are not secret (may ship in the app).
- **An External app left in "Testing" gets refresh tokens that die after 7 days.** Personal use: accept weekly re-login, or set it
  "In production" unverified (warning screen, 100-user cap). Distribution needs Google verification.
- 2026-11-02: uploads from unverified projects are **no longer forced private**.
- 2026-06-01 quota split: `videos.insert` has its own bucket, **100 uploads/day**; everything else shares 10,000 units/day
  (`comments.insert` / `thumbnails.set` / `videos.update` = 50, list calls = 1).
- Upload: resumable `POST https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`
  → `Location` session URI → `PUT` chunks (multiples of 256 KiB) with `Content-Range`; 308 = continue, 201 = done.
- Schedule: `status.privacyStatus=private` + `status.publishAt`. AI: `status.containsSyntheticMedia`. Kids: `status.selfDeclaredMadeForKids`.
- Comments: `commentThreads.list`, reply `comments.insert` (`snippet.parentId`). Analytics: `youtubeanalytics.googleapis.com/v2/reports`.

## Instagram — official Instagram Platform (connector: `instagram`, kind `api`)
- Professional (Business/Creator) account required.
- Personal path: Meta app (Business) → Instagram → "API setup with Instagram login" → Generate access token for your account
  (≈60-day long-lived token, refresh with `graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token`).
  Meta enforces HTTPS redirect URIs, so a loopback OAuth flow for other users needs an HTTPS relay page.
- Publish: create container `POST /{ig-id}/media` → poll `status_code` → `POST /{ig-id}/media_publish`.
  Images must be at a **public URL** (JPEG ≤ 8 MB). Reels: `video_url`, or resumable upload to
  `rupload.facebook.com/ig-api-upload/<ver>/<container>` — documented only for Facebook Login; untested with Instagram Login.
- Caption 2,200 chars / 30 hashtags; carousel up to 20 (docs; older docs said 10); Reels 3 s–15 min, ≤ 300 MB.
- ~100 API posts / 24 h (`/content_publishing_limit`). No API scheduling. AI: `is_ai_generated=true` on the container.

## TikTok — official Content Posting API (connector: `tiktok`, kind `api`)
- Login Kit for Desktop: redirect host `127.0.0.1`/`localhost` with a port (wildcard port allowed), PKCE mandatory with a
  **hex-encoded** SHA-256 challenge. Token exchange needs `client_secret` (a hosted token relay is needed before distribution).
  Access 2 h, refresh 180 days, rotate on every refresh.
- Direct post: `creator_info/query` → `video/init` (FILE_UPLOAD, chunks 5–64 MB, `total_chunk_count = floor(size/chunk)`)
  → `PUT` chunks → `status/fetch`. Draft ("inbox") mode: `inbox/video/init`, user finishes in the TikTok app.
- **Unaudited apps: posts are private (SELF_ONLY), max 5 users/day, the account must be private.** Audit needs: creator nickname
  shown, privacy dropdown with no default, interactions off by default, commercial-content toggle, music-usage consent, preview.
- Photos need PULL_FROM_URL from a verified domain. No scheduling. AI: `post_info.is_aigc`. No comments API in Content Posting.

## X — official API v2 (connector: `x`, kind `api`)
- Native App OAuth 2.0 + PKCE, no secret. Exact-match callback (fixed port, `127.0.0.1`). **Exchange the code within 30 s.**
- Pay-per-use: ~$0.015 per post, **$0.20 per post containing a URL**; reads $0.005.
- Media: `POST /2/media/upload/initialize` → `/{id}/append` (multipart, ≤ 5 MB segments) → `/{id}/finalize` → poll status.
- Post: `POST /2/tweets` with `media.media_ids`, `reply.in_reply_to_tweet_id`, `made_with_ai`. Up to 4 images or 1 video.

## Bilibili — biliup CLI (connector: `bilibili`, kind `cli`)
- Official open platform is **enterprise-only** (business licence + ICP). Fine for a later company build.
- `biliup` (MIT) — `github.com/biliup/biliup` (biliup-rs is archived). Windows asset `biliupR-v<ver>-x86_64-windows.zip`.
- Login is interactive only (needs a real console): `biliup -u <cookies.json> login` (QR / SMS / cookie). One cookie file per account.
- Upload: `biliup -u <file> upload <video> --title --desc --tag a,b --tid <n> --cover <img> --dtime <unix> --copyright 1|2 --source <url> --dynamic <text>`.
  Exit 0 = success (`投稿成功`), BV id parsed from the log. `601 上传过快` = rate limit. `--dtime` ≥ 4 h ahead.
- Title < 80, desc < 250 (open API) / 2000 (web), tags required. Non-member accounts: 5 posts/day.
- **AI declaration (创作声明) is not exposed by biliup or the API** — must be ticked in the creator centre.

## Rednote / Xiaohongshu — browser automation (connector: `rednote`, kind `browser`)
- No creator posting API (open platform = merchants; share SDK opens the phone app).
- Automate `creator.xiaohongshu.com/publish/publish` in a persistent, visible browser profile per account (selectors from
  social-auto-upload / xiaohongshu-mcp, kept as overridable data in the connector).
- Title ≤ 20 (ASCII counts half), body ≤ 1,000, ≤ 10 topics, native scheduling 1 h–14 days ahead, ~50 posts/day.
- One web session per account (logging in elsewhere logs us out). New accounts may be asked for real-name verification.
- **2026-08-06 rules penalise accounts run automatically by AI tools/scripts; undeclared AI content is labelled and throttled.**
  So the connector defaults to *handoff*: it fills the note and you press Publish. AI declaration: 内容类型声明 → 笔记含AI合成内容.
- Optional: `xiaohongshu-mcp` (Apache-2.0, Go) can be attached through the MCP bridge connector instead.

## China AI-labelling rules
CAC 《人工智能生成合成内容标识办法》 in force since 2025-09-01: users must declare AI content with the platform's tool.

## Ideas taken from other tools
| From | Idea |
|---|---|
| Postiz | Capability-based connector interface; typed errors; never re-run an accepted step ("unconfirmed"); expose platform rules to agents |
| Mixpost | Rate-limit errors carry the next attempt time; per-network content versions |
| social-auto-upload | login / check / upload verbs; prefer native scheduling; isolated browser profile per account |
| MultiPost | "Open a prefilled composer, user clicks Publish" (our handoff mode) |
| xiaohongshu-mcp | Platform rules in tool descriptions; agent-native surface |
| Typefully | Master + per-platform variants; publish needs explicit approval level |
| biliup | Use its uploader rather than re-implementing UPOS |
| Weaknesses seen | Temporal too heavy (→ SQLite state machine); unbounded waits (→ timeouts everywhere); selectors rot (→ selectors as data + failure screenshots) |
