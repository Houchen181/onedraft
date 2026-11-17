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
type what you want in **Ask Claude to edit it**. The assistant reads the footage (`transcribe_video`), looks at it
(`view_frames` shows it real frames, `analyze_video` finds silences and scene cuts) and writes the edit for you.

### The preview

**Preview** plays the whole edit as it will come out, without rendering: clips in order with their cuts skipped
and at their speed, framed to the output shape (crop, black bars or a blurred background), with on-screen text,
captions from speech (the word being said lights up), music, logo and fades. Crossfades only show in the render.
The strip under it shows each kept stretch (the selected clip darker) and the caption lines; click it to jump.

Keys: **Space** play/pause · **←/→** 1 s · **J/L** 5 s · **,/.** one frame · **Home/End** · **K** pause ·
**S** splits the clip under the playhead in two · **Ctrl+Z / Ctrl+Y** undo and redo any change to the edit,
including one Claude made.

### Editing by what is said

Pick a clip and open **What’s said** → **Transcribe this clip**. Every word appears with its time:

- **Drag across words, then Delete** to take them out (a retake, a tangent); select struck words and Delete again
  to put them back. **Double-click** a word to play from there; the transcript follows the player.
- **Remove fillers** drops “um”, “uh”, “嗯”, “呃” (underlined). Words like “like” or “就是” often mean something,
  so they are left for you (or Claude) to judge.
- **Fix word** (or select one word and press **Enter**) corrects what Whisper misheard, such as names and places;
  the captions use your spelling.
- **Shorten pauses to 0.4 s** (or 0.2–0.8 s) tightens every longer silence; a ⏸ chip marks pauses of 0.8 s or
  more, and clicking one cuts it down or puts it back.
- With **skip cuts while playing**, the player jumps over what you took out, so you hear the edit.

The cuts are stored on the clip (`cuts`: stretches of the source, in seconds) and rendered on the video frame
grid, with the sound cut on the same grid, so lips and words stay in sync however many cuts there are.

**Captions → From what is said** burns in captions made from the transcript, timed to every word that survives
your cuts: *word by word* (the word being said lights up), *pop* (big, a few words at a time, for shorts),
*clean* or *on a dark band*, at the bottom, middle or top. Chinese is captioned character by character.

Speech-to-text runs **Whisper on your computer** (whisper.cpp v1.9.5 with the large-v3-turbo model): set it up
once in **Settings → Speech-to-text**. It downloads the GPU build (685 MB) when there is an NVIDIA card, else the
CPU build (9 MB), plus the model (574 MB), each checked against its published SHA-256. On an RTX-class GPU a
minute of speech takes a few seconds; transcripts are cached per file. Nothing is uploaded.

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
`transcribe_video`, `fix_transcript`, `analyze_video`, `view_frames` (returns images), `edit_video`,
`generate_video`, `list_voices`, `list_projects`, `get_project`.

`transcribe_video` returns the sentences with their word numbers and times, the filler words and the long pauses
(`words: true` adds every word). `edit_video` takes them directly on a clip — `removeWords: [[12, 18]]`,
`keepWords: [[0, 40], [96, 130]]` (a highlight), `removeFillers: true`, `maxPauseSec: 0.4` — plus
`autoCaptions: {style: 'pop'}`, so “cut the ums and make a 45 s vertical short with captions” is one call.
