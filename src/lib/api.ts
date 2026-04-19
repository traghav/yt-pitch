export function buildApiUrl(path: string) {
  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '') ?? ''
  return apiBaseUrl ? `${apiBaseUrl}${path}` : path
}
