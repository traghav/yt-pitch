import { Buffer } from 'buffer'
import { execFile } from 'child_process'
import { access, mkdtemp, rm, writeFile } from 'fs/promises'
import { platform, tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { promisify } from 'util'

type CacheEntry = {
  expiresAt: number
  info: YtDlpInfo
}

type YtDlpFormat = {
  acodec?: string
  audio_channels?: number
  ext?: string
  format_id?: string
  format_note?: string
  height?: number
  protocol?: string
  tbr?: number
  url?: string
  vcodec?: string
}

type YtDlpInfo = {
  channel?: string
  duration?: number
  formats?: YtDlpFormat[]
  id: string
  thumbnail?: string
  title: string
  uploader?: string
  webpage_url?: string
}

const execFileAsync = promisify(execFile)
const INFO_CACHE_TTL_MS = 5 * 60 * 1000
const infoCache = new Map<string, CacheEntry>()

export async function getYoutubeInfo(url: string) {
  const cachedEntry = infoCache.get(url)

  if (cachedEntry && cachedEntry.expiresAt > Date.now()) {
    return cachedEntry.info
  }

  await ensureYtDlpBinary()

  const ytDlpArgs = ['--js-runtimes', 'node', '--dump-single-json', '--no-playlist']
  const cookieBundle = await createCookieFileIfConfigured()
  const extractorArgs = getEnvironmentVariable('YT_DLP_EXTRACTOR_ARGS')

  if (cookieBundle) {
    ytDlpArgs.push('--cookies', cookieBundle.cookieFilePath)
  }

  if (extractorArgs) {
    ytDlpArgs.push('--extractor-args', extractorArgs)
  }

  ytDlpArgs.push(url)

  let stdout: string

  try {
    const result = await execFileAsync(getYtDlpBinaryPath(), ytDlpArgs, {
      maxBuffer: 32 * 1024 * 1024,
    })

    stdout = result.stdout
  } catch (caughtError) {
    throw normalizeYtDlpError(caughtError)
  } finally {
    if (cookieBundle) {
      await rm(cookieBundle.cookieFilePath, { force: true })
      await rm(cookieBundle.cookieDirectory, { force: true, recursive: true })
    }
  }

  const info = JSON.parse(stdout) as YtDlpInfo
  infoCache.set(url, {
    expiresAt: Date.now() + INFO_CACHE_TTL_MS,
    info,
  })

  return info
}

export function validateYoutubeUrl(url: string) {
  try {
    const parsedUrl = new URL(url)
    const host = parsedUrl.hostname.replace(/^www\./, '')
    return (host === 'youtube.com' && parsedUrl.pathname === '/watch' && parsedUrl.searchParams.has('v')) || host === 'youtu.be'
  } catch {
    return false
  }
}

export function toMetadata(info: YtDlpInfo) {
  return {
    author: info.uploader ?? info.channel ?? 'Unknown creator',
    canonicalUrl: info.webpage_url ?? `https://www.youtube.com/watch?v=${info.id}`,
    durationSeconds: info.duration ?? 0,
    thumbnailUrl: info.thumbnail ?? '',
    title: info.title,
    videoId: info.id,
  }
}

export function pickAudioFormat(info: YtDlpInfo) {
  const formats = (info.formats ?? []).filter(
    (format) => Boolean(format.url) && format.acodec && format.acodec !== 'none' && format.vcodec === 'none',
  )

  const rankedFormats = formats.sort((left, right) => scoreAudioFormat(right) - scoreAudioFormat(left))
  return rankedFormats[0] ?? null
}

export function pickVideoFormat(info: YtDlpInfo) {
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

export function createProxyHeaders(upstreamResponse: Response, filename: string) {
  const headers = new Headers()
  const passthroughHeaderNames = [
    'accept-ranges',
    'cache-control',
    'content-length',
    'content-range',
    'content-type',
    'etag',
    'last-modified',
  ]

  for (const headerName of passthroughHeaderNames) {
    const headerValue = upstreamResponse.headers.get(headerName)

    if (headerValue) {
      headers.set(headerName, headerValue)
    }
  }

  headers.set('content-disposition', `inline; filename="${filename}"`)
  return headers
}

function getYtDlpBinaryPath() {
  const binaryName = platform() === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
  return fileURLToPath(new URL(`../../bin/${binaryName}`, import.meta.url))
}

async function ensureYtDlpBinary() {
  try {
    await access(getYtDlpBinaryPath())
  } catch {
    throw new Error('The yt-dlp binary is missing. Run npm install to download the extractor binary before starting the app.')
  }
}

async function createCookieFileIfConfigured() {
  const rawCookies = getEnvironmentVariable('YOUTUBE_COOKIES') ?? getEnvironmentVariable('YT_DLP_COOKIES')
  const base64Cookies = getEnvironmentVariable('YOUTUBE_COOKIES_BASE64') ?? getEnvironmentVariable('YT_DLP_COOKIES_BASE64')

  if (!rawCookies && !base64Cookies) {
    return null
  }

  const cookieText = rawCookies ?? decodeBase64(base64Cookies!)
  const cookieDirectory = await mkdtemp(`${tmpdir()}/yt-pitch-cookies-`)
  const cookieFilePath = `${cookieDirectory}/youtube-cookies.txt`

  await writeFile(cookieFilePath, cookieText, 'utf8')
  return {
    cookieDirectory,
    cookieFilePath,
  }
}

function normalizeYtDlpError(caughtError: unknown) {
  const stderr = getErrorStderr(caughtError)

  if (stderr.includes('Sign in to confirm you’re not a bot')) {
    return new Error(
      'YouTube blocked this server session. Configure YOUTUBE_COOKIES or YOUTUBE_COOKIES_BASE64 in Vercel with exported youtube.com cookies, then redeploy.',
    )
  }

  if (stderr) {
    return new Error(stderr.trim())
  }

  return caughtError instanceof Error ? caughtError : new Error('yt-dlp failed while loading YouTube metadata.')
}

function getErrorStderr(caughtError: unknown) {
  if (!caughtError || typeof caughtError !== 'object') {
    return ''
  }

  const maybeError = caughtError as { stderr?: string; message?: string }
  return maybeError.stderr ?? maybeError.message ?? ''
}

function getEnvironmentVariable(name: string) {
  const envContainer = globalThis as typeof globalThis & {
    process?: {
      env?: Record<string, string | undefined>
    }
  }

  return envContainer.process?.env?.[name]
}

function decodeBase64(value: string) {
  return Buffer.from(value, 'base64').toString('utf8')
}

function scoreAudioFormat(format: YtDlpFormat) {
  let score = format.tbr ?? 0

  if (format.ext === 'm4a') {
    score += 500
  }

  if (format.protocol === 'https') {
    score += 100
  }

  if ((format.audio_channels ?? 0) >= 2) {
    score += 25
  }

  return score
}

function scoreVideoFormat(format: YtDlpFormat) {
  let score = format.height ?? 0

  if (format.ext === 'mp4') {
    score += 500
  }

  if (format.protocol === 'https') {
    score += 250
  }

  if (format.acodec && format.acodec !== 'none') {
    score += 100
  }

  score += (format.tbr ?? 0) / 10
  return score
}
