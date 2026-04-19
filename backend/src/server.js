import { Buffer } from 'buffer'
import { execFile } from 'child_process'
import cors from 'cors'
import express from 'express'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'fs/promises'
import { platform, tmpdir } from 'os'
import { dirname } from 'path'
import { Readable } from 'stream'
import { fileURLToPath } from 'url'
import { promisify } from 'util'

const app = express()
const execFileAsync = promisify(execFile)
const INFO_CACHE_TTL_MS = 5 * 60 * 1000
const MAX_BUFFER_BYTES = 32 * 1024 * 1024
const DEFAULT_COOKIE_FILE = '/data/youtube-cookies.txt'
const infoCache = new Map()

app.use(
  cors({
    origin: getCorsOrigin(),
  }),
)
app.use(express.json({ limit: '512kb' }))
app.use(express.text({ limit: '512kb', type: ['text/plain', 'application/x-netscape-cookie', 'text/cookie'] }))

app.get('/health', async (_request, response) => {
  response.json({
    adminConfigured: Boolean(getEnvironmentVariable('ADMIN_TOKEN')),
    hasPersistentCookies: await hasPersistentCookieFile(),
    ytDlpBinaryPath: getYtDlpBinaryPath(),
  })
})

app.get('/api/metadata', async (request, response) => {
  const youtubeUrl = request.query.url?.toString().trim()

  if (!youtubeUrl || !validateYoutubeUrl(youtubeUrl)) {
    response.status(400).json({ error: 'That does not look like a valid YouTube watch link.' })
    return
  }

  try {
    const info = await getYoutubeInfo(youtubeUrl)
    response.json(toMetadata(info))
  } catch (caughtError) {
    response.status(500).json({ error: toErrorMessage(caughtError) })
  }
})

app.get('/api/media', handleMediaRequest)
app.head('/api/media', handleMediaRequest)

app.get('/api/admin/status', requireAdmin, async (_request, response) => {
  const cookieFilePath = getPersistentCookieFilePath()
  const cookieStats = await getCookieFileStats(cookieFilePath)

  response.json({
    cookieFilePath,
    hasPersistentCookies: Boolean(cookieStats),
    lastUpdatedAt: cookieStats?.mtime.toISOString() ?? null,
    sizeBytes: cookieStats?.size ?? 0,
  })
})

app.post('/api/admin/cookies', requireAdmin, async (request, response) => {
  const cookieText = typeof request.body === 'string' ? request.body : request.body?.cookieText

  if (!cookieText || typeof cookieText !== 'string') {
    response.status(400).json({ error: 'Provide cookie text as plain text or { "cookieText": "..." }.' })
    return
  }

  if (!cookieText.includes('youtube.com') && !cookieText.includes('google.com')) {
    response.status(400).json({ error: 'The uploaded cookie file does not appear to contain YouTube/Google cookies.' })
    return
  }

  const cookieFilePath = getPersistentCookieFilePath()
  await mkdir(dirname(cookieFilePath), { recursive: true })
  await writeFile(cookieFilePath, normalizeCookieText(cookieText), 'utf8')
  infoCache.clear()

  const cookieStats = await stat(cookieFilePath)

  response.json({
    ok: true,
    lastUpdatedAt: cookieStats.mtime.toISOString(),
    path: cookieFilePath,
    sizeBytes: cookieStats.size,
  })
})

app.delete('/api/admin/cookies', requireAdmin, async (_request, response) => {
  const cookieFilePath = getPersistentCookieFilePath()
  await rm(cookieFilePath, { force: true })
  infoCache.clear()
  response.json({ ok: true })
})

const port = Number(getEnvironmentVariable('PORT') ?? 8080)
app.listen(port, () => {
  console.log(`yt-pitch backend listening on :${port}`)
})

