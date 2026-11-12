// Per-corner comparison of a player's lap with a real driver's. Thresholds and
// rules come from the f1-telemetry-coach skill.

import type { MessageKey, Params } from '../i18n'
import { toGame, toReference, type Alignment } from './alignment'
import { GRID_M, lapClock, type LapTrace } from './lapRecorder'
import { curvature, REF_GRID_M, type ReferenceLap } from './reference'
import type { Track } from './store'

const STEP_M = REF_GRID_M
const APEX_SEARCH_M = 60
const MIN_SPEED_SEARCH_M = 80
const TURN_IN_SHARE = 0.3
const BRAKE_ON = 0.08
const BRAKE_OFF = 0.05
const LIFT_BELOW = 0.9
const THROTTLE_ON = 0.15
// The real laps' brake channel is on/off at about 7 Hz, so one braking zone can show gaps of up to ~30 m.
// Bridging them is safe because the search never reaches back past the previous corner.
const BRAKE_GAP_M = 36
const MAX_ZONE_LOOKBACK_M = 400

export type Level = 'bad' | 'warn' | 'ok'

export interface Chip {
  key: MessageKey
  params?: Params
  level: Level
}

export interface CornerZone {
  label: string
  /** Peak curvature of the real lap, in reference metres. */
  apexM: number
  peakKappa: number
  startM: number
  endM: number
  /** How far back braking for this corner may have begun: the previous corner's apex. */
  searchFromM: number
}

/**
 * One zone per corner around its expected position, each searched only up to
 * halfway to its neighbours, so the two corners of a chicane stay apart.
 */
export function zonesFromCenters(
  corners: { label: string; centerM: number }[],
  lengthM: number,
  kappaAt: (m: number) => number,
): CornerZone[] {
  const apexes = corners.map((corner, i) => {
    const from = i === 0 ? corner.centerM - APEX_SEARCH_M : Math.max(corner.centerM - APEX_SEARCH_M, (corners[i - 1].centerM + corner.centerM) / 2)
    const to = i === corners.length - 1 ? corner.centerM + APEX_SEARCH_M : Math.min(corner.centerM + APEX_SEARCH_M, (corner.centerM + corners[i + 1].centerM) / 2)
    let apexM = corner.centerM
    let peakKappa = 0
    for (let m = from; m <= to; m += STEP_M) {
      const value = Math.abs(kappaAt(m))
      if (value > peakKappa) {
        peakKappa = value
        apexM = m
      }
    }
    return { label: corner.label, apexM, peakKappa }
  })
  return apexes.map((apex, i) => ({
    ...apex,
    startM: i === 0 ? 0 : (apexes[i - 1].apexM + apex.apexM) / 2,
    endM: i === apexes.length - 1 ? lengthM : (apex.apexM + apexes[i + 1].apexM) / 2,
    searchFromM: i === 0 ? apex.apexM - MAX_ZONE_LOOKBACK_M : apexes[i - 1].apexM,
  }))
}

export interface DrivingPoints {
  brakeM: number | null
  brakeEndM: number | null
  liftM: number | null
  turnInM: number | null
  throttleOnM: number | null
  minSpeed: number
  minSpeedM: number
  maxBrake: number
  coastM: number | null
  speedAtBrake: number | null
  speedAtBrakeEnd: number | null
}

/** Reads a lap at reference distances, whichever lap it is. */
export interface LapView {
  speed(m: number): number
  throttle(m: number): number
  brake(m: number): number
  kappa(m: number): number
}

export function referenceView(ref: ReferenceLap): LapView {
  return {
    speed: (m) => ref.at('speed', m),
    throttle: (m) => ref.at('throttle', m),
    brake: (m) => ref.at('brake', m),
    kappa: (m) => ref.at('kappa', m),
  }
}

export function traceView(trace: LapTrace, alignment: Alignment): LapView {
  const xs = trace.channels.x
  const zs = trace.channels.z
  const kappa = curvature(xs, zs, GRID_M, false)
  const cell = (m: number) => Math.floor(toGame(alignment, m) / GRID_M)
  return {
    speed: (m) => trace.at('speed', cell(m)),
    throttle: (m) => trace.at('throttle', cell(m)),
    brake: (m) => trace.at('brake', cell(m)),
    kappa: (m) => {
      const index = cell(m)
      return index >= 0 && index < kappa.length ? kappa[index] : NaN
    },
  }
}

