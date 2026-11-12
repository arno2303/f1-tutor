import type { Corner, Track } from './store'

/** Point on the outline at a lap fraction, with the driving direction there. */
export function pointAt(track: Track, fraction: number): { x: number; y: number; dx: number; dy: number } {
  const n = track.points.length
  const position = (((fraction % 1) + 1) % 1) * n
  const i = Math.floor(position)
  const t = position - i
  const a = track.points[i % n]
  const b = track.points[(i + 1) % n]
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
  return {
    x: a[0] + (b[0] - a[0]) * t,
    y: a[1] + (b[1] - a[1]) * t,
    dx: (b[0] - a[0]) / length,
    dy: (b[1] - a[1]) / length,
  }
}

/** The first corner ahead of a lap fraction, wrapping past the finish line. */
export function nextCorner(track: Track, fraction: number): { corner: Corner; ahead: number } | null {
  if (track.corners.length === 0) return null
  const corner = track.corners.find((c) => c.fraction > fraction) ?? track.corners[0]
  return { corner, ahead: ((corner.fraction - fraction) % 1 + 1) % 1 }
}
