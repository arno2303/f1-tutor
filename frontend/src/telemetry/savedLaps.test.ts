import { describe, expect, it } from 'vitest'
import { CHANNELS, GRID_M, LapRecorder, LapTrace } from './lapRecorder'
import { buildSavePayload, compareStretches, cornerStretches, decodeTrace, encodeTrace } from './savedLaps'
import type { Track } from './store'
import type { CarTick, LapTick, Meta } from './types'

const TRACK_M = 3000

const meta = (uid: string | null = '123'): Meta => ({
  type: 'meta',
  build: null,
  udp: { ip: null, port: 20777 },
  warning: null,
  sessionUid: uid,
  gameVersion: '1.18',
  session: {
    weather: 1, trackTemp: 35, airTemp: 25, totalLaps: 5, trackLength: TRACK_M, sessionType: 18, trackId: 4, formula: 2,
    sector2Start: 1000, sector3Start: 2000,
  },
  player: { name: 'LUKÁŠ', teamId: 163, raceNumber: 63, nationality: 1, aiControlled: false },
})

function lapTick(over: Partial<LapTick>): LapTick {
  return {
    last_lap_ms: 0, current_lap_ms: 0, sector1_ms: 0, sector1_min: 0, sector2_ms: 0, sector2_min: 0, lap_distance: 0,
    position: 1, lap_num: 1, pit_status: 0, pit_stops: 0, sector: 0, lap_invalid: 0, penalties_s: 0, warnings: 0,
    corner_cutting_warnings: 0, driver_status: 1, ...over,
  }
}

const carTick = { speed: 200, throttle: 1, steer: 0, brake: 0, clutch: 0, gear: 5, rpm: 1, drs: 0, rev_percent: 0, rev_lights: 0, brake_temps: [], tyre_surface_temps: [], tyre_inner_temps: [], engine_temp: 0, tyre_pressures: [] } as CarTick

function driveLap(recorder: LapRecorder, lap: number, ms: number, previous: number) {
  for (let d = 0; d < TRACK_M; d += 3) {
    recorder.ingest(lapTick({ lap_num: lap, lap_distance: d, current_lap_ms: Math.round((d / TRACK_M) * ms), last_lap_ms: previous }), carTick, TRACK_M)
  }
  recorder.ingest(lapTick({ lap_num: lap + 1, last_lap_ms: ms }), carTick, TRACK_M)
}

/** A lap that takes a given time over each stretch of equal length. */
function traceWith(secondsPerStretch: number[], lengthM: number): LapTrace {
  const trace = new LapTrace()
  const part = lengthM / secondsPerStretch.length
  for (let cell = 0; cell * GRID_M <= lengthM; cell++) {
    const m = cell * GRID_M
    const index = Math.min(secondsPerStretch.length - 1, Math.floor(m / part))
    let ms = 0
    for (let i = 0; i < index; i++) ms += secondsPerStretch[i] * 1000
    trace.channels.time[cell] = ms + ((m - index * part) / part) * secondsPerStretch[index] * 1000
  }
  return trace
}

describe('saved trace format', () => {
  it('keeps the channel order the database expects', () => {
    expect(CHANNELS).toEqual(['speed', 'throttle', 'brake', 'gear', 'steer', 'time', 'x', 'z'])
  })

  it('survives a round trip, including places with no data', () => {
    const trace = new LapTrace()
    trace.channels.speed[0] = 123.5
    trace.channels.z[99] = -4.25
    trace.channels.time[50] = 1000
    const back = decodeTrace(encodeTrace(trace, 100), 100, 88000)
    expect(back.at('speed', 0)).toBe(123.5)
    expect(back.at('z', 99)).toBe(-4.25)
    expect(back.at('time', 50)).toBe(1000)
    expect(back.at('speed', 1)).toBeNaN()
    expect(back.at('speed', 500)).toBeNaN()
    expect(back.lapMs).toBe(88000)
  })

  it('handles a full-size lap', () => {
    const trace = new LapTrace()
    trace.channels.time.fill(5)
    const back = decodeTrace(encodeTrace(trace, 5000), 5000, 1)
    expect(back.at('time', 4999)).toBe(5)
  })
})

