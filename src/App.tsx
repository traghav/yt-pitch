import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'
import {
  createPitchController,
  decodeAudioFromUrl,
  formatSeconds,
  renderProcessedWav,
  sanitizeFileStem,
  type PitchController,
} from './lib/audio'

type TrackMetadata = {
  author: string
  canonicalUrl: string
  durationSeconds: number
  thumbnailUrl: string
  title: string
  videoId: string
}

type FetchState = 'idle' | 'loading' | 'ready' | 'error'
type AudioState = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'exporting'

const DEFAULT_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'
const MAX_RECOMMENDED_DURATION_SECONDS = 12 * 60

function App() {
  const [youtubeUrl, setYoutubeUrl] = useState(DEFAULT_URL)
  const [track, setTrack] = useState<TrackMetadata | null>(null)
  const [fetchState, setFetchState] = useState<FetchState>('idle')
  const [audioState, setAudioState] = useState<AudioState>('idle')
  const [pitchSemitones, setPitchSemitones] = useState(0)
  const [tempo, setTempo] = useState(1)
  const [currentTime, setCurrentTime] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null)
  const [downloadName, setDownloadName] = useState('processed-track.wav')

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioBufferRef = useRef<AudioBuffer | null>(null)
  const controllerRef = useRef<PitchController | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const latestTimeRef = useRef(0)
  const isPlayingRef = useRef(false)

  const audioSrc = useMemo(() => {
    if (!track) return ''
    return `/api/media?kind=audio&url=${encodeURIComponent(track.canonicalUrl)}`
  }, [track])

  const videoSrc = useMemo(() => {
    if (!track) return ''
    return `/api/media?kind=video&url=${encodeURIComponent(track.canonicalUrl)}`
  }, [track])

  const longTrackWarning = useMemo(() => {
    if (!track || track.durationSeconds <= MAX_RECOMMENDED_DURATION_SECONDS) return null
    return 'Long clips may be slow to render on phones.'
  }, [track])

  const stopAnimationFrame = useCallback(() => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }
  }, [])

  const syncVideoToTime = useCallback(
    async (targetTime: number, shouldPlay: boolean) => {
      const video = videoRef.current
      if (!video) return

      video.playbackRate = tempo

      if (Number.isFinite(video.currentTime) && Math.abs(video.currentTime - targetTime) > 0.18) {
        video.currentTime = targetTime
      }

      if (shouldPlay) {
        try {
          await video.play()
        } catch {
          // Browsers can block autoplay on muted video until the media stream is ready.
        }
      } else {
        video.pause()
      }
    },
    [tempo],
  )

  const releaseDownloadUrl = useCallback(() => {
    setDownloadUrl((existingUrl) => {
      if (existingUrl) URL.revokeObjectURL(existingUrl)
      return null
    })
  }, [])

  const disposeController = useCallback(() => {
    isPlayingRef.current = false
    stopAnimationFrame()
    controllerRef.current?.dispose()
    controllerRef.current = null
  }, [stopAnimationFrame])

  const resetPlaybackState = useCallback(() => {
    disposeController()
    audioBufferRef.current = null
    latestTimeRef.current = 0
    setCurrentTime(0)
    setAudioState('idle')
    const video = videoRef.current
    if (video) {
      video.pause()
      video.currentTime = 0
    }
  }, [disposeController])

  useEffect(() => {
    return () => {
      disposeController()
      releaseDownloadUrl()
      const audioContext = audioContextRef.current
      if (audioContext) void audioContext.close()
    }
  }, [disposeController, releaseDownloadUrl])

  useEffect(() => {
    controllerRef.current?.setPitchSemitones(pitchSemitones)
    controllerRef.current?.setTempo(tempo)
    const video = videoRef.current
    if (video) video.playbackRate = tempo
  }, [pitchSemitones, tempo])

  const ensureAudioContext = useCallback(async () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext()
    }
    if (audioContextRef.current.state === 'suspended') {
      await audioContextRef.current.resume()
    }
    return audioContextRef.current
  }, [])

  const scheduleUiRefresh = useCallback(() => {
    if (animationFrameRef.current !== null) return
    animationFrameRef.current = requestAnimationFrame(() => {
      animationFrameRef.current = null
      setCurrentTime(latestTimeRef.current)
    })
  }, [])

  const ensureController = useCallback(async () => {
    if (!track) throw new Error('Cue a track first.')

    const context = await ensureAudioContext()

    if (!audioBufferRef.current) {
      setAudioState('loading')
      audioBufferRef.current = await decodeAudioFromUrl(context, audioSrc)
    }

    if (!controllerRef.current) {
      controllerRef.current = createPitchController({
        audioBuffer: audioBufferRef.current,
        audioContext: context,
        onEnded: () => {
          isPlayingRef.current = false
          setAudioState('paused')
          void syncVideoToTime(latestTimeRef.current, false)
        },
        onTimeUpdate: (timePlayed) => {
          latestTimeRef.current = timePlayed
          scheduleUiRefresh()
          if (isPlayingRef.current) void syncVideoToTime(timePlayed, true)
        },
        pitchSemitones,
        tempo,
      })
    }

    controllerRef.current.setPitchSemitones(pitchSemitones)
    controllerRef.current.setTempo(tempo)

    if (audioState !== 'playing') setAudioState('ready')
    return controllerRef.current
  }, [audioSrc, audioState, ensureAudioContext, pitchSemitones, scheduleUiRefresh, syncVideoToTime, tempo, track])

  const handleLoadTrack = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      const trimmedUrl = youtubeUrl.trim()
      if (!trimmedUrl) {
        setError('Paste a link first.')
        return
      }

      setFetchState('loading')
      setError(null)
      releaseDownloadUrl()
      resetPlaybackState()
      setTrack(null)

      try {
        const response = await fetch(`/api/metadata?url=${encodeURIComponent(trimmedUrl)}`)
        const payload = (await response.json()) as TrackMetadata & { error?: string }
        if (!response.ok) throw new Error(payload.error ?? 'Could not load that link.')

        setTrack(payload)
        setYoutubeUrl(payload.canonicalUrl)
        setFetchState('ready')
      } catch (caughtError) {
        setFetchState('error')
        setError(caughtError instanceof Error ? caughtError.message : 'Could not load that link.')
      }
    },
    [releaseDownloadUrl, resetPlaybackState, youtubeUrl],
  )

  const handlePlayPause = useCallback(async () => {
    if (!track) {
      setError('Cue a track first.')
      return
    }
    setError(null)

    if (isPlayingRef.current) {
      controllerRef.current?.disconnect()
      isPlayingRef.current = false
      setAudioState('paused')
      await syncVideoToTime(latestTimeRef.current, false)
      return
    }

    try {
      const controller = await ensureController()
      controller.connect()
      isPlayingRef.current = true
      setAudioState('playing')
      await syncVideoToTime(controller.getCurrentTime(), true)
    } catch (caughtError) {
      setAudioState('ready')
      setError(caughtError instanceof Error ? caughtError.message : 'Could not start playback.')
    }
  }, [ensureController, syncVideoToTime, track])

  const handleSeek = useCallback(
    (seconds: number) => {
      latestTimeRef.current = seconds
      setCurrentTime(seconds)
      controllerRef.current?.seek(seconds)
      void syncVideoToTime(seconds, isPlayingRef.current)
    },
    [syncVideoToTime],
  )

  const handleReset = useCallback(() => {
    controllerRef.current?.disconnect()
    controllerRef.current?.seek(0)
    latestTimeRef.current = 0
    isPlayingRef.current = false
    setCurrentTime(0)
    setAudioState(controllerRef.current ? 'paused' : 'idle')
    void syncVideoToTime(0, false)
  }, [syncVideoToTime])

  const handleExport = useCallback(async () => {
    if (!track) {
      setError('Cue a track first.')
      return
    }

    try {
      setError(null)
      setAudioState('exporting')
      const context = await ensureAudioContext()
      const sourceBuffer = audioBufferRef.current ?? (await decodeAudioFromUrl(context, audioSrc))
      audioBufferRef.current = sourceBuffer

      const wavBlob = await renderProcessedWav({
        audioBuffer: sourceBuffer,
        pitchSemitones,
        tempo,
      })

      releaseDownloadUrl()

      const nextDownloadUrl = URL.createObjectURL(wavBlob)
      setDownloadUrl(nextDownloadUrl)
      setDownloadName(`${sanitizeFileStem(track.title)}-${pitchSemitones >= 0 ? 'up' : 'down'}${Math.abs(pitchSemitones)}st-${tempo.toFixed(2)}x.wav`)
      setAudioState(isPlayingRef.current ? 'playing' : controllerRef.current ? 'paused' : 'ready')
    } catch (caughtError) {
      setAudioState(isPlayingRef.current ? 'playing' : 'ready')
      setError(caughtError instanceof Error ? caughtError.message : 'Could not render.')
    }
  }, [audioSrc, ensureAudioContext, pitchSemitones, releaseDownloadUrl, tempo, track])

  const transportLabel = useMemo(() => {
    if (audioState === 'loading') return 'Decoding…'
    if (audioState === 'playing') return 'Pause'
    return 'Play'
  }, [audioState])

  const transportState = audioState === 'playing' ? 'on' : 'off'
  const durationSeconds = track?.durationSeconds ?? 0
  const progressPct = durationSeconds > 0 ? Math.min(100, (currentTime / durationSeconds) * 100) : 0
  const pitchPct = ((pitchSemitones + 12) / 24) * 100
  const tempoPct = ((tempo - 0.5) / 1.5) * 100
  const pitchReadout = `${pitchSemitones > 0 ? '+' : pitchSemitones < 0 ? '−' : ' '}${String(Math.abs(pitchSemitones)).padStart(2, '0')}`
  const tempoReadout = tempo.toFixed(2)

  return (
    <main className="app">
      <header className="topband">
        <div className="brandmark">
          <span className="brandmark__dot" aria-hidden />
          <span className="brandmark__word">PITCH LAB</span>
        </div>
        <div className="topband__meta tech">
          <span>UNIT 001</span>
        </div>
      </header>

      <section className="hero">
        <h1 className="hero__title">
          Shift the key.
          <br />
          <span className="hero__title--accent">Bend the tempo.</span>
        </h1>
      </section>

      <section className="panel cue" aria-labelledby="cue-title">
        <div className="panel__head">
          <p className="tech">CH.01 · INPUT</p>
          <h2 id="cue-title" className="panel__title">Cue a track</h2>
        </div>
        <form className="cue__form" onSubmit={handleLoadTrack}>
          <input
            id="youtube-url"
            type="url"
            inputMode="url"
            value={youtubeUrl}
            onChange={(event) => setYoutubeUrl(event.target.value)}
            placeholder="Paste a YouTube link…"
            autoComplete="off"
            spellCheck={false}
            aria-label="YouTube URL"
          />
          <button className="btn btn--primary cue__go" type="submit" disabled={fetchState === 'loading'}>
            <span>{fetchState === 'loading' ? 'Cueing…' : 'Cue'}</span>
            <span className="btn__glyph" aria-hidden>→</span>
          </button>
        </form>
      </section>

      {error ? (
        <section className="panel panel--alert" aria-live="polite">
          <span className="tech tech--accent">ERR</span>
          <p>{error}</p>
        </section>
      ) : null}

      {track ? (
        <section className="workspace">
          <article className="panel stage">
            <div className="panel__head panel__head--row">
              <div className="stage__meta">
                <p className="tech">CH.02 · MONITOR</p>
                <h2 className="stage__title">{track.title}</h2>
                <p className="stage__sub">
                  {track.author} <span aria-hidden>·</span> {formatSeconds(track.durationSeconds)}
                </p>
              </div>
              <span className={`led led--${transportState}`} aria-hidden>
                <span className="led__bulb" />
                <span className="tech led__label">{transportState === 'on' ? 'LIVE' : 'CUED'}</span>
              </span>
            </div>

            <div className="screen">
              <video
                key={track.videoId}
                ref={videoRef}
                className="screen__video"
                src={videoSrc}
                poster={track.thumbnailUrl}
                playsInline
                muted
                preload="metadata"
              />
            </div>

            <div className="timecode">
              <span className="lcd">{formatSeconds(currentTime)}</span>
              <span className="tech timecode__sep">/ {formatSeconds(track.durationSeconds)}</span>
              <div className="timeline">
                <div className="timeline__track" aria-hidden>
                  <div className="timeline__fill" style={{ width: `${progressPct}%` }} />
                </div>
                <input
                  className="timeline__input"
                  type="range"
                  min={0}
                  max={track.durationSeconds}
                  step={0.05}
                  value={Math.min(currentTime, track.durationSeconds)}
                  onChange={(event) => handleSeek(Number(event.target.value))}
                  aria-label="Playback position"
                />
              </div>
            </div>

            <div className="transport">
              <button
                className={`btn btn--transport ${audioState === 'playing' ? 'is-on' : ''}`}
                type="button"
                onClick={() => void handlePlayPause()}
                disabled={audioState === 'loading' || audioState === 'exporting'}
              >
                <span className="btn__glyph" aria-hidden>{audioState === 'playing' ? '❚❚' : '▶'}</span>
                <span>{transportLabel}</span>
              </button>
              <button className="btn btn--ghost" type="button" onClick={handleReset} aria-label="Rewind to start">
                <span className="btn__glyph" aria-hidden>↺</span>
              </button>
              <button
                className="btn btn--ghost"
                type="button"
                onClick={() => videoRef.current?.requestPictureInPicture?.()}
                disabled={!document.pictureInPictureEnabled}
                aria-label="Float video"
              >
                <span className="btn__glyph" aria-hidden>⧉</span>
              </button>
            </div>
          </article>

          <aside className="rack">
            <article className="panel fader">
              <div className="panel__head">
                <p className="tech">CH.03 · PITCH</p>
                <h2 className="fader__title">Transpose</h2>
              </div>
              <div className="readout">
                <span className="readout__num">{pitchReadout}</span>
                <span className="readout__unit">st</span>
              </div>
              <div className="slider">
                <div className="slider__track" aria-hidden>
                  <div className="slider__fill" style={{ width: `${pitchPct}%` }} />
                  <div className="slider__tick slider__tick--center" />
                </div>
                <input
                  className="slider__input"
                  type="range"
                  min={-12}
                  max={12}
                  step={1}
                  value={pitchSemitones}
                  onChange={(event) => setPitchSemitones(Number(event.target.value))}
                  aria-label="Pitch in semitones"
                />
                <div className="slider__scale tech" aria-hidden>
                  <span>−12</span>
                  <span>0</span>
                  <span>+12</span>
                </div>
              </div>
              <div className="chips">
                <button className="chip" type="button" onClick={() => setPitchSemitones(-2)}>−2</button>
                <button className="chip" type="button" onClick={() => setPitchSemitones(-1)}>−1</button>
                <button className="chip chip--reset" type="button" onClick={() => setPitchSemitones(0)}>0</button>
                <button className="chip" type="button" onClick={() => setPitchSemitones(1)}>+1</button>
                <button className="chip" type="button" onClick={() => setPitchSemitones(2)}>+2</button>
              </div>
            </article>

            <article className="panel fader">
              <div className="panel__head">
                <p className="tech">CH.04 · TEMPO</p>
                <h2 className="fader__title">Time-stretch</h2>
              </div>
              <div className="readout">
                <span className="readout__num">{tempoReadout}</span>
                <span className="readout__unit">×</span>
              </div>
              <div className="slider">
                <div className="slider__track" aria-hidden>
                  <div className="slider__fill" style={{ width: `${tempoPct}%` }} />
                  <div className="slider__tick slider__tick--center" style={{ left: `${((1 - 0.5) / 1.5) * 100}%` }} />
                </div>
                <input
                  className="slider__input"
                  type="range"
                  min={0.5}
                  max={2}
                  step={0.05}
                  value={tempo}
                  onChange={(event) => setTempo(Number(event.target.value))}
                  aria-label="Tempo multiplier"
                />
                <div className="slider__scale tech" aria-hidden>
                  <span>0.5×</span>
                  <span>1×</span>
                  <span>2×</span>
                </div>
              </div>
              <div className="chips">
                <button className="chip" type="button" onClick={() => setTempo(0.6)}>0.6</button>
                <button className="chip" type="button" onClick={() => setTempo(0.75)}>0.75</button>
                <button className="chip chip--reset" type="button" onClick={() => setTempo(1)}>1.0</button>
                <button className="chip" type="button" onClick={() => setTempo(1.25)}>1.25</button>
                <button className="chip" type="button" onClick={() => setTempo(1.5)}>1.5</button>
              </div>
            </article>

            <article className="panel export">
              <div className="panel__head">
                <p className="tech">CH.05 · OUT</p>
                <h2 className="fader__title">Render WAV</h2>
              </div>
              <div className="export__actions">
                <button
                  className="btn btn--primary btn--block"
                  type="button"
                  onClick={() => void handleExport()}
                  disabled={audioState === 'exporting'}
                >
                  <span>{audioState === 'exporting' ? 'Rendering…' : 'Render'}</span>
                  <span className="btn__glyph" aria-hidden>◉</span>
                </button>
                {downloadUrl ? (
                  <a className="btn btn--download btn--block" href={downloadUrl} download={downloadName}>
                    <span>Save</span>
                    <span className="btn__glyph" aria-hidden>⤓</span>
                  </a>
                ) : null}
              </div>
              {longTrackWarning ? (
                <p className="export__warn">
                  <span className="tech tech--accent">NOTE</span> {longTrackWarning}
                </p>
              ) : null}
            </article>
          </aside>
        </section>
      ) : (
        <section className="panel empty">
          <p className="tech">STANDBY</p>
          <h2 className="empty__title">Awaiting signal</h2>
          <div className="empty__grid" aria-hidden>
            <span className="empty__blip" />
            <span className="empty__blip" />
            <span className="empty__blip" />
            <span className="empty__blip" />
          </div>
        </section>
      )}

      <footer className="footer">
        <span className="tech">PITCH LAB · 001</span>
      </footer>
    </main>
  )
}

export default App
