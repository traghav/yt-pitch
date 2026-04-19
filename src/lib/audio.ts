import { PitchShifter, SimpleFilter, SoundTouch, WebAudioBufferSource } from 'soundtouchjs'

type PitchControllerOptions = {
  audioBuffer: AudioBuffer
  audioContext: AudioContext
  onEnded: () => void
  onTimeUpdate: (timePlayed: number) => void
  pitchSemitones: number
  tempo: number
}

export type PitchController = {
  connect: () => void
  disconnect: () => void
  dispose: () => void
  getCurrentTime: () => number
  seek: (seconds: number) => void
  setPitchSemitones: (semitones: number) => void
  setTempo: (tempo: number) => void
}

const PROCESSING_CHUNK_SIZE = 4096

export async function decodeAudioFromUrl(audioContext: AudioContext, url: string) {
  const response = await fetch(url)

  if (!response.ok) {
    throw new Error('Unable to fetch the source audio stream.')
  }

  const audioData = await response.arrayBuffer()
  return audioContext.decodeAudioData(audioData.slice(0))
}

export function createPitchController(options: PitchControllerOptions): PitchController {
  const { audioBuffer, audioContext, onEnded, onTimeUpdate, pitchSemitones, tempo } = options
  const gainNode = audioContext.createGain()
  const shifter = new PitchShifter(audioContext, audioBuffer, 2048, onEnded)

  gainNode.connect(audioContext.destination)
  shifter.pitchSemitones = pitchSemitones
  shifter.tempo = tempo

  shifter.on('play', (detail) => {
    onTimeUpdate(detail.timePlayed)
  })

  let connected = false

  return {
    connect() {
      if (!connected) {
        shifter.connect(gainNode)
        connected = true
      }
    },
    disconnect() {
      if (connected) {
        shifter.disconnect()
        connected = false
      }
    },
    dispose() {
      if (connected) {
        shifter.disconnect()
        connected = false
      }
    },
    getCurrentTime() {
      return shifter.timePlayed
    },
    seek(seconds) {
      const duration = Math.max(audioBuffer.duration, 0.001)
      const safeSeconds = clamp(seconds, 0, duration)

      shifter.percentagePlayed = (safeSeconds / duration) * 100
      onTimeUpdate(safeSeconds)
    },
    setPitchSemitones(semitones) {
      shifter.pitchSemitones = semitones
    },
    setTempo(nextTempo) {
      shifter.tempo = nextTempo
    },
  }
}

export async function renderProcessedWav({
  audioBuffer,
  pitchSemitones,
  tempo,
}: {
  audioBuffer: AudioBuffer
  pitchSemitones: number
  tempo: number
}) {
  const rendered = await processAudio(audioBuffer, pitchSemitones, tempo)
  return encodeWav(rendered.left, rendered.right, audioBuffer.sampleRate)
}

export function formatSeconds(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.floor(totalSeconds % 60)
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

export function sanitizeFileStem(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'processed-track'
}

async function processAudio(audioBuffer: AudioBuffer, pitchSemitones: number, tempo: number) {
  if (pitchSemitones === 0 && tempo === 1) {
    return toStereo(audioBuffer)
  }

  const soundTouch = new SoundTouch()
  const source = new WebAudioBufferSource(audioBuffer)
  const filter = new SimpleFilter(source, soundTouch)

  soundTouch.pitchSemitones = pitchSemitones
  soundTouch.tempo = tempo

  const chunks: Float32Array[] = []
  let totalFrames = 0

  while (true) {
    const sampleChunk = new Float32Array(PROCESSING_CHUNK_SIZE * 2)
    const framesExtracted = filter.extract(sampleChunk, PROCESSING_CHUNK_SIZE)

    if (framesExtracted === 0) {
      break
    }

    chunks.push(sampleChunk.slice(0, framesExtracted * 2))
    totalFrames += framesExtracted
  }

  const left = new Float32Array(totalFrames)
  const right = new Float32Array(totalFrames)
  let writeOffset = 0

  for (const chunk of chunks) {
    for (let index = 0; index < chunk.length; index += 2) {
      left[writeOffset] = chunk[index]
      right[writeOffset] = chunk[index + 1]
      writeOffset += 1
    }
  }

  return { left, right }
}

function toStereo(audioBuffer: AudioBuffer) {
  const left = audioBuffer.getChannelData(0).slice()
  const right = (audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : audioBuffer.getChannelData(0)).slice()
  return { left, right }
}

function encodeWav(left: Float32Array, right: Float32Array, sampleRate: number) {
  const frameCount = Math.min(left.length, right.length)
  const bytesPerSample = 2
  const blockAlign = bytesPerSample * 2
  const wavBuffer = new ArrayBuffer(44 + frameCount * blockAlign)
  const view = new DataView(wavBuffer)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + frameCount * blockAlign, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 2, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, frameCount * blockAlign, true)

  let offset = 44

  for (let index = 0; index < frameCount; index += 1) {
    view.setInt16(offset, floatTo16BitPcm(left[index]), true)
    view.setInt16(offset + 2, floatTo16BitPcm(right[index]), true)
    offset += 4
  }

  return new Blob([wavBuffer], { type: 'audio/wav' })
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index))
  }
}

function floatTo16BitPcm(value: number) {
  const safeValue = clamp(value, -1, 1)
  return safeValue < 0 ? safeValue * 0x8000 : safeValue * 0x7fff
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}
