import { describe, expect, it } from 'vitest'
import { LapRecorder, LapTrace, lapClock } from './lapRecorder'
import type { CarTick, LapTick } from './types'

const TRACK_M = 3000

function lapTick(over: Partial<LapTick> = {}): LapTick {
  return {
    last_lap_ms: 0, current_lap_ms: 0, sector1_ms: 0, sector1_min: 0, sector2_ms: 0, sector2_min: 0,
    lap_distance: 0, position: 1, lap_num: 1, pit_status: 0, pit_stops: 0, sector: 0, lap_invalid: 0,
    penalties_s: 0, warnings: 0, corner_cutting_warnings: 0, driver_status: 1, ...over,
  }
}

function carTick(over: Partial<CarTick> = {}): CarTick {
  return {
    speed: 200, throttle: 1, steer: 0, brake: 0, clutch: 0, gear: 5, rpm: 10000, drs: 0, rev_percent: 0,
    rev_lights: 0, brake_temps: [], tyre_surface_temps: [], tyre_inner_temps: [], engine_temp: 100, tyre_pressures: [], ...over,
  }
}

/** Drives one whole lap and crosses the line, publishing `ms` as the lap time. */
function driveLap(rec: LapRecorder, lapNum: number, ms: number, previousLastMs: number, over: Partial<LapTick> = {}) {
  const step = 3 // metres per tick
  for (let d = 0; d < TRACK_M; d += step) {
    rec.ingest(
      lapTick({
        lap_num: lapNum, lap_distance: d, current_lap_ms: Math.round((d / TRACK_M) * ms), last_lap_ms: previousLastMs,
        sector1_ms: d > 1000 ? Math.round(ms / 3) : 0, sector2_ms: d > 2000 ? Math.round(ms / 3) : 0, ...over,
      }),
      carTick(),
      TRACK_M,
    )
  }
  return rec.ingest(lapTick({ lap_num: lapNum + 1, last_lap_ms: ms }), carTick(), TRACK_M)
}

