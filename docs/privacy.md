# OneDraft privacy policy

OneDraft is a desktop app that runs on your own computer. It has no server of its own, and its authors receive none
of your data.

**What OneDraft keeps, on your computer only.** Your drafts, media, edits, settings, and the keys and sign-ins for
the accounts you connect. They live in OneDraft's folder (`%APPDATA%\OneDraft`). Keys and sign-ins are encrypted
with Windows' own data protection.

**What it sends, and to whom.**

- To the platforms you connect (for example YouTube, X, TikTok, Instagram, Bilibili, Rednote): what you ask it to
  post, and requests to read back your own posts' comments and numbers so it can show them to you.
- To the AI service you choose for the assistant (Claude, through Claude Code or an Anthropic API key): the requests
  you type and what the assistant needs to answer them.
- To the media host you set up, if any (your own storage bucket): photos Instagram needs to fetch from a public
  address. They're deleted after posting.
- To GitHub and Hugging Face: downloads of OneDraft's updates and of tools you choose to set up (speech-to-text,
  the Bilibili uploader).

Speech-to-text and narration run on your computer.

**What it doesn't do.** No analytics, no ads, no tracking, and no selling or sharing of your data.

**Removing your data.** Disconnect an account in Settings → Platforms to delete its sign-in from OneDraft. To remove
everything, uninstall OneDraft and delete the `%APPDATA%\OneDraft` folder. To revoke OneDraft's access on a
platform's side, remove it in that platform's connected-apps settings.

Questions: [open an issue](https://github.com/Houchen181/onedraft/issues).
