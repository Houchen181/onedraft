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
  Exit 0 = success (the log says the submission succeeded), BV id parsed from the log. Error 601 ("uploading too fast") = rate limit. `--dtime` ≥ 4 h ahead.
- Title < 80, desc < 250 (open API) / 2000 (web), tags required. Non-member accounts: 5 posts/day.
- **The AI-content declaration is not exposed by biliup or the API** — must be ticked in the creator centre.

## Rednote / Xiaohongshu — browser automation (connector: `rednote`, kind `browser`)
- No creator posting API (open platform = merchants; share SDK opens the phone app).
- Automate `creator.xiaohongshu.com/publish/publish` in a persistent, visible browser profile per account (selectors from
  social-auto-upload / xiaohongshu-mcp, kept as overridable data in the connector).
- Title ≤ 20 (ASCII counts half), body ≤ 1,000, ≤ 10 topics, native scheduling 1 h–14 days ahead, ~50 posts/day.
- One web session per account (logging in elsewhere logs us out). New accounts may be asked for real-name verification.
- **2026-08-06 rules penalise accounts run automatically by AI tools/scripts; undeclared AI content is labelled and throttled.**
  So the connector defaults to *handoff*: it fills the note and you press Publish. AI declaration: the content-type declaration → "contains AI-generated content".
- Optional: `xiaohongshu-mcp` (Apache-2.0, Go) can be attached through the MCP bridge connector instead.

## Setting up your own developer app (re-checked 2026-11-16, for the in-app walkthroughs)
From the docs, without signing in to any console; the walkthroughs live in each connector's `manifest.guide`.
- **YouTube**: the 2026-11-02 lift of the private lock is confirmed (Data API revision history). Client secrets are
  shown only when the client is created (then hashed; "Add secret" makes a new one). **Publish app** has been reported
  greyed out since about 2026-08 until Branding has a home page and privacy-policy link on an authorized domain
  (github.com links reportedly fail, github.io pages work), so the walkthrough keeps the app in Testing with the
  person as a test user (re-login every 7 days) and makes publishing optional. Unverified production apps: 100 users
  for the project's life.
- **X**: developer access is console.x.com, pay-per-use only for new developers ("Legacy Free"). Credits first
  ($5 minimum, card; a zero balance blocks every call with 402 CreditsDepleted; $20 bonus after the first purchase).
  Since 2026-04-20: post $0.015, post with a URL $0.20, reads $0.005 per post, `GET /2/users/me` $0.01 (so the
  periodic account check only refreshes the token). Native App = public client, no secret; a Client Secret on screen
  means the wrong app type (`unauthorized_client`).
- **TikTok**: production keys don't work until TikTok approves the app, and its review rejects personal upload tools,
  so a personal app stays in **Sandbox** (up to 10 target users; sandbox keys start `sbaw`). Sandbox Direct Post =
  SELF_ONLY on a private account, so the connector defaults to *upload to inbox* (drafts, ≤ 5 pending per 24 h): the
  person posts from the TikTok app (reports on public accounts in Sandbox are mixed). Register the Desktop redirect
  URI exactly, trailing slash included.
- **Instagram**: **new Meta apps (from late Oct 2026) can't set up "API setup with Instagram login"**; they get
  "Unified login" (a business-portfolio app and a system-user token for graph.facebook.com), which the connector doesn't
  support yet. Older apps still work: Instagram-login tokens start with `IGAA`, last 60 days and refresh with
  `ig_refresh_token`. Development mode is enough for your own account (Standard Access, no App Review).

## Connecting without developer apps (2026-11-17)
After people hit the developer-app setups: YouTube, TikTok, Instagram and X also connect by **signing in on the
website** (`src/connectors/web.ts`), the default; the official APIs stay as the advanced way.
- **Sign-in window**: a plain Edge/Chrome started on the account's profile with `--remote-debugging-port` only (no
  `--enable-automation`, no page attached), because Google and others refuse or challenge automated sign-ins. OneDraft
  reads cookies over a browser-level DevTools connection and closes the window when the login cookie appears:
  YouTube `LOGIN_INFO` (.youtube.com), TikTok `sessionid`/`sid_tt`, Instagram `sessionid` (id in `ds_user_id`),
  X `auth_token` (id in `twid`). Posting uses Playwright on the same profile, launched without `--enable-automation`
  and with `AutomationControlled` off (`navigator.webdriver` is false), and hands the filled-in page to the person.