describe('LapRecorder', () => {
  it('records a finished lap with its sectors', () => {
    const rec = new LapRecorder()
    expect(driveLap(rec, 1, 90000, 0)).toBe(true)
    expect(rec.laps).toEqual([{ lap: 1, ms: 90000, s1: 30000, s2: 30000, s3: 30000, valid: true, clean: true }])
    expect(rec.last?.lapMs).toBe(90000)
    expect(rec.best?.lapMs).toBe(90000)
  })

  it('fills the grid cells skipped between samples', () => {
    const rec = new LapRecorder()
    rec.ingest(lapTick({ lap_distance: 100, current_lap_ms: 1000 }), carTick({ speed: 100 }), TRACK_M)
    rec.ingest(lapTick({ lap_distance: 110, current_lap_ms: 2000 }), carTick({ speed: 200 }), TRACK_M)
    expect(rec.current.at('speed', 52)).toBeCloseTo(140)
    expect(rec.current.at('time', 54)).toBeCloseTo(1800)
    expect(rec.current.at('speed', 56)).toBeNaN()
  })

  it('keeps the fastest valid lap as the reference and ignores invalid ones', () => {
    const rec = new LapRecorder()
    driveLap(rec, 1, 90000, 0)
    driveLap(rec, 2, 85000, 90000, { lap_invalid: 1 })
    driveLap(rec, 3, 88000, 85000)
    driveLap(rec, 4, 89000, 88000)
    expect(rec.laps.map((row) => row.valid)).toEqual([true, false, true, true])
    expect(rec.best?.lapMs).toBe(88000)
    expect(rec.bestLap?.lap).toBe(3)
    expect(rec.last?.lapMs).toBe(89000)
  })

  it('remembers a lap as invalid even if the flag was only set for a moment', () => {
    const rec = new LapRecorder()
    rec.ingest(lapTick({ lap_distance: 10, lap_invalid: 1 }), carTick(), TRACK_M)
    driveLap(rec, 1, 80000, 0)
    expect(rec.laps[0].valid).toBe(false)
    expect(rec.best).toBeNull()
  })

  it('does not use out laps or pit laps as a reference, but still lists them', () => {
    const rec = new LapRecorder()
    driveLap(rec, 1, 95000, 0, { driver_status: 3 })
    driveLap(rec, 2, 94000, 95000, { pit_status: 1 })
    expect(rec.laps.map((row) => row.clean)).toEqual([false, false])
    expect(rec.best).toBeNull()
    expect(rec.bestLap?.ms).toBe(94000)
  })

  it('does not use a partly recorded lap as a reference', () => {
    const rec = new LapRecorder()
    for (let d = 2000; d < TRACK_M; d += 3) {
      rec.ingest(lapTick({ lap_distance: d, current_lap_ms: d * 10 }), carTick(), TRACK_M)
    }
    rec.ingest(lapTick({ lap_num: 2, last_lap_ms: 30000 }), carTick(), TRACK_M)
    expect(rec.laps).toHaveLength(1)
    expect(rec.best).toBeNull()
  })

  it('waits for the lap time when it arrives after the lap number', () => {
    const rec = new LapRecorder()
    for (let d = 0; d < TRACK_M; d += 3) {
      rec.ingest(lapTick({ lap_distance: d, current_lap_ms: d * 30, last_lap_ms: 70000 }), carTick(), TRACK_M)
    }
    expect(rec.ingest(lapTick({ lap_num: 2, last_lap_ms: 70000 }), carTick(), TRACK_M)).toBe(false)
    expect(rec.laps).toHaveLength(0)
    expect(rec.ingest(lapTick({ lap_num: 2, last_lap_ms: 90000 }), carTick(), TRACK_M)).toBe(true)
    expect(rec.laps[0].ms).toBe(90000)
  })

  it('gives up waiting if the game never publishes a lap time', () => {
    const rec = new LapRecorder()
    rec.ingest(lapTick({ lap_distance: 10 }), carTick(), TRACK_M)
    for (let i = 0; i < 40; i++) rec.ingest(lapTick({ lap_num: 2, lap_distance: i + 1 }), carTick(), TRACK_M)
    rec.ingest(lapTick({ lap_num: 2, lap_distance: 50, last_lap_ms: 80000 }), carTick(), TRACK_M)
    expect(rec.laps).toHaveLength(0)
  })

  it('undoes everything after the new position on a flashback within a lap', () => {
    const rec = new LapRecorder()
    rec.ingest(lapTick({ lap_distance: 100, current_lap_ms: 1000 }), carTick(), TRACK_M)
    rec.ingest(lapTick({ lap_distance: 500, current_lap_ms: 5000 }), carTick(), TRACK_M)
    rec.ingest(lapTick({ lap_distance: 200, current_lap_ms: 2000 }), carTick(), TRACK_M)
    expect(rec.current.at('time', 250)).toBeNaN()
    expect(rec.current.at('time', 100)).toBe(2000)
    expect(rec.current.at('time', 50)).toBe(1000)
  })

  it('records a lap exactly as fast as the one before', () => {
    const rec = new LapRecorder()
    driveLap(rec, 1, 88123, 0)
    driveLap(rec, 2, 88123, 88123)
    // The game's last lap time never changes, so only the wait running out can settle it.
    for (let i = 0; i < 40; i++) rec.ingest(lapTick({ lap_num: 3, lap_distance: i * 3, current_lap_ms: i * 30, last_lap_ms: 88123 }), carTick(), TRACK_M)
    expect(rec.laps.map((row) => row.ms)).toEqual([88123, 88123])
    expect(rec.traces.has(2)).toBe(true)
  })

  it('resumes the lap a flashback across the line returns to, and forgets the undone best', () => {
    const rec = new LapRecorder()
    driveLap(rec, 1, 90000, 0)
    driveLap(rec, 2, 85000, 90000)
    expect(rec.best?.lapMs).toBe(85000)
    // Back to 2900 m of lap 2, then finishing it again more slowly.
    rec.ingest(lapTick({ lap_num: 2, lap_distance: 2900, current_lap_ms: 82000, last_lap_ms: 90000 }), carTick(), TRACK_M)
    expect(rec.best?.lapMs).toBe(90000)
    expect(rec.last?.lapMs).toBe(90000)
    expect(rec.current.at('time', 750)).toBeCloseTo(42500, -2)
    for (let d = 2903; d < TRACK_M; d += 3) {
      rec.ingest(lapTick({ lap_num: 2, lap_distance: d, current_lap_ms: 82000 + (d - 2900) * 40, last_lap_ms: 90000 }), carTick(), TRACK_M)
    }
    rec.ingest(lapTick({ lap_num: 3, last_lap_ms: 86000 }), carTick(), TRACK_M)
    expect(rec.laps.map((row) => row.ms)).toEqual([90000, 86000])
    // The whole lap is there: early cells from before the flashback, late ones from after.
    expect(rec.traces.get(2)!.recordedCells()).toBeGreaterThan(1450)
    expect(rec.best?.lapMs).toBe(86000)
  })

  it('takes back the invalid flag when a flashback undoes what caused it', () => {
    const rec = new LapRecorder()
    rec.ingest(lapTick({ lap_distance: 100, current_lap_ms: 1000 }), carTick(), TRACK_M)
    rec.ingest(lapTick({ lap_distance: 500, current_lap_ms: 5000, lap_invalid: 1 }), carTick(), TRACK_M)
    rec.ingest(lapTick({ lap_distance: 200, current_lap_ms: 2000, lap_invalid: 0 }), carTick(), TRACK_M)
    for (let d = 203; d < TRACK_M; d += 3) rec.ingest(lapTick({ lap_distance: d, current_lap_ms: d * 10 }), carTick(), TRACK_M)
    rec.ingest(lapTick({ lap_num: 2, last_lap_ms: 30000 }), carTick(), TRACK_M)
    expect(rec.laps[0].valid).toBe(true)
  })

  it('drops laps undone by a flashback across the line', () => {
    const rec = new LapRecorder()
    driveLap(rec, 1, 90000, 0)
    driveLap(rec, 2, 89000, 90000)
    expect(rec.laps).toHaveLength(2)
    expect(rec.ingest(lapTick({ lap_num: 2, lap_distance: 2900, current_lap_ms: 88000, last_lap_ms: 90000 }), carTick(), TRACK_M)).toBe(true)
    expect(rec.laps.map((row) => row.lap)).toEqual([1])
  })

  it('ignores the distance before the first crossing of the line', () => {
    const rec = new LapRecorder()
    rec.ingest(lapTick({ lap_distance: -150 }), carTick(), TRACK_M)
    expect(rec.current.recordedCells()).toBe(0)
  })

  it('reports the delta to the best lap at the same place on track', () => {
    const rec = new LapRecorder()
    driveLap(rec, 1, 90000, 0)
    rec.ingest(lapTick({ lap_num: 2, lap_distance: 1500, current_lap_ms: 44000, last_lap_ms: 90000 }), carTick(), TRACK_M)
    expect(rec.deltaAt(1500)).toBeCloseTo(-1, 1)
    expect(rec.deltaAt(2500)).toBeNull()
  })

  it('reset forgets the session', () => {
    const rec = new LapRecorder()
    driveLap(rec, 1, 90000, 0)
    rec.reset()
    expect(rec.laps).toEqual([])
    expect(rec.best).toBeNull()
    expect(rec.last).toBeNull()
  })
})

