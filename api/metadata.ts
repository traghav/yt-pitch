import { getYoutubeInfo, toMetadata, validateYoutubeUrl } from './_lib/youtube.js'

export async function GET(request: Request) {
  const requestUrl = new URL(request.url)
  const youtubeUrl = requestUrl.searchParams.get('url')?.trim()

  if (!youtubeUrl || !validateYoutubeUrl(youtubeUrl)) {
    return Response.json(
      {
        error: 'That does not look like a valid YouTube watch link.',
      },
      { status: 400 },
    )
  }

  try {
    const info = await getYoutubeInfo(youtubeUrl)
    return Response.json(toMetadata(info))
  } catch (caughtError) {
    return Response.json(
      {
        error: caughtError instanceof Error ? caughtError.message : 'Unable to load YouTube metadata.',
      },
      { status: 500 },
    )
  }
}
