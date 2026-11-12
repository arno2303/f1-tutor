import type { CarTick, LapTick, MotionTick } from './types'

/** Width of one cell of the per-lap distance grid. */
export const GRID_M = 2
export const CELLS = 5000 // 10 km, longer than any lap
// A gap this long between two samples is a teleport (flashback, recovery), not driving.
const MAX_INTERPOLATED_GAP_M = 60
// A lap needs this much of its length recorded to be used as a reference trace.
const MIN_COVERAGE = 0.95
// How many ticks to wait for the game to publish the time of the lap just finished.
const LAST_LAP_WAIT_TICKS = 30
// A lap time equal to the previous one is believed when the running clock agreed this closely.
const SAME_TIME_TOLERANCE_MS = 500

export type Channel = 'speed' | 'throttle' | 'brake' | 'gear' | 'steer' | 'time' | 'x' | 'z'
// Saved laps store the channels in this order; results_db.TRACE_CHANNELS must match.
export const CHANNELS: Channel[] = ['speed', 'throttle', 'brake', 'gear', 'steer', 'time', 'x', 'z']

export class LapTrace {
  readonly channels = {} as Record<Channel, Float32Array>
  lapMs = 0
  /** Valid, clean and fully recorded: good enough to be the reference lap. */
  eligible = false

  constructor() {
    for (const channel of CHANNELS) this.channels[channel] = new Float32Array(CELLS).fill(NaN)
  }

  /** Value in a grid cell, NaN if it wasn't recorded. */
  at(channel: Channel, cell: number): number {
    return cell >= 0 && cell < CELLS ? this.channels[channel][cell] : NaN
  }

  recordedCells(): number {
    let count = 0
    for (const time of this.channels.time) if (!Number.isNaN(time)) count++
    return count
  }

  clearAfter(cell: number): void {
    for (const channel of CHANNELS) this.channels[channel].fill(NaN, Math.max(cell + 1, 0))
  }
}

export interface LapRow {
  lap: number
  ms: number
  s1: number | null
  s2: number | null
  s3: number | null
  valid: boolean
  /** Not an in/out lap and never in the pits. */
  clean: boolean
}

interface Sample {
  cell: number
  distance: number
  timeMs: number
  speed: number
  throttle: number
  brake: number
  gear: number
  steer: number
  x: number
  z: number
}

interface PendingLap {
  row: Omit<LapRow, 'ms' | 's3'>
  trace: LapTrace
  previousLastMs: number
  /** The lap clock just before the line, to check a lap time that looks unchanged. */
  runningMs: number
  ticksLeft: number
}

const sectorMs = (ms: number, minutes: number) => (ms === 0 && minutes === 0 ? null : minutes * 60000 + ms)

/**
 * Collects the driver's laps on a 2 m distance grid, so any two laps can be
 * compared at the same place on track.
 */
export class LapRecorder {
  current = new LapTrace()
  last: LapTrace | null = null
  best: LapTrace | null = null
  laps: LapRow[] = []
  /** Every finished lap's telemetry by lap number, so a whole session can be saved. */
  traces = new Map<number, LapTrace>()

  private lapNum: number | null = null
  private previous: Sample | null = null
  private previousLap: LapTick | null = null
  private lapInvalid = false
  private lapTainted = false
  private pending: PendingLap | null = null

  reset(): void {
    this.current = new LapTrace()
    this.last = null
    this.best = null
    this.laps = []
    this.traces = new Map()
    this.lapNum = null
    this.previous = null
    this.previousLap = null
    this.lapInvalid = false
    this.lapTainted = false
    this.pending = null
  }

  get bestLap(): LapRow | null {
    let best: LapRow | null = null
    for (const row of this.laps) if (row.valid && (!best || row.ms < best.ms)) best = row
    return best
  }

  /** Fastest valid time per sector, in milliseconds. */
  bestSector(sector: 's1' | 's2' | 's3'): number | null {
    let best: number | null = null
    for (const row of this.laps) {
      const value = row[sector]
      if (row.valid && value !== null && (best === null || value < best)) best = value
    }
    return best
  }

  /** Seconds gained (negative) or lost against another lap, by default the best, at a distance. */
  deltaAt(distance: number, against: LapTrace | null = this.best): number | null {
    if (!against) return null
    const cell = Math.floor(distance / GRID_M)
    const delta = this.current.at('time', cell) - against.at('time', cell)
    return Number.isNaN(delta) ? null : delta / 1000
  }