- **Upload pages** (`WEB_SELECTORS`, from maintained uploaders' source, 2026-11, not yet run against signed-in
  pages): YouTube `www.youtube.com/upload` → `input[name=Filedata]`, `#title-textarea #textbox`,
  `#description-textarea #textbox`, `VIDEO_MADE_FOR_KIDS_(NOT_)MFK` radios, `#next-button` ×3, `#privacy-radios`
  (social-auto-upload, QianFan-Sync, youtube-uploader; `#hashtag` suggestions cover Next: Escape). TikTok
  `tiktokstudio/upload` (no iframe now) → `input[accept="video/*"]`, wait for `[data-e2e=caption_container]`,
  Draft.js caption; type hashtags one by one (pasted ones stay plain and can stall the editor); tours/tips to dismiss
  (QianFan-Sync, tiktok-uploader). Instagram → New post → (Post) → dialog `input[accept*="video/mp4"]` (photos too,
  ≤ 10), Reels OK, Next ×2 (heading changes), Lexical caption `[data-lexical-editor=true]` (social-auto-upload,
  MultiPost, opencli). X `compose/post` → `fileInput`, wait for `attachments` before the text (a late upload resets
  Draft.js), `tweetTextarea_0` (opencli, baoyu-skills). Sign-in cookies: YouTube `LOGIN_INFO` is dropped on cookie
  rotation, `__Secure-3PAPISID` isn't (yt-dlp); TikTok also `sessionid_ss`; X `auth_token` + `ct0`.
- **TikTok developer apps**: apps created after 2024-09-09 must verify the Terms, Privacy and Web/Desktop URLs
  (domain or URL-prefix signature file); in Sandbox this applies once the Content Posting API is added. github.com
  URLs can't be verified (a `/blob/` page isn't the raw file); a GitHub Pages site you own can. So that way needs a
  website of your own.
- **Bilibili**: `biliup login` is an interactive menu (dialoguer) and exits with "not a terminal" when started from an
  app. OneDraft does the same TV QR-code login itself (`passport-tv-login/qrcode/auth_code` and `/poll`, biliup's TV
  app key, md5 sign of the sorted query) and writes biliup's `LoginInfo` file, so uploads and `renew` keep working.
