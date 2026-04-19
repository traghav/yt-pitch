import {
  createProxyHeaders,
  getYoutubeInfo,
  pickAudioFormat,
  pickVideoFormat,
  toMetadata,
  validateYoutubeUrl,
} from './_lib/youtube.js'

export async function GET(request: Request) {
  const requestUrl = new URL(request.url)
  const youtubeUrl = requestUrl.searchParams.get('url')?.trim()
  const kind = requestUrl.searchParams.get('kind')

  if (!youtubeUrl || !validateYoutubeUrl(youtubeUrl)) {
    return Response.json(
      {
        error: 'That does not look like a valid YouTube watch link.',
      },
      { status: 400 },
    )
  }

  if (kind !== 'audio' && kind !== 'video') {
    return Response.json(
      {
        error: 'Use kind=audio or kind=video.',
      },
      { status: 400 },
    )
  }

  try {
    const info = await getYoutubeInfo(youtubeUrl)
    const format = kind === 'audio' ? pickAudioFormat(info) : pickVideoFormat(info)

    if (!format?.url) {
      return Response.json(
        {
          error: `No compatible ${kind} stream was found for this video.`,
        },
        { status: 404 },
      )
    }

    const upstreamHeaders = new Headers()
    const range = request.headers.get('range')

    if (range) {
      upstreamHeaders.set('range', range)
    }

    const upstreamResponse = await fetch(format.url, {
      headers: upstreamHeaders,
    })

    if (!upstreamResponse.ok || !upstreamResponse.body) {
      return Response.json(
        {
          error: `The upstream ${kind} stream could not be fetched.`,
        },
        { status: 502 },
      )
    }

    const metadata = toMetadata(info)
    const extension = kind === 'audio' ? (format.ext ?? 'm4a') : 'mp4'

    return new Response(upstreamResponse.body, {
      headers: createProxyHeaders(upstreamResponse, `${metadata.videoId}.${extension}`),
      status: upstreamResponse.status,
    })
  } catch (caughtError) {
    return Response.json(
      {
        error: caughtError instanceof Error ? caughtError.message : 'Unable to proxy that media stream.',
      },
      { status: 500 },
    )
  }
}