  /** Returns true when the list of finished laps changed. */
  ingest(lap: LapTick, car: CarTick | null, trackLengthM: number | undefined, motion?: MotionTick | null): boolean {
    let changed = false
    if (lap.lap_num !== this.lapNum) {
      changed = this.startLap(lap)
    } else if (this.previous && lap.current_lap_ms < this.previous.timeMs) {
      // Flashback within the lap: everything recorded after the new position is undone,
      // and so may be what made the lap invalid; the game says so again if not.
      this.current.clearAfter(Math.floor(lap.lap_distance / GRID_M))
      this.previous = null
      this.lapInvalid = false
    }
    changed = this.settlePending(lap, trackLengthM) || changed

    this.lapInvalid ||= lap.lap_invalid !== 0
    this.lapTainted ||= lap.pit_status !== 0 || lap.driver_status === 0 || lap.driver_status === 2 || lap.driver_status === 3
    if (car) this.record(lap, car, motion ?? null)
    this.previousLap = lap
    return changed
  }

  private startLap(lap: LapTick): boolean {
    let changed = false
    const finishedNormally = this.lapNum !== null && lap.lap_num === this.lapNum + 1
    if (finishedNormally && this.previousLap) {
      this.pending = {
        row: {
          lap: this.lapNum!,
          s1: sectorMs(this.previousLap.sector1_ms, this.previousLap.sector1_min),
          s2: sectorMs(this.previousLap.sector2_ms, this.previousLap.sector2_min),
          valid: !this.lapInvalid,
          clean: !this.lapTainted,
        },
        trace: this.current,
        previousLastMs: this.previousLap.last_lap_ms,
        runningMs: this.previousLap.current_lap_ms,
        ticksLeft: LAST_LAP_WAIT_TICKS,
      }
      this.current = new LapTrace()
      this.lapTainted = false
    } else if (this.lapNum !== null) {
      changed = this.rewind(lap)
    } else {
      this.current = new LapTrace()
      this.lapTainted = false
    }
    this.lapNum = lap.lap_num
    this.previous = null
    this.lapInvalid = false
    return changed
  }

  /**
   * A flashback back across the line, or a restart. The lap being returned to
   * carries on from what was recorded of it; laps after it no longer happened.
   */
  private rewind(lap: LapTick): boolean {
    const resumed = this.pending?.row.lap === lap.lap_num ? this.pending.trace : this.traces.get(lap.lap_num)
    const resumedRow = this.laps.find((row) => row.lap === lap.lap_num)
    const kept = this.laps.filter((row) => row.lap < lap.lap_num)
    const changed = kept.length !== this.laps.length
    this.laps = kept
    for (const lapNumber of this.traces.keys()) if (lapNumber >= lap.lap_num) this.traces.delete(lapNumber)
    this.pending = null

    if (resumed) {
      resumed.clearAfter(Math.floor(lap.lap_distance / GRID_M))
      resumed.lapMs = 0
      resumed.eligible = false
      this.current = resumed
      this.lapTainted = resumedRow ? !resumedRow.clean : false
    } else {
      this.current = new LapTrace()
      this.lapTainted = false
    }
    // The reference and the latest lap may have been among the laps undone.
    const remaining = kept.map((row) => this.traces.get(row.lap)).filter((trace): trace is LapTrace => !!trace)
    this.last = remaining[remaining.length - 1] ?? null
    this.best = remaining.filter((trace) => trace.eligible).reduce<LapTrace | null>((best, trace) => (!best || trace.lapMs < best.lapMs ? trace : best), null)
    return changed
  }

  /** The game can publish a lap's time a frame after the lap number changes. */
  private settlePending(lap: LapTick, trackLengthM: number | undefined): boolean {
    if (!this.pending) return false
    const pending = this.pending
    if (lap.last_lap_ms === pending.previousLastMs || lap.last_lap_ms === 0) {
      if (--pending.ticksLeft > 0) return false
      // Still unchanged: either the lap took exactly as long as the one before,
      // which the running clock confirms, or the game never published a time.
      const sameTime = lap.last_lap_ms > 0 && Math.abs(lap.last_lap_ms - pending.runningMs) <= SAME_TIME_TOLERANCE_MS
      if (!sameTime) {
        this.pending = null
        return false
      }
    }
    this.pending = null
    const { row, trace } = pending
    const s3 = row.s1 !== null && row.s2 !== null ? lap.last_lap_ms - row.s1 - row.s2 : null
    const finished: LapRow = { ...row, ms: lap.last_lap_ms, s3 }
    trace.lapMs = finished.ms
    this.laps = [...this.laps, finished]
    this.traces.set(finished.lap, trace)
    this.last = trace

    const cellsNeeded = ((trackLengthM ?? 0) / GRID_M) * MIN_COVERAGE
    const complete = trackLengthM !== undefined && trace.recordedCells() >= cellsNeeded
    trace.eligible = finished.valid && finished.clean && complete
    if (trace.eligible && (!this.best || finished.ms < this.best.lapMs)) {
      this.best = trace
    }
    return true
  }