- **Pressure test (2026-11-17, before 0.1.3)**: four parallel runs (code review; real Edge headless; fixture pages
  served by Playwright routing; the built app driven end to end) found what these rely on, now in the code and
  `test/web-accounts.test.ts`:
  - A WebSocket silently drops what is sent after it closed, so a DevTools client must reject on close, or a sign-in
    window closed by the person leaves Connect waiting forever. Closing Edge's last window ends the browser ~0.2 s later.
  - A fresh Edge profile signs in to the Windows work/school Microsoft account even with `--disable-sync` (and gets
    Bing/MSN/M365 cookies): `--disable-features=msImplicitSignin` stops it. Playwright's own launches don't do it.
    Playwright also passes `--edge-skip-compat-layer-relaunch` and `--do-not-de-elevate` (Edge may restart itself).
  - Cookie domains must match on a dot boundary (`auth_token` on `.notx.com` or `.dropbox.com` is not X's).
  - An expired session shows the site's sign-in page: YouTube → `accounts.google.com`, TikTok → `/login`, X →
    `/i/flow/login`, Instagram keeps `instagram.com/` and shows the sign-in form (a password box gives it away).
  - X's `/compose/post` is a dialog over the Home timeline, whose own composer has the same test ids: scope to
    `[role=dialog]`. Without a `dialog` listener Playwright answers the site's alerts and "Leave site?" itself.
  - Bilibili TV QR codes didn't expire within 7 minutes (always 86039); one dropped poll shouldn't end the login.
- **Second pressure test (same day)**, on the fixed version:
  - Playwright launches Chromium with `--no-sandbox` unless `chromiumSandbox: true`; with `--enable-automation`
    removed nothing hides Chromium's "unsupported command-line flag" bar either. The posting windows are the
    person's: sandbox on, and Playwright's test-only "unsafe" switches left out.
  - Edge's implicit sign-in also happens in Playwright's windows: the first launch on a fresh profile signed it in to
    the Windows work/school account (its email as the profile's user, 13 Bing/MSN cookies). A browser takes only the
    last `--disable-features`, so OneDraft repeats Playwright's list (1.65) and adds `msImplicitSignin`.
  - `--remote-debugging-port` lets any local program (other Windows users included) read a profile's cookies while
    the window is open; `--remote-debugging-pipe` (fds 3/4, NUL-terminated JSON) keeps DevTools to OneDraft.
  - **Found in 0.1.3**: Chromium sets `navigator.webdriver` for `--remote-debugging-pipe` (as for `--enable-automation`
    and `--headless`), and Google's sign-in then refuses the window ("Couldn't sign you in: this browser or app may
    not be secure"). `--disable-blink-features=AutomationControlled` turns it off; measured on Edge 157, headed.
  - **Found in 0.1.4**: Bilibili's TV-app QR login (biliup's) answers `48007 当前账号暂不支持在本APP登录` for some
    accounts, such as ones registered with Google or email that have no mainland China phone number. Bilibili's own
    TV app is refused the same way ([newBV #322](https://github.com/Frost819/newBV/issues/322); [PiliBTRTV #1](https://github.com/gordonpow/PiliBTRTV/issues/1)
    saw the HD app's SMS login refused too). biliup also *submits* through the TV app (`submit_by_app` signs with the
    TV key), so these accounts can't post with biliup at all. Bilibili's website login takes them, so Bilibili got the
    website way: sign in on passport.bilibili.com and fill in member.bilibili.com/platform/upload/video/frame, with
    selectors from MultiPost-Extension's Bilibili uploader. Signed out, that page redirects to
    passport.bilibili.com/login (checked). The TV QR endpoint also makes codes for biliup's Android key
    (`783bbb72…`); it answers -403 for `1d8b6e7d…` and for the BCut key.
  - **Found in 0.1.4**: Rednote's sign-in window stayed open after signing in. OneDraft counted a sign-in only on the
    first tab, on creator.xiaohongshu.com past /login, with nothing whose class contains "login-box" showing. Closing
    the window then deleted the new profile, sign-in included. It now counts Rednote's creator sign-in cookies
    (`galaxy_creator_session_id`, `access-token-creator.xiaohongshu.com`, `customer-sso-sid`, as community tools'
    cookie exports show; a visitor gets only `a1`, `webId`, `gid`, `xsecappid` and the like) in any tab. A creator
    page past the sign-in, in any tab, still counts too. A closed window's profile is read again before giving up.
    Signed out, creator pages redirect to /login?redirectReason=401 (checked).
  - **Found in 0.1.5**, from the first real post to all six accounts (YouTube, TikTok, Instagram and X filled in and
    handed over):
    - Bilibili's upload page now runs its own uploader, BUploader. It keeps a hidden `input[name=buploader]` that a
      click on the upload area opens; a file put in the upload area's own hidden box (MultiPost's selector) starts
      nothing. OneDraft now clicks the area and answers the file box that opens. The page shows in English for an
      English browser ("Creator Hub"), so the tag box is found inside `.tag-input-wrp`.
    - Rednote: a scan first signs in to Rednote's shared login (`customer-sso-sid`, `x-user-id-open…`,
      `customerClientId`); the creator site's own cookies come after. 0.1.5 counted the shared login and closed the
      window too early, so posting found the account signed out. Only the creator site's cookies count now.
    - Sign-in windows now give the site a few seconds to leave its sign-in page before closing (Bilibili's sets
      `SESSDATA`, then goes on to bilibili.com).
    - Bilibili posts said "signed out" three times within minutes of connecting, then worked without a new sign-in.
      Unexplained. Bilibili no longer counts a password box as signed out (its redirect does), and every post that
      decides "signed out" now saves a screenshot.
  - A natively scheduled target keeps status `scheduled` after its time: "still to go out" needs `scheduled_at > now`.
  - bsdtar killed mid-unpack leaves a truncated exe: unpack beside the target and move it into place when complete.
  - PowerShell's `-WorkingDirectory` takes wildcards (`[`/`]` need escaping); `Start-Process` with a `.cmd` lets cmd.exe
    re-parse the arguments.

## China AI-labelling rules
The CAC's Measures for Labeling AI-Generated Synthetic Content, in force since 2025-09-01: users must declare AI content with the platform's tool.

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
| ChatCut | Edit by transcript (delete words, fillers, pauses); word-timed captions; the agent's edits are ordinary edits you can adjust |
| OpenCut (classic, MIT) | Play the whole edit before exporting; timeline with playhead and split; undo/redo for every edit; editor keys (Space, J/K/L, S); captions you can correct. The rewrite's plan (editor API, MCP server, headless rendering) matches OneDraft's tools |
| Weaknesses seen | Temporal too heavy (→ SQLite state machine); unbounded waits (→ timeouts everywhere); selectors rot (→ selectors as data + failure screenshots) |
