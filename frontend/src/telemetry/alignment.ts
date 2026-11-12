// Works out how the game's lap distance relates to the real lap's distance. The
// two lines needn't be in the same place and the lengths differ slightly, so
// comparing raw distances could misplace a corner by tens of metres.

import { GRID_M, type LapTrace } from './lapRecorder'
import type { ReferenceLap } from './reference'

/** referenceDistance = a * gameDistance + b. */
export interface Alignment {
  a: number
  b: number
  rmsM: number
  fitted: boolean
}

const SAMPLE_EVERY_CELLS = 10 // 20 m
const MIN_SAMPLES = 75 // 1.5 km, enough to include corners
const SEARCH_WINDOW_M = 200
const SEARCH_STEP_M = 4
// Enough to tell whether the axes are mirrored, before spending the rest on the better one.
const TRIAL_ITERATIONS = 2
const FINAL_ITERATIONS = 6
// Beyond these the fit found something other than this track, so it isn't trusted.
const MAX_RMS_M = 20
const MAX_SCALE_ERROR = 0.03
const MAX_OFFSET_M = 250

export function defaultAlignment(gameLengthM: number, refLengthM: number): Alignment {
  return { a: refLengthM / gameLengthM, b: 0, rmsM: NaN, fitted: false }
}

interface Pose {
  cos: number
  sin: number
  tx: number
  ty: number
}

/** Best rotation and shift from one point set onto another (2D Procrustes). */
function fitPose(sx: number[], sy: number[], tx: number[], ty: number[]): Pose {
  const n = sx.length
  let msx = 0
  let msy = 0
  let mtx = 0
  let mty = 0
  for (let i = 0; i < n; i++) {
    msx += sx[i]
    msy += sy[i]
    mtx += tx[i]
    mty += ty[i]
  }
  msx /= n
  msy /= n
  mtx /= n
  mty /= n
  let dot = 0
  let cross = 0
  for (let i = 0; i < n; i++) {
    const ax = sx[i] - msx
    const ay = sy[i] - msy
    const bx = tx[i] - mtx
    const by = ty[i] - mty
    dot += ax * bx + ay * by
    cross += ax * by - ay * bx
  }
  const angle = Math.atan2(cross, dot)
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return { cos, sin, tx: mtx - (cos * msx - sin * msy), ty: mty - (sin * msx + cos * msy) }
}

function linearFit(xs: number[], ys: number[]): { a: number; b: number } {
  const n = xs.length
  let mx = 0
  let my = 0
  for (let i = 0; i < n; i++) {
    mx += xs[i]
    my += ys[i]
  }
  mx /= n
  my /= n
  let numerator = 0
  let denominator = 0
  for (let i = 0; i < n; i++) {
    numerator += (xs[i] - mx) * (ys[i] - my)
    denominator += (xs[i] - mx) ** 2
  }
  const a = denominator ? numerator / denominator : 1
  return { a, b: my - a * mx }
}

function runFit(d: number[], x: number[], z: number[], ref: ReferenceLap, start: Alignment, iterations: number): Alignment {
  let { a, b } = start
  let rms = Infinity
  for (let iteration = 0; iteration < iterations; iteration++) {
    // Pair every sample with the reference point expected at its distance...
    const px: number[] = []
    const py: number[] = []
    for (const distance of d) {
      px.push(ref.at('x', a * distance + b))
      py.push(ref.at('y', a * distance + b))
    }
    const pose = fitPose(x, z, px, py)

    // ...then, placed by that pose, see which reference point each is really nearest.
    const matched: number[] = []
    let squared = 0
    for (let i = 0; i < d.length; i++) {
      const wx = pose.cos * x[i] - pose.sin * z[i] + pose.tx
      const wy = pose.sin * x[i] + pose.cos * z[i] + pose.ty
      const expected = a * d[i] + b
      let bestDistance = expected
      let bestSquared = Infinity
      for (let m = expected - SEARCH_WINDOW_M; m <= expected + SEARCH_WINDOW_M; m += SEARCH_STEP_M) {
        const dx = ref.at('x', m) - wx
        const dy = ref.at('y', m) - wy
        const value = dx * dx + dy * dy
        if (value < bestSquared) {
          bestSquared = value
          bestDistance = m
        }
      }
      matched.push(bestDistance)
      squared += bestSquared
    }
    rms = Math.sqrt(squared / d.length)
    const fit = linearFit(d, matched)
    a = fit.a
    b = fit.b
  }
  return { a, b, rmsM: rms, fitted: true }
}

/**
 * Fits a recorded lap's world positions to the reference. Returns null if there
 * is too little of the lap yet, or it doesn't fit well enough to trust.
 */
export function fitAlignment(trace: LapTrace, gameLengthM: number, ref: ReferenceLap): Alignment | null {
  const d: number[] = []
  const x: number[] = []
  const z: number[] = []
  for (let cell = 0; cell * GRID_M < gameLengthM; cell += SAMPLE_EVERY_CELLS) {
    const px = trace.at('x', cell)
    const pz = trace.at('z', cell)
    if (Number.isNaN(px) || Number.isNaN(pz)) continue
    d.push(cell * GRID_M)
    x.push(px)
    z.push(pz)
  }
  if (d.length < MIN_SAMPLES) return null

  const start = defaultAlignment(gameLengthM, ref.lengthM)
  // The game's axes may be mirrored against the real circuit's.
  const flipped = z.map((value) => -value)
  const straightTrial = runFit(d, x, z, ref, start, TRIAL_ITERATIONS)
  const mirroredTrial = runFit(d, x, flipped, ref, start, TRIAL_ITERATIONS)
  const best =
    mirroredTrial.rmsM < straightTrial.rmsM
      ? runFit(d, x, flipped, ref, mirroredTrial, FINAL_ITERATIONS)
      : runFit(d, x, z, ref, straightTrial, FINAL_ITERATIONS)
  const trusted =
    best.rmsM <= MAX_RMS_M && Math.abs(best.a - start.a) <= MAX_SCALE_ERROR && Math.abs(best.b) <= MAX_OFFSET_M
  return trusted ? best : null
}

export const toReference = (alignment: Alignment, gameM: number) => alignment.a * gameM + alignment.b
export const toGame = (alignment: Alignment, refM: number) => (refM - alignment.b) / alignment.a
