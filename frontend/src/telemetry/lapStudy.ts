// Comparing two whole laps after driving: a lap of the player's against a real
// driver's lap or another of their own. Everything is measured in the first
// lap's own metres, so the two can be laid over each other directly.

import { toGame, toReference, type Alignment } from './alignment'
import {
  drivingPoints, traceView, zonesFromCenters, type Chip, type CornerAnalysis, type CornerZone, type DrivingPoints, type LapView,
} from './analysis'
import { GRID_M, lapClock, type Channel, type LapTrace } from './lapRecorder'
import type { ReferenceLap } from './reference'
import type { Track } from './store'

export type SideChannel = Exclude<Channel, 'time' | 'x' | 'z'>

/** One lap, readable at the first lap's metres. */
export interface LapSide {
  label: string
  lapMs: number
  view: LapView
  value(channel: SideChannel, metres: number): number
  /** Milliseconds from where the first lap started, to a place on it. */
  elapsed(metres: number): number
}

const SAME_PLACE: Alignment = { a: 1, b: 0, rmsM: 0, fitted: true }

export function ownSide(trace: LapTrace, lengthM: number, label: string): LapSide {
  return {
    label,
    lapMs: trace.lapMs,
    view: traceView(trace, SAME_PLACE),
    value: (channel, metres) => trace.at(channel, Math.floor(metres / GRID_M)),
    elapsed: (metres) => lapClock(trace, metres, lengthM),
  }
}

/**
 * A real driver's lap read at the game's metres. Given the game's lap length, its
 * clock is also pinned to finish one game lap on the real lap time: the alignment's
 * small length error would otherwise build up over the lap.
 */
export function realSide(ref: ReferenceLap, alignment: Alignment, label: string, gameLengthM?: number): LapSide {
  const at = (metres: number) => toReference(alignment, metres)
  // The real lap's clock starts at its own line, which isn't where the game's is.
  const start = ref.timeAt(alignment.b)
  const drift = gameLengthM ? ref.driver.lapMs - (ref.timeAt(at(gameLengthM)) - start) : 0
  return {
    label,
    lapMs: ref.driver.lapMs,
    view: {
      speed: (m) => ref.at('speed', at(m)),
      throttle: (m) => ref.at('throttle', at(m)),
      brake: (m) => ref.at('brake', at(m)),
      kappa: (m) => ref.at('kappa', at(m)),
    },
    value: (channel, metres) => (channel === 'steer' ? NaN : ref.at(channel, at(metres))),
    elapsed: (metres) => ref.timeAt(at(metres)) - start + (gameLengthM ? (drift * metres) / gameLengthM : 0),
  }
}

/** Gap in seconds at a place: positive when the first lap is behind. */
export function gapAt(a: LapSide, b: LapSide, metres: number): number {
  return (a.elapsed(metres) - b.elapsed(metres)) / 1000
}

/**
 * One stretch per corner in the first lap's metres. With a real lap and its
 * alignment the corners come from the real line; without, from the map's
 * corner positions, refined to where the lap really turned most.
 */
export function studyZones(
  track: Track,
  lengthM: number,
  view: LapView,
  real?: { zones: CornerZone[]; alignment: Alignment },
): CornerZone[] {
  const clamp = (m: number) => Math.max(0, Math.min(lengthM, m))
  if (real && real.zones.length) {
    return real.zones.map((zone, i, all) => ({
      ...zone,
      apexM: clamp(toGame(real.alignment, zone.apexM)),
      startM: i === 0 ? 0 : clamp(toGame(real.alignment, zone.startM)),
      endM: i === all.length - 1 ? lengthM : clamp(toGame(real.alignment, zone.endM)),
      searchFromM: toGame(real.alignment, zone.searchFromM),
    }))
  }
  const corners = track.corners
    .map((corner) => ({ label: corner.label, centerM: corner.fraction * lengthM }))
    .sort((a, b) => a.centerM - b.centerM)
  return zonesFromCenters(corners, lengthM, (m) => view.kappa(m)).map((zone) => ({ ...zone, apexM: clamp(zone.apexM) }))
}

export interface StudyRow {
  label: string
  zone: CornerZone
  /** Seconds the first lap lost (positive) or gained over this corner's stretch. */
  deltaS: number | null
  /** Seconds lost beyond the lap's average gap for a stretch this long: the weakest places. */
  excessS: number | null
  a: DrivingPoints | null
  b: DrivingPoints | null
  /** Positive: the first lap brakes later. */
  brakeDeltaM: number | null
  minSpeedDeltaKmh: number | null
  /** Positive: the first lap turns in later. */
  turnInDeltaM: number | null
  chips: Chip[]
}

const round5 = (metres: number) => Math.round(Math.abs(metres) / 5) * 5
// Smaller differences than these are within what the data can tell apart.
const BRAKE_NOTE_M = 10
const SPEED_NOTE_KMH = 3
const TURN_NOTE_M = 10

