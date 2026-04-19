# yt-pitch

Responsive full-stack YouTube practice tool built with Vite, React, and Vercel Functions.

## What it does

- Accepts a public YouTube URL
- Pulls metadata and proxy streams through `/api`
- Plays a muted video preview alongside browser-processed audio
- Lets you change pitch and tempo independently
- Exports the processed result as a WAV download

## Stack

- Frontend: Vite + React + TypeScript
- Backend: Vercel Functions in `api/`
- Media lookup: `yt-dlp` standalone binary invoked from Vercel Functions
- Audio processing: `soundtouchjs`

## Local development

Install dependencies:

```bash
npm install
```

Frontend-only development:

```bash
npm run dev
```

Full-stack development with Vercel Functions:

```bash
npx vercel dev
```

`vercel dev` is the mode that serves both the Vite frontend and the `api/` routes together.

## Deploy to Vercel

1. Import the repository into Vercel.
2. Keep the default install command: `npm install`
3. Keep the default build command: `npm run build`
4. Output directory: `dist`
5. For production reliability, add either `YOUTUBE_COOKIES` or `YOUTUBE_COOKIES_BASE64` as a Vercel environment variable.

The app is designed as a Vite SPA with API routes in `/api`.

### Production YouTube Auth

YouTube often blocks server IPs with `Sign in to confirm you’re not a bot`.

This app supports:

- `YOUTUBE_COOKIES`: full Netscape/Mozilla `cookies.txt` contents
- `YOUTUBE_COOKIES_BASE64`: base64-encoded `cookies.txt` contents
- `YT_DLP_EXTRACTOR_ARGS`: optional raw `yt-dlp --extractor-args` value if you also want to pass visitor data or PO token settings

The cookie file must be in Netscape format, which yt-dlp documents here:
https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp

For YouTube-specific export guidance:
https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies

## Notes

- Public YouTube videos are the target use case.
- Export is done in the browser as WAV to avoid depending on ffmpeg in serverless.
- `npm install` downloads a platform-appropriate `yt-dlp` binary into `bin/`.
- Very long videos can be memory-heavy on mobile during export.
