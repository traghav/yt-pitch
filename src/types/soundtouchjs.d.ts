declare module 'soundtouchjs' {
  export class SoundTouch {
    pitch: number
    pitchSemitones: number
    rate: number
    tempo: number
  }

  export class WebAudioBufferSource {
    constructor(buffer: AudioBuffer)
  }

  export class SimpleFilter {
    sourcePosition: number
    constructor(sourceSound: WebAudioBufferSource, pipe: SoundTouch, onEnd?: () => void)
    extract(target: Float32Array, numFrames?: number): number
  }

  export class PitchShifter {
    percentagePlayed: number
    pitchSemitones: number
    tempo: number
    timePlayed: number
    constructor(context: AudioContext, buffer: AudioBuffer, bufferSize?: number, onEnd?: () => void)
    connect(toNode: AudioNode): void
    disconnect(): void
    on(eventName: string, callback: (detail: { timePlayed: number }) => void): void
  }
}
