// When the Fulcrum UI is reached via a Cloudflare Tunnel under a non-localhost
// host, the browser cannot fetch the user's dev server at `localhost:<port>` —
// localhost there resolves to the user's laptop, not the host running the dev
// server. Rewrite to the host's Tailscale hostname so the iframe (and the
// browser tab) reach the dev server through the tailnet.
//
// Persisted task `viewState.browserUrl` stays as-typed; rewriting happens at
// the iframe `src` boundary only. That way switching the feature on/off does
// not migrate stored data.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]'])

function isLocalUiHost(host: string): boolean {
  // host can be "localhost:6666" — strip port for comparison
  const bare = host.split(':')[0]
  return LOCAL_HOSTS.has(bare)
}

export function rewriteLocalhostForPreview(
  url: string,
  tailscaleHostname: string | null,
  uiHost: string,
): string {
  if (!tailscaleHostname) return url
  if (isLocalUiHost(uiHost)) return url
  if (!url) return url

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }

  if (!LOCAL_HOSTS.has(parsed.hostname)) return url

  parsed.hostname = tailscaleHostname
  // Tailscale serves dev ports over plain HTTP by default; only upgrade to
  // https if the user explicitly typed it. (MagicDNS HTTPS is opt-in per host.)
  return parsed.toString()
}
