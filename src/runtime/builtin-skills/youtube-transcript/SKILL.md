---
name: youtube-transcript
description: Extract transcripts from YouTube videos. Downloads subtitles using yt-dlp and returns clean plain text. Use when the agent needs to read or summarize video content.
inputs:
  - name: url
    type: string
    required: true
    description: YouTube video URL
  - name: language
    type: string
    required: false
    description: Preferred subtitle language code (default from user profile or task context; falls back to video's original language)
---

# YouTube Transcript

## Instructions

1. **Detect available subtitles** — Run `yt-dlp --js-runtimes node --remote-components ejs:github --list-subs "<url>"` to see what subtitle tracks exist. Note whether manual (human-created) or automatic (auto-generated) subtitles are available, and in which languages.

2. **Download subtitles** — Try in this order, using the requested language (prefer the user's language from context, e.g. `ru` for Russian-speaking users; fall back to the video's original language if not specified):
   - Manual subtitles first: `yt-dlp --js-runtimes node --remote-components ejs:github --impersonate chrome --write-sub --sub-lang <lang> --skip-download -o "transcript" "<url>"`
   - If no manual subs, fall back to auto-generated: `yt-dlp --js-runtimes node --remote-components ejs:github --impersonate chrome --write-auto-sub --sub-lang <lang> --skip-download -o "transcript" "<url>"`
   - If auto-generated subs for the requested language fail with HTTP 429, the video's original language may differ. Check `--list-subs` output for the original language, download subs in that language instead, and note the language in your response.

3. **Find the subtitle file** — Look for `transcript.*.vtt` in the workspace. The file will be named like `transcript.en.vtt`.

4. **Convert to plain text** — Read the `.vtt` file and clean it:
   - Remove the `WEBVTT` header and any metadata lines
   - Remove timestamp lines (lines matching `HH:MM:SS.mmm --> HH:MM:SS.mmm`)
   - Remove position/alignment tags (e.g., `align:start position:0%`)
   - Strip HTML tags (e.g., `<c>`, `</c>`, `<b>`, etc.)
   - Remove duplicate consecutive lines (auto-generated subs repeat lines across cue boundaries)
   - Trim blank lines, join into paragraphs

5. **Return the transcript** — Return the cleaned text as your final response. Include the video title if shown in yt-dlp output.

## Important notes

- Always quote the URL in commands (it may contain special characters)
- Always use `--js-runtimes node --remote-components ejs:github --impersonate chrome` flags — YouTube requires browser impersonation and JS challenge solving
- If no subtitles are available in any language, report that clearly
- If the requested language is unavailable, list what languages ARE available and use `ask_user` to confirm which one to use
- Do not download video or audio content — always use `--skip-download`
- If you get HTTP 429 (Too Many Requests), wait 5 seconds and retry once. If it persists, try a different subtitle language (the video's original language is less likely to be rate-limited)