/** Splits the real lap into one stretch per corner, meeting halfway between corners. */
export function buildZones(track: Track, ref: ReferenceLap): CornerZone[] {
  const corners = track.corners.map((corner) => ({ label: corner.label, centerM: corner.fraction * ref.lengthM }))
  return zonesFromCenters(corners, ref.lengthM, (m) => ref.at('kappa', m))
}

/** Where a lap braked, lifted, turned in and got back on the throttle around a corner. */
export function drivingPoints(view: LapView, zone: CornerZone): DrivingPoints | null {
  let minSpeed = Infinity
  let minSpeedM = zone.apexM
  const slowestFrom = Math.max(zone.apexM - MIN_SPEED_SEARCH_M, zone.startM)
  const slowestTo = Math.min(zone.apexM + MIN_SPEED_SEARCH_M, zone.endM)
  for (let m = slowestFrom; m <= slowestTo; m += STEP_M) {
    const speed = view.speed(m)
    if (speed < minSpeed) {
      minSpeed = speed
      minSpeedM = m
    }
  }
  if (minSpeed === Infinity) return null

  // Braking for a corner can begin before its zone does, but not before the previous corner.
  const earliest = Math.max(zone.searchFromM, zone.apexM - MAX_ZONE_LOOKBACK_M)

  // The brake run ending nearest before the slowest point of this corner.
  let brakeLast: number | null = null
  for (let m = minSpeedM + 20; m >= earliest; m -= STEP_M) {
    if (view.brake(m) > BRAKE_ON) {
      brakeLast = m
      break
    }
  }
  let brakeM: number | null = null
  let brakeEndM: number | null = null
  let maxBrake = 0
  if (brakeLast !== null) {
    brakeM = brakeLast
    let gap = 0
    for (let m = brakeLast; m >= earliest; m -= STEP_M) {
      const value = view.brake(m)
      if (value > BRAKE_ON) {
        brakeM = m
        maxBrake = Math.max(maxBrake, value)
        gap = 0
      } else if ((gap += STEP_M) > BRAKE_GAP_M) break
    }
    brakeEndM = brakeLast
    for (let m = brakeLast; m <= brakeLast + MIN_SPEED_SEARCH_M; m += STEP_M) {
      if (view.brake(m) < BRAKE_OFF) {
        brakeEndM = m
        break
      }
    }
  }

  // Going back from the slowest point: where the throttle was last fully open.
  let liftM: number | null = null
  for (let m = minSpeedM; m >= earliest; m -= STEP_M) {
    const throttle = view.throttle(m)
    if (Number.isNaN(throttle) || throttle >= LIFT_BELOW) break
    liftM = m
  }

  let throttleOnM: number | null = null
  if (liftM !== null) {
    for (let m = minSpeedM; m <= zone.endM + MIN_SPEED_SEARCH_M; m += STEP_M) {
      if (view.throttle(m) > THROTTLE_ON) {
        throttleOnM = m
        break
      }
    }
  }

  // Back from peak curvature until it falls to 30 % of that peak.
  let peak = 0
  let peakM = zone.apexM
  for (let m = Math.max(zone.apexM - APEX_SEARCH_M, zone.startM); m <= Math.min(zone.apexM + APEX_SEARCH_M, zone.endM); m += STEP_M) {
    const value = Math.abs(view.kappa(m))
    if (value > peak) {
      peak = value
      peakM = m
    }
  }
  let turnInM: number | null = null
  if (peak > 0) {
    turnInM = peakM
    for (let m = peakM; m >= earliest; m -= STEP_M) {
      const value = Math.abs(view.kappa(m))
      if (Number.isNaN(value) || value < peak * TURN_IN_SHARE) break
      turnInM = m
    }
  }

  return {
    brakeM,
    brakeEndM,
    liftM,
    turnInM,
    throttleOnM,
    minSpeed,
    minSpeedM,
    maxBrake,
    coastM: brakeEndM !== null && throttleOnM !== null ? Math.max(0, throttleOnM - brakeEndM) : null,
    speedAtBrake: brakeM === null ? null : view.speed(brakeM),
    speedAtBrakeEnd: brakeEndM === null ? null : view.speed(brakeEndM),
  }
}

