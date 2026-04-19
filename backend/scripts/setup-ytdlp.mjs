import { chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const destination = path.join(process.cwd(), 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
const assetName = getAssetName()
const downloadUrl = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${assetName}`

await mkdir(path.dirname(destination), { recursive: true })

const response = await fetch(downloadUrl)

if (!response.ok) {
  throw new Error(`Failed to download yt-dlp from ${downloadUrl}: ${response.status} ${response.statusText}`)
}

const arrayBuffer = await response.arrayBuffer()
await writeFile(destination, Buffer.from(arrayBuffer))

if (process.platform !== 'win32') {
  await chmod(destination, 0o755)
}

console.log(`yt-dlp downloaded to ${destination}`)

function getAssetName() {
  if (process.platform === 'darwin') return 'yt-dlp_macos'
  if (process.platform === 'linux' && process.arch === 'x64') return 'yt-dlp_linux'
  if (process.platform === 'linux' && process.arch === 'arm64') return 'yt-dlp_linux_aarch64'
  if (process.platform === 'win32') return 'yt-dlp.exe'
  return 'yt-dlp'
}