  private record(lap: LapTick, car: CarTick, motion: MotionTick | null): void {
    const distance = lap.lap_distance
    if (distance < 0 || distance >= CELLS * GRID_M) return
    const sample: Sample = {
      cell: Math.floor(distance / GRID_M),
      distance,
      timeMs: lap.current_lap_ms,
      speed: car.speed,
      throttle: car.throttle,
      brake: car.brake,
      gear: car.gear,
      steer: car.steer,
      x: motion?.x ?? NaN,
      z: motion?.z ?? NaN,
    }
    const previous = this.previous
    const connected = previous && distance >= previous.distance && distance - previous.distance <= MAX_INTERPOLATED_GAP_M
    if (connected && sample.cell > previous.cell) {
      // Fill every cell passed since the last sample; at 30 Hz a fast car skips some.
      for (let cell = previous.cell + 1; cell < sample.cell; cell++) {
        const t = (cell * GRID_M - previous.distance) / (distance - previous.distance)
        this.write(cell, previous, sample, t)
      }
    }
    this.write(sample.cell, sample, sample, 0)
    this.previous = sample
  }

  private write(cell: number, a: Sample, b: Sample, t: number): void {
    const { channels } = this.current
    channels.speed[cell] = a.speed + (b.speed - a.speed) * t
    channels.throttle[cell] = a.throttle + (b.throttle - a.throttle) * t
    channels.brake[cell] = a.brake + (b.brake - a.brake) * t
    channels.steer[cell] = a.steer + (b.steer - a.steer) * t
    channels.gear[cell] = t < 0.5 ? a.gear : b.gear
    channels.time[cell] = a.timeMs + (b.timeMs - a.timeMs) * t
    channels.x[cell] = a.x + (b.x - a.x) * t
    channels.z[cell] = a.z + (b.z - a.z) * t
  }
}

// A lap's first sample can land a few metres past the line and its last a few before it.
const LINE_MARGIN_M = 30
// A dropout in the game's data leaves a hole; with data on both sides, its time is known well enough.
const MAX_TIME_BRIDGE_M = 600

/**
 * A lap's clock at a distance, in ms. At the line itself the time is known by
 * definition even without a sample there: zero at the start, the lap time at the end.
 * Inside a hole left by a dropout, it's interpolated from the samples on either side.
 */
export function lapClock(trace: LapTrace, metres: number, lengthM: number): number {
  if (metres <= 0) return 0
  const cell = Math.round(metres / GRID_M)
  const value = trace.at('time', cell)
  if (!Number.isNaN(value)) return value
  if (trace.lapMs > 0 && metres >= lengthM - LINE_MARGIN_M) {
    // Between the last sample and the line, where the clock reads the lap time.
    let last = cell - 1
    while (last >= 0 && cell - last <= LINE_MARGIN_M && Number.isNaN(trace.at('time', last))) last--
    const lastMs = trace.at('time', last)
    if (Number.isNaN(lastMs) || metres >= lengthM) return trace.lapMs
    return lastMs + ((trace.lapMs - lastMs) * (metres - last * GRID_M)) / (lengthM - last * GRID_M)
  }
  if (metres <= LINE_MARGIN_M) {
    for (let next = cell + 1; next * GRID_M <= LINE_MARGIN_M * 2; next++) {
      const after = trace.at('time', next)
      if (!Number.isNaN(after)) return (after * metres) / (next * GRID_M)
    }
  }
  const reach = MAX_TIME_BRIDGE_M / GRID_M
  let before = cell - 1
  while (before >= 0 && cell - before <= reach && Number.isNaN(trace.at('time', before))) before--
  let after = cell + 1
  while (after - cell <= reach && Number.isNaN(trace.at('time', after))) after++
  const startMs = before < 0 ? 0 : trace.at('time', before)
  const endMs = trace.at('time', after)
  const from = Math.max(before, 0)
  // Data on both sides of a hole short enough to trust: not the end of a lap still being driven.
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || after - from > reach) return NaN
  return startMs + ((endMs - startMs) * (cell - from)) / (after - from)
}
