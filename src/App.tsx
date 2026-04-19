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

const SEMITONE_NAMES: Record<number, string> = {
  [-12]: '−1 octave',
  [-7]: 'down a fifth',
  [-5]: 'down a fourth',
  [-2]: 'whole step down',
  [-1]: 'half step down',
  [0]: 'original key',
  [1]: 'half step up',
  [2]: 'whole step up',
  [5]: 'up a fourth',
  [7]: 'up a fifth',
  [12]: '+1 octave',
}

function describeSemitones(n: number): string {
  if (SEMITONE_NAMES[n]) return SEMITONE_NAMES[n]
  if (n > 0) return `${n} semitones up`
  return `${Math.abs(n)} semitones down`
}

function describeTempo(t: number): string {
  if (Math.abs(t - 1) < 0.01) return 'original tempo'
  if (t < 1) return `${Math.round((1 - t) * 100)}% slower`
  return `${Math.round((t - 1) * 100)}% faster`
}

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
    if (!track) {
      return ''
    }

    return `/api/media?kind=audio&url=${encodeURIComponent(track.canonicalUrl)}`
  }, [track])

  const videoSrc = useMemo(() => {
    if (!track) {
      return ''
    }

    return `/api/media?kind=video&url=${encodeURIComponent(track.canonicalUrl)}`
  }, [track])

  const longTrackWarning = useMemo(() => {
    if (!track || track.durationSeconds <= MAX_RECOMMENDED_DURATION_SECONDS) {
      return null
    }

    return 'Long clips can be heavy on phones during export. Preview still works — rendering may take a bit.'
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

      if (!video) {
        return
      }

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
      if (existingUrl) {
        URL.revokeObjectURL(existingUrl)
      }

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

      if (audioContext) {
        void audioContext.close()
      }
    }
  }, [disposeController, releaseDownloadUrl])

  useEffect(() => {
    controllerRef.current?.setPitchSemitones(pitchSemitones)
    controllerRef.current?.setTempo(tempo)

    const video = videoRef.current

    if (video) {
      video.playbackRate = tempo
    }
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
    if (animationFrameRef.current !== null) {
      return
    }

    animationFrameRef.current = requestAnimationFrame(() => {
      animationFrameRef.current = null
      setCurrentTime(latestTimeRef.current)
    })
  }, [])

  const ensureController = useCallback(async () => {
    if (!track) {
      throw new Error('Cue a YouTube link before starting playback.')
    }

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

          if (isPlayingRef.current) {
            void syncVideoToTime(timePlayed, true)
          }
        },
        pitchSemitones,
        tempo,
      })
    }

    controllerRef.current.setPitchSemitones(pitchSemitones)
    controllerRef.current.setTempo(tempo)

    if (audioState !== 'playing') {
      setAudioState('ready')
    }

    return controllerRef.current
  }, [audioSrc, audioState, ensureAudioContext, pitchSemitones, scheduleUiRefresh, syncVideoToTime, tempo, track])

  const handleLoadTrack = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()

      const trimmedUrl = youtubeUrl.trim()

      if (!trimmedUrl) {
        setError('Drop a YouTube link to cue a track.')
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

        if (!response.ok) {
          throw new Error(payload.error ?? 'Could not load that YouTube link.')
        }

        setTrack(payload)
        setYoutubeUrl(payload.canonicalUrl)
        setFetchState('ready')
      } catch (caughtError) {
        setFetchState('error')
        setError(caughtError instanceof Error ? caughtError.message : 'Could not load that YouTube link.')
      }
    },
    [releaseDownloadUrl, resetPlaybackState, youtubeUrl],
  )

  const handlePlayPause = useCallback(async () => {
    if (!track) {
      setError('Cue a YouTube link before starting playback.')
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
      setError('Cue a YouTube link before rendering.')
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
      setError(caughtError instanceof Error ? caughtError.message : 'Could not render the processed audio.')
    }
  }, [audioSrc, ensureAudioContext, pitchSemitones, releaseDownloadUrl, tempo, track])

  const transportLabel = useMemo(() => {
    if (audioState === 'loading') return 'Decoding…'
    if (audioState === 'playing') return 'Pause'
    if (audioState === 'paused' || audioState === 'ready') return 'Play'
    return 'Play'
  }, [audioState])

  const transportState = audioState === 'playing' ? 'on' : 'off'
  const durationSeconds = track?.durationSeconds ?? 0
  const progressPct = durationSeconds > 0 ? Math.min(100, (currentTime / durationSeconds) * 100) : 0
  const pitchPct = ((pitchSemitones + 12) / 24) * 100
  const tempoPct = ((tempo - 0.5) / 1.5) * 100
  const pitchReadout = `${pitchSemitones > 0 ? '+' : pitchSemitones < 0 ? '−' : ' '}${String(Math.abs(pitchSemitones)).padStart(2, '0')} ST`
  const tempoReadout = `${tempo.toFixed(2).padStart(4, '0')}×`

  return (
    <main className="app">
      {/* Top band ------------------------------------------------------- */}
      <header className="topband">
        <div className="topband__row">
          <div className="brandmark">
            <span className="brandmark__dot" aria-hidden />
            <span className="brandmark__word">PITCH LAB</span>
          </div>
          <div className="topband__meta tech">
            <span>UNIT&nbsp;001</span>
            <span aria-hidden>·</span>
            <span>POCKET TRANSPOSITION</span>
          </div>
        </div>
        <div className="topband__scroll tech" aria-hidden>
          <span>— TRANSPOSE — TIME-STRETCH — WAV-OUT — BROWSER-NATIVE — NO-UPLOAD — TRANSPOSE — TIME-STRETCH — WAV-OUT — BROWSER-NATIVE — NO-UPLOAD —</span>
        </div>
      </header>

      {/* Hero ----------------------------------------------------------- */}
      <section className="hero">
        <p className="tech tech--amber hero__eyebrow">POC/01 — LIVE · STUDY · REHEARSE</p>
        <h1 className="hero__title">
          Shift the key.
          <br />
          Bend the tempo.
          <br />
          <span className="hero__title--amber">Leave nothing</span> on a server.
        </h1>
        <p className="hero__lede">
          Paste a YouTube link. Preview the video against freshly-pitched audio. Pull the fader,
          tune the key, then render a clean WAV — all on the phone in your hand.
        </p>
        <ul className="hero__bullets">
          <li>
            <span className="tech tech--amber">01</span>
            <span>Cue any public YouTube clip in one tap.</span>
          </li>
          <li>
            <span className="tech tech--amber">02</span>
            <span>Slide pitch ±12 semitones, tempo 0.5×–2.0×, independently.</span>
          </li>
          <li>
            <span className="tech tech--amber">03</span>
            <span>Export a rehearsal-ready WAV straight from the browser.</span>
          </li>
        </ul>
      </section>

      {/* Cue input ------------------------------------------------------- */}
      <section className="panel cue" aria-labelledby="cue-title">
        <div className="panel__head">
          <p className="tech">CH.01 — INPUT</p>
          <h2 id="cue-title" className="panel__title">Cue a track</h2>
        </div>
        <form className="cue__form" onSubmit={handleLoadTrack}>
          <label className="cue__field">
            <span className="tech tech--ink">YouTube URL</span>
            <input
              id="youtube-url"
              type="url"
              inputMode="url"
              value={youtubeUrl}
              onChange={(event) => setYoutubeUrl(event.target.value)}
              placeholder="https://www.youtube.com/watch?v=..."
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <button className="btn btn--primary cue__go" type="submit" disabled={fetchState === 'loading'}>
            <span className="btn__glyph" aria-hidden>▶</span>
            <span>{fetchState === 'loading' ? 'Cueing…' : 'Cue track'}</span>
          </button>
        </form>
        <p className="cue__helper">
          Public videos play cleanest. Anything over 12 minutes is still playable, but renders can get
          memory-hungry on a phone.
        </p>
      </section>

      {error ? (
        <section className="panel panel--alert" aria-live="polite">
          <p className="tech">ERR</p>
          <p>{error}</p>
        </section>
      ) : null}

      {track ? (
        <section className="workspace">
          {/* Stage ------------------------------------------------------ */}
          <article className="panel stage">
            <div className="panel__head panel__head--row">
              <div>
                <p className="tech">CH.02 — MONITOR</p>
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
              <div className="screen__scan" aria-hidden />
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
              <div className="screen__hud tech" aria-hidden>
                <span>MUTED-VIDEO</span>
                <span>·</span>
                <span>AUDIO-PROC</span>
              </div>
            </div>

            <div className="timecode">
              <div className="timecode__row">
                <span className="lcd lcd--amber">{formatSeconds(currentTime)}</span>
                <span className="tech timecode__sep">/ RUN-TIME</span>
                <span className="lcd">{formatSeconds(track.durationSeconds)}</span>
              </div>
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
                <span className="btn__glyph" aria-hidden>
                  {audioState === 'playing' ? '❚❚' : '▶'}
                </span>
                <span>{transportLabel}</span>
              </button>
              <button className="btn btn--ghost" type="button" onClick={handleReset}>
                <span className="btn__glyph" aria-hidden>↺</span>
                <span>Rewind</span>
              </button>
              <button
                className="btn btn--ghost"
                type="button"
                onClick={() => videoRef.current?.requestPictureInPicture?.()}
                disabled={!document.pictureInPictureEnabled}
              >
                <span className="btn__glyph" aria-hidden>⧉</span>
                <span>Float</span>
              </button>
            </div>
          </article>

          {/* Controls --------------------------------------------------- */}
          <aside className="rack">
            <article className="panel fader">
              <div className="panel__head">
                <p className="tech">CH.03 — PITCH</p>
                <h2 className="fader__title">Transpose</h2>
              </div>
              <div className="display">
                <div className="display__screen">
                  <span className="display__big">{pitchReadout}</span>
                  <span className="display__cap tech">{describeSemitones(pitchSemitones)}</span>
                </div>
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
                <button className="chip" type="button" onClick={() => setPitchSemitones(-2)}>−2 ST</button>
                <button className="chip" type="button" onClick={() => setPitchSemitones(-1)}>−1 ST</button>
                <button className="chip chip--reset" type="button" onClick={() => setPitchSemitones(0)}>Key</button>
                <button className="chip" type="button" onClick={() => setPitchSemitones(1)}>+1 ST</button>
                <button className="chip" type="button" onClick={() => setPitchSemitones(2)}>+2 ST</button>
              </div>
            </article>

            <article className="panel fader">
              <div className="panel__head">
                <p className="tech">CH.04 — TEMPO</p>
                <h2 className="fader__title">Time-stretch</h2>
              </div>
              <div className="display">
                <div className="display__screen">
                  <span className="display__big">{tempoReadout}</span>
                  <span className="display__cap tech">{describeTempo(tempo)}</span>
                </div>
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
                  <span>1.0×</span>
                  <span>2.0×</span>
                </div>
              </div>
              <div className="chips">
                <button className="chip" type="button" onClick={() => setTempo(0.6)}>0.60×</button>
                <button className="chip" type="button" onClick={() => setTempo(0.75)}>0.75×</button>
                <button className="chip chip--reset" type="button" onClick={() => setTempo(1)}>1.00×</button>
                <button className="chip" type="button" onClick={() => setTempo(1.25)}>1.25×</button>
                <button className="chip" type="button" onClick={() => setTempo(1.5)}>1.50×</button>
              </div>
            </article>

            <article className="panel export">
              <div className="panel__head">
                <p className="tech">CH.05 — MASTER OUT</p>
                <h2 className="fader__title">Render WAV</h2>
              </div>
              <p className="export__copy">
                Bounce the current pitch and tempo to a WAV. The file is built on-device — nothing leaves the browser.
              </p>
              <div className="export__actions">
                <button
                  className="btn btn--primary btn--block"
                  type="button"
                  onClick={() => void handleExport()}
                  disabled={audioState === 'exporting'}
                >
                  <span className="btn__glyph" aria-hidden>◉</span>
                  <span>{audioState === 'exporting' ? 'Rendering…' : 'Render WAV'}</span>
                </button>
                {downloadUrl ? (
                  <a className="btn btn--download btn--block" href={downloadUrl} download={downloadName}>
                    <span className="btn__glyph" aria-hidden>⤓</span>
                    <span>Save to device</span>
                  </a>
                ) : null}
              </div>
              {longTrackWarning ? (
                <p className="export__warn">
                  <span className="tech tech--amber">NOTE</span> {longTrackWarning}
                </p>
              ) : null}
            </article>

            <article className="panel spec">
              <p className="tech spec__head">SPEC PLATE</p>
              <dl className="spec__list">
                <div>
                  <dt className="tech tech--ink">Source</dt>
                  <dd>YouTube public video</dd>
                </div>
                <div>
                  <dt className="tech tech--ink">Preview</dt>
                  <dd>Muted video + live DSP audio</dd>
                </div>
                <div>
                  <dt className="tech tech--ink">Export</dt>
                  <dd>16-bit WAV, full fidelity</dd>
                </div>
                <div>
                  <dt className="tech tech--ink">Host</dt>
                  <dd>Runs entirely in-browser</dd>
                </div>
              </dl>
            </article>
          </aside>
        </section>
      ) : (
        <section className="panel empty">
          <p className="tech">STANDBY</p>
          <h2 className="empty__title">Waiting for signal.</h2>
          <p className="empty__sub">
            Cue a YouTube link above — the monitor, faders and WAV render will wake up here.
          </p>
          <div className="empty__grid" aria-hidden>
            <span className="empty__blip" />
            <span className="empty__blip" />
            <span className="empty__blip" />
            <span className="empty__blip" />
          </div>
        </section>
      )}

      <footer className="footer">
        <p className="tech">END OF SIGNAL · MADE FOR MUSICIANS PRACTICING AT 2 AM</p>
      </footer>
    </main>
  )
}

export default App
