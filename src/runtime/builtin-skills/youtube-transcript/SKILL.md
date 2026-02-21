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
    description: Subtitle language code (default en)
---

# YouTube Transcript

## Instructions

1. **Detect available subtitles** — Run `yt-dlp --list-subs "<url>"` to see what subtitle tracks exist. Note whether manual (human-created) or automatic (auto-generated) subtitles are available, and in which languages.

2. **Download subtitles** — Try in this order, using the requested language (default: `en`):
   - Manual subtitles first: `yt-dlp --write-sub --sub-lang <lang> --skip-download -o "transcript" "<url>"`
   - If no manual subs, fall back to auto-generated: `yt-dlp --write-auto-sub --sub-lang <lang> --skip-download -o "transcript" "<url>"`

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
- If no subtitles are available in any language, report that clearly
- If the requested language is unavailable, list what languages ARE available and use `ask_user` to confirm which one to use
- Do not download video or audio content — always use `--skip-download`
