import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const backendUrl = process.argv[2] ?? process.env.BACKEND_URL
const adminToken = process.argv[3] ?? process.env.ADMIN_TOKEN
const browser = process.argv[4] ?? process.env.COOKIE_BROWSER ?? 'chrome'
const ytDlpBinary = path.join(process.cwd(), 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')

if (!backendUrl || !adminToken) {
  console.error('Usage: npm run push:cookies -- <backend-url> <admin-token> [browser]')
  process.exit(1)
}

const tempDirectory = await mkdtemp(`${tmpdir()}/yt-pitch-cookie-push-`)
const rawCookiePath = path.join(tempDirectory, 'raw-cookies.txt')
const trimmedCookiePath = path.join(tempDirectory, 'trimmed-cookies.txt')

try {
  await execFileAsync(ytDlpBinary, [
    '--cookies-from-browser',
    browser,
    '--cookies',
    rawCookiePath,
    '--skip-download',
    'https://www.youtube.com/watch?v=jNQXAC9IVRw',
  ])
} catch (caughtError) {
  const stderr = caughtError?.stderr ?? caughtError?.message ?? ''
  if (!(await fileExists(rawCookiePath))) {
    throw new Error(stderr || 'Failed to export cookies from the local browser.')
  }
}

const rawCookieText = await readFile(rawCookiePath, 'utf8')
const filteredCookieText = trimCookieDomains(rawCookieText)

if (!filteredCookieText.includes('youtube.com') && !filteredCookieText.includes('google.com')) {
  throw new Error('The exported cookie file does not contain YouTube/Google cookies.')
}

await writeFile(trimmedCookiePath, filteredCookieText, 'utf8')

const response = await fetch(`${backendUrl.replace(/\/$/, '')}/api/admin/cookies`, {
  body: filteredCookieText,
  headers: {
    Authorization: `Bearer ${adminToken}`,
    'Content-Type': 'text/plain',
  },
  method: 'POST',
})

const responseText = await response.text()

if (!response.ok) {
  throw new Error(`Backend rejected the cookie upload: ${response.status} ${responseText}`)
}

console.log(responseText)

await rm(tempDirectory, { force: true, recursive: true })

function trimCookieDomains(cookieText) {
  const lines = cookieText.replace(/\r\n/g, '\n').split('\n')
  const keptLines = ['# Netscape HTTP Cookie File', '# Trimmed for youtube/google domains', '']

  for (const line of lines) {
    if (!line || line.startsWith('#')) continue

    const domain = line.split('\t')[0] ?? ''
    if (/youtube\.com$/.test(domain) || /google\.com$/.test(domain) || /googleapis\.com$/.test(domain) || /ytimg\.com$/.test(domain)) {
      keptLines.push(line)
    }
  }

  return `${keptLines.join('\n').trim()}\n`
}

async function fileExists(filePath) {
  try {
    await readFile(filePath)
    return true
  } catch {
    return false
  }
}
