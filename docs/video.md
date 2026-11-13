# Video in OneDraft

Studio (sidebar → **Studio**) handles two kinds of video. Both are saved as projects you can reopen,
change and render again. Original files are never modified.

## 1. Editing videos you shot or cut yourself

An **edit** is a list of clips plus extras, rendered by ffmpeg in one pass:

| Part | What it does |
|---|---|
| Clips | Any number of videos/images in order; trim (in/out), speed 0.25–4×, mute, volume; images held for N s |
| Shape | Keep, 16:9, 9:16, 1:1, 4:5, 3:4; fill with blurred background, crop, or black bars |
| Transitions | Hard cuts or crossfades |
| Text | Titles/labels at top/centre/bottom with times on the finished video; Chinese + Latin (Microsoft YaHei) |
| Captions | Import `.srt`, burned in at the bottom (wrapped to fit vertical video) |
| Sound | Music with automatic ducking under speech, −14 LUFS loudness levelling, fade in/out |
| Logo | Image watermark in any corner |
| Cut silences | Detects pauses and keeps only the speech (with a little padding) |

Open a video from a post (the ✂ button on its media), or **Studio → Edit a video**. Then either edit by hand or
type what you want in **Ask Claude to edit it**. The assistant looks at the footage (`view_frames` shows it
real frames, `analyze_video` finds silences and scene cuts) and writes the edit for you.

## 2. Videos Claude makes

Claude writes the video as an HTML page, and OneDraft renders it **frame by frame** to MP4. The page is
loaded offscreen with no network access. Every frame is captured exactly, so a render never stutters or
drops frames, however slow the computer is.

- **Studio → Make a video with AI** describes what you want; Claude writes it, renders it, checks frames and fixes problems.
- **Start from a template** gives an editable HTML title card (no AI key needed).
- Narration uses the voices built into Windows (`list_voices`). Chinese narration needs a Chinese voice:
  Windows Settings → Time & language → Speech → Add voices.
- Everything rendered this way is stored under `media\generated` and **always carries the AI-generated
  label**. That includes edits and renditions that use it, and posts that include it (YouTube
  `containsSyntheticMedia`, TikTok `is_aigc`, X `made_with_ai`, Instagram `is_ai_generated`, Rednote's
  declaration; a reminder for Bilibili).

### The HTML contract (for writing compositions by hand or from Claude Code)

- The page is `width×height`: 1080×1920 (9:16), 1920×1080 (16:9), 1080×1080 (1:1), 1080×1350 (4:5),
  1080×1440 (3:4). `window.ONEDRAFT = { width, height, duration, fps }`.
- Animate with CSS `@keyframes` and `animation-delay`, CSS transitions, or the Web Animations API. OneDraft
  pauses every animation and sets its time for each frame.
- For canvas / JS drawing define `window.onedraftSeek = (t) => { …draw the frame at t seconds… }` (may be async).
  Optional `window.onedraftReady = async () => { …preload… }`.
- `<video>` elements are seeked to the frame time (muted). Their sound isn't captured; use `music` or narration.
- Don't use `setTimeout`, `setInterval` or `requestAnimationFrame` for timing.
- No network. Inline assets (SVG, `data:` URIs) or use local files as `file:///C:/…` URLs.

## From Claude Code (MCP)

With the MCP server on (Settings), these tools are available alongside the posting tools:
`analyze_video`, `view_frames` (returns images), `edit_video`, `generate_video`, `list_voices`,
`list_projects`, `get_project`.