describe('buildSavePayload', () => {
  it('has nothing to save without a finished lap or a session', () => {
    expect(buildSavePayload(meta(), new LapRecorder(), 'Barcelona', '')).toBeNull()
    const recorder = new LapRecorder()
    driveLap(recorder, 1, 90000, 0)
    expect(buildSavePayload(null, recorder, 'Barcelona', '')).toBeNull()
    expect(buildSavePayload(meta(null), recorder, 'Barcelona', '')).toBeNull()
  })

  it('includes every finished lap with its telemetry', () => {
    const recorder = new LapRecorder()
    driveLap(recorder, 1, 90000, 0)
    driveLap(recorder, 2, 88000, 90000)
    driveLap(recorder, 3, 87000, 88000)
    const payload = buildSavePayload(meta(), recorder, 'Barcelona', 'Test')!
    expect(payload.laps.map((lap) => lap.lap)).toEqual([1, 2, 3])
    expect(payload).toMatchObject({ sessionUid: '123', name: 'Test', trackId: 4, trackName: 'Barcelona', formula: 2, driverName: 'LUKÁŠ', teamId: 163 })
    expect(payload.laps[0].cells).toBe(1501)
    const back = decodeTrace(payload.laps[1].trace, payload.laps[1].cells, payload.laps[1].ms)
    expect(back.at('speed', 100)).toBe(200)
    expect(back.at('time', 750)).toBeCloseTo(44000, -2)
  })

  it('leaves out a lap undone by a flashback', () => {
    const recorder = new LapRecorder()
    driveLap(recorder, 1, 90000, 0)
    driveLap(recorder, 2, 89000, 90000)
    recorder.ingest(lapTick({ lap_num: 2, lap_distance: 2900, current_lap_ms: 88000, last_lap_ms: 90000 }), carTick, TRACK_M)
    const payload = buildSavePayload(meta(), recorder, 'Barcelona', '')!
    expect(payload.laps.map((lap) => lap.lap)).toEqual([1])
    expect(recorder.traces.has(2)).toBe(false)
  })

  it('reset forgets the telemetry too', () => {
    const recorder = new LapRecorder()
    driveLap(recorder, 1, 90000, 0)
    recorder.reset()
    expect(recorder.traces.size).toBe(0)
  })
})

describe('comparing with a saved lap', () => {
  const stretches = [
    { label: '1', fromM: 0, toM: 1000 },
    { label: '2', fromM: 1000, toM: 2000 },
    { label: '3', fromM: 2000, toM: 3000 },
  ]

  it('finds where time was gained and lost', () => {
    const current = traceWith([30, 28, 31], 3000)
    const saved = traceWith([30, 30, 30], 3000)
    const deltas = compareStretches(current, saved, stretches, 3000)
    expect(deltas[0].deltaS).toBeCloseTo(0, 1)
    expect(deltas[1].deltaS).toBeCloseTo(-2, 1)
    expect(deltas[2].deltaS).toBeCloseTo(1, 1)
    const total = deltas.reduce((sum, d) => sum + d.deltaS!, 0)
    expect(total).toBeCloseTo(-1, 1)
  })

  it('reports a stretch the current lap has not reached as unknown', () => {
    const current = traceWith([30, 28, 31], 3000)
    current.clearAfter(600)
    const deltas = compareStretches(current, traceWith([30, 30, 30], 3000), stretches, 3000)
    expect(deltas[0].deltaS).not.toBeNull()
    expect(deltas[2].deltaS).toBeNull()
  })

  it('times the first and last stretch even with no sample right at the line', () => {
    const lap = (seconds: number[]) => {
      const trace = traceWith(seconds, 3000)
      trace.lapMs = seconds.reduce((sum, value) => sum + value, 0) * 1000
      // The first sample landed 8 m past the line, and the last 10 m before it.
      trace.channels.time.fill(NaN, 0, 4)
      trace.channels.time.fill(NaN, 1495)
      return trace
    }
    const deltas = compareStretches(lap([29, 30, 32]), lap([30, 30, 30]), stretches, 3000)
    expect(deltas[0].deltaS).toBeCloseTo(-1, 1)
    expect(deltas[2].deltaS).toBeCloseTo(2, 1)
  })

  it('splits a lap halfway between corners, in driving order', () => {
    const track = {
      corners: [
        { label: '2', fraction: 0.6, labelDir: [1, 0] },
        { label: '1', fraction: 0.2, labelDir: [1, 0] },
      ],
    } as unknown as Track
    expect(cornerStretches(track, 1000, (f) => f * 1000)).toEqual([
      { label: '1', fromM: 0, toM: 400 },
      { label: '2', fromM: 400, toM: 1000 },
    ])
  })

  it('has no stretches on a layout without numbered corners', () => {
    expect(cornerStretches({ corners: [] } as unknown as Track, 1000, (f) => f)).toEqual([])
  })
})