export interface BrakeEnvelope {
  a0: number
  c: number
}

/** Skill baseline: the F2 car at Barcelona. Used only until the player's own laps can replace it. */
export const DEFAULT_ENVELOPE: BrakeEnvelope = { a0: 22.0, c: 0.00102 }
const ENVELOPE_BIN_KMH = 20
const MIN_ENVELOPE_BINS = 3
const MIN_BIN_SAMPLES = 5

/** Fits the car's braking limit a(v) = a0 + c·v² to the hardest braking in the given laps. */
export function fitBrakeEnvelope(traces: LapTrace[]): BrakeEnvelope {
  const bins = new Map<number, number[]>()
  const span = 5 // cells: 10 m smooths over the speed value's whole-km/h steps
  for (const trace of traces) {
    const { speed, brake, time } = trace.channels
    for (let cell = 0; cell + span < speed.length; cell++) {
      if (!(brake[cell] > 0.6)) continue
      const dt = (time[cell + span] - time[cell]) / 1000
      const dv = (speed[cell] - speed[cell + span]) / 3.6
      if (!(dt > 0) || !(dv > 0)) continue
      const bin = Math.floor(speed[cell] / ENVELOPE_BIN_KMH)
      if (!bins.has(bin)) bins.set(bin, [])
      bins.get(bin)!.push(dv / dt)
    }
  }
  // Strongest decile of each speed band: what the car can do, not what it usually does.
  const points: { v2: number; a: number }[] = []
  for (const [bin, values] of bins) {
    if (values.length < MIN_BIN_SAMPLES) continue
    values.sort((a, b) => b - a)
    const v = ((bin + 0.5) * ENVELOPE_BIN_KMH) / 3.6
    points.push({ v2: v * v, a: values[Math.floor(values.length * 0.1)] })
  }
  if (points.length < MIN_ENVELOPE_BINS) return DEFAULT_ENVELOPE
  const meanX = points.reduce((sum, p) => sum + p.v2, 0) / points.length
  const meanY = points.reduce((sum, p) => sum + p.a, 0) / points.length
  let numerator = 0
  let denominator = 0
  for (const p of points) {
    numerator += (p.v2 - meanX) * (p.a - meanY)
    denominator += (p.v2 - meanX) ** 2
  }
  const c = denominator ? Math.max(0, numerator / denominator) : 0
  const a0 = meanY - c * meanX
  return a0 > 5 ? { a0, c } : DEFAULT_ENVELOPE
}

/** Distance the car needs to brake from one speed to another at its limit. */
export function brakingDistance(fromKmh: number, toKmh: number, envelope: BrakeEnvelope): number {
  let distance = 0
  const dv = 0.5
  for (let v = toKmh / 3.6; v < fromKmh / 3.6; v += dv) {
    distance += (v * dv) / (envelope.a0 + envelope.c * v * v)
  }
  return distance
}

export interface CornerAnalysis {
  label: string
  zone: CornerZone
  /** Seconds lost to the real driver over this corner's stretch. */
  lossS: number | null
  /** Seconds lost beyond this lap's average pace difference: the weakest places. */
  excessS: number | null
  own: DrivingPoints | null
  ref: DrivingPoints | null
  /** Metres of braking given away against the car's own limit. */
  reserveM: number | null
  chips: Chip[]
}

export interface LapAnalysis {
  lap: number
  lapMs: number
  corners: CornerAnalysis[]
  worst: CornerAnalysis[]
}

const round5 = (metres: number) => Math.round(Math.abs(metres) / 5) * 5

