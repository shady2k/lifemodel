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
    description: Output language for the transcript/summary. If provided and differs from the video's original language, translate the output. Does not affect which subtitles are downloaded — always use originals.
---

# YouTube Transcript

## Instructions

1. **Detect original language** — Run `yt-dlp --js-runtimes node --remote-components ejs:github --list-subs "<url>"` to see what subtitle tracks exist. Identify the video's **original language** — it appears as the source in the `Available automatic captions` section (typically listed with `(Original)` or as the first/only manual subtitle track).

2. **Download subtitles in the original language** — Always download in the video's original language (most reliable, best quality, least likely to be rate-limited). Try in this order:
   - Manual subtitles first: `yt-dlp --js-runtimes node --remote-components ejs:github --impersonate chrome --write-sub --sub-lang <orig_lang> --skip-download -o "transcript" "<url>"`
   - If no manual subs, fall back to auto-generated: `yt-dlp --js-runtimes node --remote-components ejs:github --impersonate chrome --write-auto-sub --sub-lang <orig_lang> --skip-download -o "transcript" "<url>"`

3. **Find the subtitle file** — Look for `transcript.*.vtt` in the workspace. The file will be named like `transcript.en.vtt`.

4. **Convert to plain text** — Read the `.vtt` file and clean it:
   - Remove the `WEBVTT` header and any metadata lines
   - Remove timestamp lines (lines matching `HH:MM:SS.mmm --> HH:MM:SS.mmm`)
   - Remove position/alignment tags (e.g., `align:start position:0%`)
   - Strip HTML tags (e.g., `<c>`, `</c>`, `<b>`, etc.)
   - Remove duplicate consecutive lines (auto-generated subs repeat lines across cue boundaries)
   - Trim blank lines, join into paragraphs

5. **Save the cleaned transcript** — Write the cleaned plain text to `transcript.txt` in the workspace root. This file is automatically persisted as an artifact for later reference. Do NOT delete it.

6. **Return the transcript** — Return the cleaned text as your final response. Include the video title if shown in yt-dlp output. If a `language` input was provided and differs from the original language, translate your output into the requested language. If no `language` input was provided, return in the original language.

## Important notes

- Always quote the URL in commands (it may contain special characters)
- Always use `--js-runtimes node --remote-components ejs:github --impersonate chrome` flags — YouTube requires browser impersonation and JS challenge solving
- If no subtitles are available in any language, report that clearly
- If the original language subtitles are unavailable, list what languages ARE available and use `ask_user` to confirm which one to use
- Do not download video or audio content — always use `--skip-download`
- If you get HTTP 429 (Too Many Requests), wait 5 seconds and retry once
