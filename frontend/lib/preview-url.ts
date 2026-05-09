const LOCALHOST_BROWSER_URL = 'http://localhost:3000'

export function getDefaultBrowserUrl(tailscaleIp: string | null): string {
  return tailscaleIp ? `http://${tailscaleIp}:3000` : LOCALHOST_BROWSER_URL
}

export function normalizeBrowserUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed || trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed
  }
  return `http://${trimmed}`
}