/** Notes on how the first lap took a corner differently from another lap of the player's. */
export function ownLapChips(row: Pick<StudyRow, 'a' | 'b' | 'brakeDeltaM' | 'minSpeedDeltaKmh' | 'turnInDeltaM'>): Chip[] {
  const chips: Chip[] = []
  const { a, b, brakeDeltaM, minSpeedDeltaKmh, turnInDeltaM } = row
  if (brakeDeltaM !== null && brakeDeltaM <= -BRAKE_NOTE_M) chips.push({ key: 'chip.brakeEarlier', params: { m: round5(brakeDeltaM) }, level: 'warn' })
  else if (brakeDeltaM !== null && brakeDeltaM >= BRAKE_NOTE_M) chips.push({ key: 'chip.brakeLater', params: { m: round5(brakeDeltaM) }, level: 'ok' })
  else if (a?.brakeM != null && b?.brakeM == null) chips.push({ key: 'chip.brakeOnlyHere', level: 'warn' })
  else if (a?.brakeM == null && b?.brakeM != null) chips.push({ key: 'chip.noBrakeHere', level: 'ok' })
  if (minSpeedDeltaKmh !== null && minSpeedDeltaKmh <= -SPEED_NOTE_KMH) {
    chips.push({ key: 'chip.minSpeedLower', params: { v: Math.round(-minSpeedDeltaKmh) }, level: 'warn' })
  } else if (minSpeedDeltaKmh !== null && minSpeedDeltaKmh >= SPEED_NOTE_KMH) {
    chips.push({ key: 'chip.minSpeedHigher', params: { v: Math.round(minSpeedDeltaKmh) }, level: 'ok' })
  }
  if (turnInDeltaM !== null && Math.abs(turnInDeltaM) >= TURN_NOTE_M) {
    chips.push({ key: turnInDeltaM < 0 ? 'chip.turnEarlier' : 'chip.turnLater', params: { m: round5(turnInDeltaM) }, level: 'warn' })
  }
  if (chips.length === 0) chips.push({ key: 'chip.sameEntry', level: 'ok' })
  return chips
}

const difference = (x: number | null | undefined, y: number | null | undefined) => (x == null || y == null ? null : x - y)

/**
 * Corner by corner: time, brake point, minimum speed and turn-in of the first
 * lap against the second. `verdicts` replaces the notes, for a real driver's lap.
 */
export function studyRows(a: LapSide, b: LapSide, zones: CornerZone[], verdicts?: Map<string, Chip[]>): StudyRow[] {
  const lapGap = a.lapMs - b.lapMs
  return zones.map((zone) => {
    const own = a.elapsed(zone.endM) - a.elapsed(zone.startM)
    const other = b.elapsed(zone.endM) - b.elapsed(zone.startM)
    const deltaS = (own - other) / 1000
    const excessS = (own - other - (lapGap * other) / b.lapMs) / 1000
    const pointsA = drivingPoints(a.view, zone)
    const pointsB = drivingPoints(b.view, zone)
    const row = {
      label: zone.label,
      zone,
      deltaS: Number.isNaN(deltaS) ? null : deltaS,
      excessS: Number.isNaN(excessS) ? null : excessS,
      a: pointsA,
      b: pointsB,
      brakeDeltaM: difference(pointsA?.brakeM, pointsB?.brakeM),
      minSpeedDeltaKmh: difference(pointsA?.minSpeed, pointsB?.minSpeed),
      turnInDeltaM: difference(pointsA?.turnInM, pointsB?.turnInM),
    }
    return { ...row, chips: verdicts?.get(zone.label) ?? ownLapChips(row) }
  })
}

/** The skill's verdicts from a real-driver analysis, by corner. */
export function verdictsByCorner(corners: CornerAnalysis[]): Map<string, Chip[]> {
  return new Map(corners.map((corner) => [corner.label, corner.chips]))
}

export type GapTrend = 'gain' | 'loss' | 'even'

// Below this rate of change over 20 m the gap counts as holding steady.
const TREND_THRESHOLD_MS = 4

/**
 * Whether the first lap is gaining or losing time around a place. With
 * `relative`, measured against the lap's average gap instead of zero: against a
 * much faster lap that shows where it's lost most, not just that it's lost.
 */
export function gapTrend(a: LapSide, b: LapSide, metres: number, lengthM: number, relative = false): GapTrend | null {
  const from = Math.max(0, metres - 10)
  const to = Math.min(lengthM, metres + 10)
  let change = (a.elapsed(to) - b.elapsed(to)) - (a.elapsed(from) - b.elapsed(from))
  if (relative) change -= ((a.lapMs - b.lapMs) * (b.elapsed(to) - b.elapsed(from))) / b.lapMs
  if (Number.isNaN(change)) return null
  return change > TREND_THRESHOLD_MS ? 'loss' : change < -TREND_THRESHOLD_MS ? 'gain' : 'even'
}