async function handleMediaRequest(request, response) {
  const youtubeUrl = request.query.url?.toString().trim()
  const kind = request.query.kind?.toString()

  if (!youtubeUrl || !validateYoutubeUrl(youtubeUrl)) {
    response.status(400).json({ error: 'That does not look like a valid YouTube watch link.' })
    return
  }

  if (kind !== 'audio' && kind !== 'video') {
    response.status(400).json({ error: 'Use kind=audio or kind=video.' })
    return
  }

  try {
    const info = await getYoutubeInfo(youtubeUrl)
    const format = kind === 'audio' ? pickAudioFormat(info) : pickVideoFormat(info)

    if (!format?.url) {
      response.status(404).json({ error: `No compatible ${kind} stream was found for this video.` })
      return
    }

    const upstreamHeaders = new Headers()
    const range = request.get('range')
    if (range) upstreamHeaders.set('range', range)

    const upstreamResponse = await fetch(format.url, { headers: upstreamHeaders })

    if (!upstreamResponse.ok) {
      response.status(502).json({ error: `The upstream ${kind} stream could not be fetched.` })
      return
    }

    const metadata = toMetadata(info)
    const extension = kind === 'audio' ? format.ext ?? 'm4a' : 'mp4'
    const proxyHeaders = createProxyHeaders(upstreamResponse, `${metadata.videoId}.${extension}`)

    response.status(upstreamResponse.status)

    proxyHeaders.forEach((value, key) => {
      response.setHeader(key, value)
    })

    if (request.method === 'HEAD' || !upstreamResponse.body) {
      response.end()
      return
    }

    Readable.fromWeb(upstreamResponse.body).pipe(response)
  } catch (caughtError) {
    response.status(500).json({ error: toErrorMessage(caughtError) })
  }
}

async function getYoutubeInfo(url) {
  const cachedEntry = infoCache.get(url)
  if (cachedEntry && cachedEntry.expiresAt > Date.now()) return cachedEntry.info

  await ensureYtDlpBinary()

  const ytDlpArgs = ['--js-runtimes', 'node', '--dump-single-json', '--no-playlist']
  const cookieSource = await resolveCookieSource()
  const extractorArgs = getEnvironmentVariable('YT_DLP_EXTRACTOR_ARGS')

  if (cookieSource) {
    ytDlpArgs.push('--cookies', cookieSource.cookieFilePath)
  }

  if (extractorArgs) {
    ytDlpArgs.push('--extractor-args', extractorArgs)
  }

  ytDlpArgs.push(url)

  try {
    const result = await execFileAsync(getYtDlpBinaryPath(), ytDlpArgs, {
      maxBuffer: MAX_BUFFER_BYTES,
    })
    const info = JSON.parse(result.stdout)
    infoCache.set(url, {
      expiresAt: Date.now() + INFO_CACHE_TTL_MS,
      info,
    })
    return info
  } catch (caughtError) {
    throw normalizeYtDlpError(caughtError)
  } finally {
    if (cookieSource?.cleanup) {
      await cookieSource.cleanup()
    }
  }
}

function validateYoutubeUrl(url) {
  try {
    const parsedUrl = new URL(url)
    const host = parsedUrl.hostname.replace(/^www\./, '')
    return (host === 'youtube.com' && parsedUrl.pathname === '/watch' && parsedUrl.searchParams.has('v')) || host === 'youtu.be'
  } catch {
    return false
  }
}

function toMetadata(info) {
  return {
    author: info.uploader ?? info.channel ?? 'Unknown creator',
    canonicalUrl: info.webpage_url ?? `https://www.youtube.com/watch?v=${info.id}`,
    durationSeconds: info.duration ?? 0,
    thumbnailUrl: info.thumbnail ?? '',
    title: info.title,
    videoId: info.id,
  }
}

function pickAudioFormat(info) {
  const formats = (info.formats ?? []).filter(
    (format) => Boolean(format.url) && format.acodec && format.acodec !== 'none' && format.vcodec === 'none',
  )

  return formats.sort((left, right) => scoreAudioFormat(right) - scoreAudioFormat(left))[0] ?? null
}

function pickVideoFormat(info) {
  const formats = (info.formats ?? []).filter(
    (format) => Boolean(format.url) && format.vcodec && format.vcodec !== 'none' && format.ext === 'mp4',
  )

  const progressiveFormats = formats.filter((format) => format.protocol === 'https' && format.acodec && format.acodec !== 'none')
  const directVideoOnlyFormats = formats.filter((format) => format.protocol === 'https')
  const preferredFormats = progressiveFormats.length > 0 ? progressiveFormats : directVideoOnlyFormats.length > 0 ? directVideoOnlyFormats : formats

  const mobileFriendly = preferredFormats
    .filter((format) => (format.height ?? 0) <= 720)
    .sort((left, right) => scoreVideoFormat(right) - scoreVideoFormat(left))[0]

  return mobileFriendly ?? preferredFormats.sort((left, right) => scoreVideoFormat(right) - scoreVideoFormat(left))[0] ?? null
}

function createProxyHeaders(upstreamResponse, filename) {
  const headers = new Headers()

  for (const headerName of ['accept-ranges', 'cache-control', 'content-length', 'content-range', 'content-type', 'etag', 'last-modified']) {
    const headerValue = upstreamResponse.headers.get(headerName)
    if (headerValue) headers.set(headerName, headerValue)
  }

  headers.set('content-disposition', `inline; filename="${filename}"`)
  return headers
}

