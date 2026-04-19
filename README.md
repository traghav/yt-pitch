# yt-pitch

Responsive YouTube practice tool built with a Vite frontend and a dedicated extraction backend.

## Architecture

- Frontend: Vite + React + TypeScript
- Audio processing: browser-side with `soundtouchjs`
- Durable backend: self-hosted Node/Express service running `yt-dlp`
- Cookie refresh flow: local helper script pushes fresh browser cookies to the backend

The backend exists because YouTube extraction from Vercel serverless is not operationally stable. For a small userbase, a single lightweight stateful backend is the pragmatic fix.

## Frontend

Install and run:

```bash
npm install
npm run dev
```

Optional frontend env:

- `VITE_API_BASE_URL=https://your-backend.example.com`

Example file: [`.env.example`](./.env.example)

If `VITE_API_BASE_URL` is unset, the frontend still falls back to `/api`.

## Dedicated Backend

The dedicated backend lives in [`backend/`](./backend) and is intended to run outside Vercel.

Install and run locally:

```bash
cd backend
npm install
npm run dev
```

Environment variables:

- `PORT`: defaults to `8080`
- `CORS_ORIGIN`: comma-separated allowed origins, or `*`
- `ADMIN_TOKEN`: required for the cookie admin endpoints
- `YOUTUBE_COOKIE_FILE`: persistent cookie file path, defaults to `/data/youtube-cookies.txt`
- `YOUTUBE_COOKIES` or `YOUTUBE_COOKIES_BASE64`: optional bootstrap fallback if no persistent cookie file exists
- `YT_DLP_EXTRACTOR_ARGS`: optional raw `yt-dlp --extractor-args` value

Example file: [`backend/.env.example`](./backend/.env.example)

Admin endpoints:

- `GET /api/admin/status`
- `POST /api/admin/cookies`
- `DELETE /api/admin/cookies`

All admin endpoints require:

```http
Authorization: Bearer <ADMIN_TOKEN>
```

## Cookie Refresh Workflow

The intended operational flow is:

1. Run the backend on a small persistent host.
2. Mount persistent storage at `/data` so the cookie file survives restarts.
3. Refresh the backend cookies from your local logged-in browser whenever YouTube starts blocking again.

Local helper:

```bash
npm run push:cookies -- https://your-backend.example.com your-admin-token
```

This script:

- exports cookies from your local Chrome session using `yt-dlp --cookies-from-browser`
- trims them to YouTube/Google domains
- uploads them to `POST /api/admin/cookies`

## Deployment Target

This repo includes a Fly.io example config in [`backend/fly.toml`](./backend/fly.toml).

Why Fly for this backend:

- It supports persistent attached volumes for small stateful apps.
- Its app config supports mounting volumes directly in `fly.toml`.

Official docs:

- Fly app config and `fly.toml`: https://fly.io/docs/reference/configuration/
- Fly volumes: https://fly.io/docs/volumes/

The included Fly config mounts a volume at `/data`, which is where the backend stores `youtube-cookies.txt`.

Example deployment flow:

```bash
brew install flyctl
flyctl auth login
cd backend
flyctl apps create yt-pitch-backend
flyctl volumes create yt_pitch_data --size 1 --region sin
flyctl secrets set ADMIN_TOKEN=replace-me CORS_ORIGIN=https://yt-pitch.vercel.app
flyctl deploy
cd ..
npm run push:cookies -- https://yt-pitch-backend.fly.dev replace-me
vercel env add VITE_API_BASE_URL production
# value: https://yt-pitch-backend.fly.dev
vercel deploy --prod --yes
```

## Current Vercel App

The frontend can still be deployed on Vercel, but the durable extraction path should point at the dedicated backend:

- Frontend: `yt-pitch.vercel.app`
- Backend: your own stateful host

## Notes

- This is more durable than Vercel serverless, but not mathematically permanent. YouTube can still change extraction requirements.
- The backend design makes cookie refresh an operational task instead of a redeploy task.
- For a very small userbase, a single backend instance plus persistent cookie storage is a reasonable tradeoff.