describe('lapClock', () => {
  /** 50 m/s from the line, so the clock is 20 ms per metre. */
  function steady(lengthM: number): LapTrace {
    const trace = new LapTrace()
    for (let cell = 0; cell * 2 <= lengthM; cell++) trace.channels.time[cell] = cell * 2 * 20
    trace.lapMs = lengthM * 20
    return trace
  }

  it('fills a hole left by a dropout from the samples around it', () => {
    const trace = steady(3000)
    trace.channels.time.fill(NaN, 700, 794) // 1400-1588 m, like a 3.6 s dropout
    expect(lapClock(trace, 1500, 3000)).toBeCloseTo(30000, -1)
    expect(lapClock(trace, 1402, 3000)).toBeCloseTo(28040, -1)
  })

  it('does not invent time past the end of a lap still being driven', () => {
    const trace = steady(3000)
    trace.lapMs = 0
    trace.channels.time.fill(NaN, 1000)
    expect(lapClock(trace, 2100, 3000)).toBeNaN()
  })

  it('does not bridge a hole longer than it can trust', () => {
    const trace = steady(3000)
    trace.channels.time.fill(NaN, 200, 600) // 800 m
    expect(lapClock(trace, 800, 3000)).toBeNaN()
  })

  it('interpolates to the lap time when the last metres before the line have no samples', () => {
    const trace = steady(3000)
    trace.channels.time.fill(NaN, 1490) // 2980 m onwards
    expect(lapClock(trace, 2990, 3000)).toBeCloseTo(59800, -1)
  })

  it('still knows the time at both ends of the lap', () => {
    const trace = steady(3000)
    trace.channels.time.fill(NaN, 0, 3)
    trace.channels.time.fill(NaN, 1497)
    expect(lapClock(trace, 0, 3000)).toBe(0)
    expect(lapClock(trace, 4, 3000)).toBeCloseTo(80, -1)
    expect(lapClock(trace, 3000, 3000)).toBe(60000)
  })
})
