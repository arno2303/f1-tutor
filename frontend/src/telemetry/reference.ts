// A real F1 driver's lap, resampled to the same 2 m grid as the player's laps.

export const REF_GRID_M = 2
// How far curves are smoothed before measuring curvature (skill: gauss σ≈16 m).
const CURVATURE_SIGMA_M = 16

export interface RefDriver {
  code: string
  name: string
  team: string
  color: string
  number: string
  lap: number
  lapMs: number
  compound: string
}

export interface RefIndex {
  year: number
  tracks: Record<string, RefDriver[]>
}

export interface RefLapFile {
  d: number[]
  t: number[]
  v: number[]
  thr: number[]
  brk: number[]
  g: number[]
  x: number[]
  y: number[]
}

export type RefChannel = 'speed' | 'throttle' | 'brake' | 'gear' | 'time' | 'x' | 'y' | 'kappa'

export class ReferenceLap {
  readonly cells: number

  constructor(
    readonly driver: RefDriver,
    readonly lengthM: number,
    readonly channels: Record<RefChannel, Float32Array>,
  ) {
    this.cells = channels.speed.length
  }

  /** Value at a distance on this lap, wrapping past the line. */
  at(channel: RefChannel, distanceM: number): number {
    const wrapped = ((distanceM % this.lengthM) + this.lengthM) % this.lengthM
    return this.channels[channel][Math.min(this.cells - 1, Math.floor(wrapped / REF_GRID_M))]
  }

  /**
   * Elapsed time since the lap started at `distanceM`, continuing past the line,
   * so time before the line is negative and time after a full lap keeps growing.
   */
  timeAt(distanceM: number): number {
    const laps = Math.floor(distanceM / this.lengthM)
    return this.at('time', distanceM) + laps * this.driver.lapMs
  }
}

/**
 * Curvature (1/m) of a path sampled every `stepM`. Missing samples are left out
 * of the smoothing; a place with none near it stays NaN.
 */
export function curvature(xs: ArrayLike<number>, ys: ArrayLike<number>, stepM: number, closed: boolean): Float32Array {
  const n = xs.length
  const radius = Math.ceil((CURVATURE_SIGMA_M * 3) / stepM)
  const kernel = Array.from({ length: radius * 2 + 1 }, (_, i) => {
    const m = (i - radius) * stepM
    return Math.exp(-(m * m) / (2 * CURVATURE_SIGMA_M * CURVATURE_SIGMA_M))
  })
  const fullWeight = kernel.reduce((sum, weight) => sum + weight, 0)
  const smoothX = new Float64Array(n).fill(NaN)
  const smoothY = new Float64Array(n).fill(NaN)
  for (let i = 0; i < n; i++) {
    let sumX = 0
    let sumY = 0
    let sumWeight = 0
    for (let k = -radius; k <= radius; k++) {
      let j = i + k
      if (closed) j = ((j % n) + n) % n
      else if (j < 0 || j >= n) continue
      const x = xs[j]
      const y = ys[j]
      if (Number.isNaN(x) || Number.isNaN(y)) continue
      const weight = kernel[k + radius]
      sumX += x * weight
      sumY += y * weight
      sumWeight += weight
    }
    if (sumWeight > fullWeight * 0.6) {
      smoothX[i] = sumX / sumWeight
      smoothY[i] = sumY / sumWeight
    }
  }

  const kappa = new Float32Array(n).fill(NaN)
  for (let i = 0; i < n; i++) {
    const before = closed ? (i - 1 + n) % n : i - 1
    const after = closed ? (i + 1) % n : i + 1
    if (before < 0 || after >= n) continue
    const a = Math.atan2(smoothY[i] - smoothY[before], smoothX[i] - smoothX[before])
    const b = Math.atan2(smoothY[after] - smoothY[i], smoothX[after] - smoothX[i])
    const turn = Math.atan2(Math.sin(b - a), Math.cos(b - a))
    if (!Number.isNaN(turn)) kappa[i] = -turn / stepM
  }
  return kappa
}

export function buildReferenceLap(file: RefLapFile, driver: RefDriver): ReferenceLap {
  const lengthM = file.d[file.d.length - 1]
  const cells = Math.floor(lengthM / REF_GRID_M) + 1
  const speed = new Float32Array(cells)
  const throttle = new Float32Array(cells)
  const brake = new Float32Array(cells)
  const gear = new Float32Array(cells)
  const time = new Float32Array(cells)
  const x = new Float32Array(cells)
  const y = new Float32Array(cells)

  let segment = 0
  for (let cell = 0; cell < cells; cell++) {
    const distance = cell * REF_GRID_M
    while (segment < file.d.length - 2 && file.d[segment + 1] <= distance) segment++
    const span = file.d[segment + 1] - file.d[segment]
    const t = Math.max(0, Math.min(1, (distance - file.d[segment]) / span))
    const mix = (values: number[]) => values[segment] + (values[segment + 1] - values[segment]) * t
    speed[cell] = mix(file.v)
    throttle[cell] = mix(file.thr) / 100
    time[cell] = mix(file.t)
    x[cell] = mix(file.x)
    y[cell] = mix(file.y)
    // The brake is on or off in this data, and gears don't blend.
    brake[cell] = t < 0.5 ? file.brk[segment] : file.brk[segment + 1]
    gear[cell] = t < 0.5 ? file.g[segment] : file.g[segment + 1]
  }
  const kappa = curvature(x, y, REF_GRID_M, true)
  return new ReferenceLap(driver, lengthM, { speed, throttle, brake, gear, time, x, y, kappa })
}