function getYtDlpBinaryPath() {
  const binaryName = platform() === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
  return fileURLToPath(new URL(`../bin/${binaryName}`, import.meta.url))
}

async function ensureYtDlpBinary() {
  await access(getYtDlpBinaryPath())
}

async function resolveCookieSource() {
  const persistentCookieFile = getPersistentCookieFilePath()

  try {
    await access(persistentCookieFile)
    return {
      cookieFilePath: persistentCookieFile,
      cleanup: null,
    }
  } catch {
    // Fall through to env-based cookies.
  }

  const rawCookies = getEnvironmentVariable('YOUTUBE_COOKIES') ?? getEnvironmentVariable('YT_DLP_COOKIES')
  const base64Cookies = getEnvironmentVariable('YOUTUBE_COOKIES_BASE64') ?? getEnvironmentVariable('YT_DLP_COOKIES_BASE64')

  if (!rawCookies && !base64Cookies) {
    return null
  }

  const cookieText = normalizeCookieText(rawCookies ?? Buffer.from(base64Cookies, 'base64').toString('utf8'))
  const cookieDirectory = await mkdtemp(`${tmpdir()}/yt-pitch-backend-cookies-`)
  const cookieFilePath = `${cookieDirectory}/youtube-cookies.txt`

  await writeFile(cookieFilePath, cookieText, 'utf8')

  return {
    cookieFilePath,
    cleanup: async () => {
      await rm(cookieDirectory, { force: true, recursive: true })
    },
  }
}

function getPersistentCookieFilePath() {
  return getEnvironmentVariable('YOUTUBE_COOKIE_FILE') ?? DEFAULT_COOKIE_FILE
}

async function hasPersistentCookieFile() {
  try {
    await access(getPersistentCookieFilePath())
    return true
  } catch {
    return false
  }
}

async function getCookieFileStats(cookieFilePath) {
  try {
    return await stat(cookieFilePath)
  } catch {
    return null
  }
}

function requireAdmin(request, response, next) {
  const adminToken = getEnvironmentVariable('ADMIN_TOKEN')

  if (!adminToken) {
    response.status(503).json({ error: 'ADMIN_TOKEN is not configured on this backend.' })
    return
  }

  const header = request.get('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''

  if (token !== adminToken) {
    response.status(401).json({ error: 'Unauthorized.' })
    return
  }

  next()
}

function normalizeYtDlpError(caughtError) {
  const stderr = getErrorStderr(caughtError)

  if (stderr.includes('Sign in to confirm you’re not a bot')) {
    return new Error(
      'YouTube blocked this backend session. Refresh the backend cookie file with POST /api/admin/cookies or run the local push:cookies helper again.',
    )
  }

  if (stderr) {
    return new Error(stderr.trim())
  }

  return caughtError instanceof Error ? caughtError : new Error('yt-dlp failed while loading YouTube metadata.')
}

function getErrorStderr(caughtError) {
  if (!caughtError || typeof caughtError !== 'object') return ''
  return caughtError.stderr ?? caughtError.message ?? ''
}

function normalizeCookieText(cookieText) {
  const trimmed = cookieText.replace(/\r\n/g, '\n').trim()

  if (trimmed.startsWith('# Netscape HTTP Cookie File')) {
    return `${trimmed}\n`
  }

  return `# Netscape HTTP Cookie File\n${trimmed}\n`
}

function scoreAudioFormat(format) {
  let score = format.tbr ?? 0
  if (format.ext === 'm4a') score += 500
  if (format.protocol === 'https') score += 100
  if ((format.audio_channels ?? 0) >= 2) score += 25
  return score
}

function scoreVideoFormat(format) {
  let score = format.height ?? 0
  if (format.ext === 'mp4') score += 500
  if (format.protocol === 'https') score += 250
  if (format.acodec && format.acodec !== 'none') score += 100
  score += (format.tbr ?? 0) / 10
  return score
}

function getEnvironmentVariable(name) {
  return process.env[name]
}

function toErrorMessage(caughtError) {
  return caughtError instanceof Error ? caughtError.message : 'Unexpected backend error.'
}

function getCorsOrigin() {
  const configured = getEnvironmentVariable('CORS_ORIGIN')

  if (!configured || configured === '*') {
    return true
  }

  const allowedOrigins = configured
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)

  return (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true)
      return
    }

    callback(new Error('Blocked by CORS'))
  }
}