function verdicts(own: DrivingPoints, ref: DrivingPoints, reserveM: number | null, driver: string): Chip[] {
  const chips: Chip[] = []
  if (reserveM !== null && reserveM >= 20) chips.push({ key: 'chip.earlyBrake', params: { m: round5(reserveM) }, level: 'bad' })
  else if (reserveM !== null && reserveM >= 12) chips.push({ key: 'chip.slightlyEarlyBrake', params: { m: round5(reserveM) }, level: 'warn' })
  if (own.brakeM !== null && own.maxBrake < 0.9) chips.push({ key: 'chip.lowPressure', params: { percent: Math.round(own.maxBrake * 100) }, level: 'warn' })
  if (own.coastM !== null && own.coastM >= 20) chips.push({ key: 'chip.coast', params: { m: round5(own.coastM) }, level: 'warn' })

  // Lifting is judged only where neither lap brakes, because braking has its own rule above.
  if (own.brakeM === null && ref.brakeM === null && own.liftM !== null) {
    if (ref.liftM === null) {
      chips.push({ key: 'chip.liftDriverFlat', params: { driver }, level: 'warn' })
    } else {
      const early = ref.liftM - own.liftM
      if (early >= 15) chips.push({ key: 'chip.earlyLift', params: { m: round5(early) }, level: early >= 40 ? 'bad' : 'warn' })
    }
  } else if (own.brakeM !== null && ref.brakeM === null) {
    chips.push({ key: ref.liftM === null ? 'chip.brakeDriverFlat' : 'chip.brakeDriverLifts', params: { driver }, level: 'warn' })
  }

  if (own.turnInM !== null && ref.turnInM !== null) {
    const difference = own.turnInM - ref.turnInM
    if (difference <= -15) chips.push({ key: 'chip.earlyTurn', params: { m: round5(difference) }, level: 'bad' })
    else if (difference <= -8) chips.push({ key: 'chip.slightlyEarlyTurn', params: { m: round5(difference) }, level: 'warn' })
    else if (difference >= 15) chips.push({ key: 'chip.lateTurn', params: { m: round5(difference) }, level: 'warn' })
  }
  if (chips.length === 0) chips.push({ key: 'chip.entryOk', level: 'ok' })
  return chips
}

export function analyzeLap(
  trace: LapTrace,
  lapNumber: number,
  gameLengthM: number,
  ref: ReferenceLap,
  zones: CornerZone[],
  refPoints: (DrivingPoints | null)[],
  alignment: Alignment,
  envelope: BrakeEnvelope,
): LapAnalysis {
  const view = traceView(trace, alignment)
  // The stretches the game's lap can't cover, because its line is elsewhere, are trimmed.
  const firstM = toReference(alignment, 0)
  const lastM = toReference(alignment, gameLengthM)
  const shortName = ref.driver.name.split(' ').slice(-1)[0]

  const stretches = zones.map((zone) => {
    const fromM = Math.max(zone.startM, firstM)
    const toM = Math.min(zone.endM, lastM)
    // Neighbouring stretches share a boundary, so no time goes missing between them.
    const ownMs = lapClock(trace, toGame(alignment, toM), gameLengthM) - lapClock(trace, toGame(alignment, fromM), gameLengthM)
    return { fromM, toM, ownMs, refMs: ref.at('time', toM - 0.01) - ref.at('time', fromM) }
  })
  const measured = stretches.filter((s) => !Number.isNaN(s.ownMs))
  const totalOwn = measured.reduce((sum, s) => sum + s.ownMs, 0)
  const totalRef = measured.reduce((sum, s) => sum + s.refMs, 0)
  const pace = totalRef > 0 ? totalOwn / totalRef : 1

  const corners = zones.map((zone, i): CornerAnalysis => {
    const stretch = stretches[i]
    const known = !Number.isNaN(stretch.ownMs)
    const own = drivingPoints(view, zone)
    const refPoint = refPoints[i]
    let reserveM: number | null = null
    if (own && own.brakeM !== null && own.brakeEndM !== null && own.speedAtBrake !== null && own.speedAtBrakeEnd !== null) {
      reserveM = own.brakeEndM - own.brakeM - brakingDistance(own.speedAtBrake, own.speedAtBrakeEnd, envelope)
    }
    return {
      label: zone.label,
      zone,
      lossS: known ? (stretch.ownMs - stretch.refMs) / 1000 : null,
      excessS: known ? (stretch.ownMs - stretch.refMs * pace) / 1000 : null,
      own,
      ref: refPoint,
      reserveM,
      chips: own && refPoint ? verdicts(own, refPoint, reserveM, shortName) : [],
    }
  })
  const worst = corners
    .filter((corner) => corner.excessS !== null)
    .sort((a, b) => b.excessS! - a.excessS!)
    .slice(0, 3)
  return { lap: lapNumber, lapMs: trace.lapMs, corners, worst }
}
