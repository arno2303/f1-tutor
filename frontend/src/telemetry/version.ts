// A page left open across an app update keeps running the old code, even after
// the server restarts. The server names the current build; an outdated page reloads.

const RELOAD_KEY = 'f1tutor.reloadedFor'

/** This page's own script name, e.g. "index-Dj6abM-E.js"; null when not running a build (npm run dev). */
export function ownBuild(scriptUrl: string): string | null {
  const match = new URL(scriptUrl).pathname.match(/\/assets\/(index-[^/]+\.js)$/)
  return match ? match[1] : null
}

export function isOutdated(own: string | null, current: string | null | undefined): boolean {
  return own !== null && !!current && own !== current
}

/** Reloads once per new build, so a mismatch that a reload can't fix doesn't loop. */
export function reloadIfOutdated(own: string | null, current: string | null | undefined): void {
  if (!isOutdated(own, current)) return
  try {
    if (sessionStorage.getItem(RELOAD_KEY) === current) return
    sessionStorage.setItem(RELOAD_KEY, current!)
  } catch {
    // Without storage, still reload: the new page will match and stop there.
  }
  location.reload()
}
