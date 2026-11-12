// Fits a track outline into a canvas, shared by the live map and the lap analysis map.

import type { Track } from './store'
import { pointAt } from './trackGeometry'

export interface MapView {
  track: Track
  width: number
  height: number
  scale: number
  ox: number
  oy: number
  path: Path2D
}

/** Returns a fitter that reuses its last result while the track and size stay the same. */
export function createMapFitter(paddingRem = 2.75) {
  let view: MapView | null = null
  return (track: Track, width: number, height: number, rem: number): MapView => {
    if (view && view.track === track && view.width === width && view.height === height) return view
    const xs = track.points.map((p) => p[0])
    const ys = track.points.map((p) => p[1])
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
    const pad = paddingRem * rem
    const scale = Math.min((width - pad * 2) / (maxX - minX), (height - pad * 2) / (maxY - minY))
    const ox = width / 2 - (scale * (minX + maxX)) / 2
    const oy = height / 2 - (scale * (minY + maxY)) / 2
    const path = new Path2D()
    track.points.forEach(([x, y], i) => (i ? path.lineTo(ox + x * scale, oy + y * scale) : path.moveTo(ox + x * scale, oy + y * scale)))
    path.closePath()
    view = { track, width, height, scale, ox, oy, path }
    return view
  }
}

/** Canvas position of a lap fraction. */
export function mapPoint(view: MapView, fraction: number): { x: number; y: number; dx: number; dy: number } {
  const p = pointAt(view.track, fraction)
  return { x: view.ox + p.x * view.scale, y: view.oy + p.y * view.scale, dx: p.dx, dy: p.dy }
}
