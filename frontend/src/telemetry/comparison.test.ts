import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { locale, t } from '../i18n'
import tracksData from '../data/tracks.json'
import { defaultAlignment, fitAlignment, toGame, toReference, type Alignment } from './alignment'
import {
  DEFAULT_ENVELOPE, analyzeLap, brakingDistance, buildZones, drivingPoints, fitBrakeEnvelope, referenceView, type Chip,
} from './analysis'
import { GRID_M, LapTrace } from './lapRecorder'
import { buildReferenceLap, curvature, type RefDriver, type RefIndex, type RefLapFile } from './reference'
import type { Track } from './store'
import { CueEngine, brakeTarget, buildCues, type Cue } from './voiceCues'

// Verdicts are checked as a Slovak driver reads them.
locale.value = 'sk'
const chipText = (chip: Chip) => t(chip.key, chip.params)

const REF_DIR = new URL('../../public/reference/', import.meta.url)
const index = JSON.parse(readFileSync(new URL('index.json', REF_DIR), 'utf-8')) as RefIndex
const tracks = tracksData as unknown as Track[]

function loadLap(trackId: number, code: string) {
  const driver = index.tracks[trackId].find((d: RefDriver) => d.code === code)!
  const file = JSON.parse(readFileSync(new URL(`${trackId}/${code}.json`, REF_DIR), 'utf-8')) as RefLapFile
  return buildReferenceLap(file, driver)
}

const barcelona = tracks.find((t) => t.id === 4)!
const piastri = loadLap(4, 'PIA')
const zones = buildZones(barcelona, piastri)
const refPoints = zones.map((zone) => drivingPoints(referenceView(piastri), zone))
const pointsOf = (label: string) => refPoints[zones.findIndex((z) => z.label === label)]!

describe('reference data', () => {
  it('has a lap for every circuit, fastest first, matching known 2025 poles', () => {
    expect(index.tracks['4'][0]).toMatchObject({ code: 'PIA', lapMs: 71546 })
    expect(index.tracks['0'][0]).toMatchObject({ code: 'NOR', lapMs: 75096 })
    expect(index.tracks['11'][0]).toMatchObject({ code: 'VER', lapMs: 78792 })
    expect(index.tracks['10'][0]).toMatchObject({ code: 'NOR', lapMs: 100562 })
    expect(Object.keys(index.tracks)).toHaveLength(24)
    for (const laps of Object.values(index.tracks)) {
      expect(laps.length).toBeGreaterThanOrEqual(19)
      const times = laps.map((d) => d.lapMs)
      expect(times).toEqual([...times].sort((a, b) => a - b))
    }
  })

  it('resamples a lap to the 2 m grid', () => {
    expect(piastri.lengthM).toBeCloseTo(4645, 0)
    expect(piastri.at('time', 0)).toBeLessThan(50)
    expect(piastri.at('time', piastri.lengthM - 1)).toBeGreaterThan(71400)
    expect(piastri.at('speed', 10)).toBeGreaterThan(280)
    expect(piastri.at('throttle', 10)).toBeLessThanOrEqual(1)
  })

  it('continues time past the line in both directions', () => {
    expect(piastri.timeAt(piastri.lengthM + 10)).toBeCloseTo(71546 + piastri.at('time', 10), 0)
    expect(piastri.timeAt(-10)).toBeLessThan(0)
  })
})

describe('real lap against the skill\'s Barcelona baseline', () => {
  // Skill table: Piastri Q 2025, positions in metres from the line, ±10 m sampling.
  const BASELINE: [string, number, number, number][] = [
    ['1', 822, 738, 162],
    ['4', 1692, 1600, 167],
    ['5', 2102, 2008, 107],
    ['7', 2534, 2458, 165],
    ['10', 3464, 3346, 119],
  ]

  it.each(BASELINE)('T%s: apex, brake point and minimum speed', (label, apex, brake, minSpeed) => {
    const zone = zones.find((z) => z.label === label)!
    expect(Math.abs(zone.apexM - apex)).toBeLessThanOrEqual(20)
    const points = pointsOf(label)
    expect(Math.abs(points.brakeM! - brake)).toBeLessThanOrEqual(15)
    expect(Math.abs(points.minSpeed - minSpeed)).toBeLessThanOrEqual(5)
  })

  it('sees the corners Piastri takes without braking', () => {
    expect(pointsOf('3').brakeM).toBeNull()
    expect(pointsOf('13').brakeM).toBeNull()
  })

  it('splits the whole lap into stretches', () => {
    expect(zones[0].startM).toBe(0)
    expect(zones[zones.length - 1].endM).toBe(piastri.lengthM)
    for (let i = 1; i < zones.length; i++) expect(zones[i].startM).toBe(zones[i - 1].endM)
  })
})

describe('every circuit', () => {
  it('produces corners with brake and turn points in driving order', () => {
    for (const [id, laps] of Object.entries(index.tracks)) {
      const track = tracks.find((t) => t.id === Number(id))!
      const lap = loadLap(Number(id), laps[0].code)
      const trackZones = buildZones(track, lap)
      expect(trackZones.length).toBe(track.corners.length)
      const points = trackZones.map((zone) => drivingPoints(referenceView(lap), zone))
      expect(points.filter((p) => p?.brakeM !== null).length, track.name).toBeGreaterThanOrEqual(3)
      for (const p of points) {
        if (p?.brakeM != null && p.brakeEndM != null) expect(p.brakeEndM).toBeGreaterThanOrEqual(p.brakeM)
        if (p?.turnInM != null) expect(p.turnInM).toBeLessThanOrEqual(p.minSpeedM + 120)
      }
    }
  })
})

describe('curvature', () => {
  it('recovers the radius of a circle', () => {
    const radius = 100
    const n = Math.round((2 * Math.PI * radius) / 2)
    const xs = Array.from({ length: n }, (_, i) => radius * Math.cos((i / n) * 2 * Math.PI))
    const ys = Array.from({ length: n }, (_, i) => radius * Math.sin((i / n) * 2 * Math.PI))
    const kappa = curvature(xs, ys, 2, true)
    expect(Math.abs(kappa[50])).toBeCloseTo(1 / radius, 2)
  })

  it('stays undefined where a path has no samples', () => {
    const xs = Array.from({ length: 200 }, (_, i) => (i > 50 && i < 150 ? NaN : i * 2))
    const kappa = curvature(xs, new Array(200).fill(0), 2, false)
    expect(kappa[100]).toBeNaN()
    expect(kappa[10]).toBeCloseTo(0, 5)
  })
})

/** A lap of the real outline in game coordinates: moved, turned, maybe mirrored, and with its own line and length. */
function gameLap(opts: { offsetM: number; scale: number; angle: number; mirror: boolean; slow?: number; toM?: number }): LapTrace {
  const trace = new LapTrace()
  const gameLength = piastri.lengthM * opts.scale
  const cos = Math.cos(opts.angle)
  const sin = Math.sin(opts.angle)
  for (let cell = 0; cell * GRID_M < (opts.toM ?? gameLength); cell++) {
    const refM = (cell * GRID_M) / opts.scale + opts.offsetM
    const x = piastri.at('x', refM)
    const y = piastri.at('y', refM)
    const z = opts.mirror ? -y : y
    trace.channels.x[cell] = cos * x - sin * z + 500
    trace.channels.z[cell] = sin * x + cos * z - 300
    trace.channels.speed[cell] = piastri.at('speed', refM) * (opts.slow ?? 1)
    trace.channels.throttle[cell] = piastri.at('throttle', refM)
    trace.channels.brake[cell] = piastri.at('brake', refM)
    trace.channels.time[cell] = piastri.timeAt(refM) * (1 / (opts.slow ?? 1))
  }
  // A finished lap always has its time; a partly driven one doesn't yet.
  if (!opts.toM) trace.lapMs = piastri.driver.lapMs / (opts.slow ?? 1)
  return trace
}

describe('alignment', () => {
  it.each([
    { offsetM: 32, scale: 1, angle: 0.7, mirror: false },
    { offsetM: 32, scale: 1, angle: 2.2, mirror: true },
    { offsetM: -45, scale: 1.006, angle: -1.3, mirror: true },
    { offsetM: 80, scale: 0.995, angle: 3.0, mirror: false },
  ])('finds the line offset and length of a full lap: %o', (opts) => {
    const fit = fitAlignment(gameLap(opts), piastri.lengthM * opts.scale, piastri)!
    expect(fit.fitted).toBe(true)
    expect(fit.rmsM).toBeLessThan(5)
    // Check the outcome that matters: game distance lands on the right real place.
    for (const gameM of [300, 1500, 3000, 4400]) {
      const truth = gameM / opts.scale + opts.offsetM
      expect(Math.abs(toReference(fit, gameM) - truth), `at ${gameM} m`).toBeLessThan(5)
    }
  })

  it('works from part of a lap', () => {
    const opts = { offsetM: 32, scale: 1, angle: 0.7, mirror: true, toM: 2300 }
    const fit = fitAlignment(gameLap(opts), piastri.lengthM, piastri)!
    expect(Math.abs(toReference(fit, 1500) - 1532)).toBeLessThan(8)
  })

  it('refuses too little of a lap', () => {
    const opts = { offsetM: 0, scale: 1, angle: 0, mirror: false, toM: 800 }
    expect(fitAlignment(gameLap(opts), piastri.lengthM, piastri)).toBeNull()
  })

  it('refuses a lap of a different circuit', () => {
    const monza = loadLap(11, 'VER')
    const trace = new LapTrace()
    for (let cell = 0; cell * GRID_M < piastri.lengthM; cell++) {
      trace.channels.x[cell] = monza.at('x', cell * GRID_M)
      trace.channels.z[cell] = monza.at('y', cell * GRID_M)
    }
    expect(fitAlignment(trace, piastri.lengthM, piastri)).toBeNull()
  })

  it('round-trips between game and reference distance', () => {
    const alignment: Alignment = { a: 1.01, b: 30, rmsM: 1, fitted: true }
    expect(toGame(alignment, toReference(alignment, 1234))).toBeCloseTo(1234)
    expect(defaultAlignment(4000, 4040).a).toBeCloseTo(1.01)
  })
})

describe('braking limit', () => {
  it('computes the distance a car needs', () => {
    const constant = { a0: 20, c: 0 }
    expect(brakingDistance(200, 100, constant)).toBeCloseTo(((200 / 3.6) ** 2 - (100 / 3.6) ** 2) / 40, -0.5)
    expect(brakingDistance(100, 100, constant)).toBe(0)
  })

  it('recovers a known limit from a lap', () => {
    const trace = new LapTrace()
    // Repeated stops from 300 km/h at exactly the skill's F2 limit.
    let cell = 0
    let t = 0
    for (let stop = 0; stop < 4; stop++) {
      let v = 300 / 3.6
      while (v > 60 / 3.6) {
        trace.channels.speed[cell] = v * 3.6
        trace.channels.brake[cell] = 1
        trace.channels.time[cell] = t
        const a = DEFAULT_ENVELOPE.a0 + DEFAULT_ENVELOPE.c * v * v
        const dt = GRID_M / v
        v -= a * dt
        t += dt * 1000
        cell++
      }
      for (let i = 0; i < 20; i++) {
        trace.channels.speed[cell] = 300
        trace.channels.brake[cell] = 0
        trace.channels.time[cell] = (t += 20)
        cell++
      }
    }
    const fit = fitBrakeEnvelope([trace])
    expect(fit.a0).toBeGreaterThan(19)
    expect(fit.a0).toBeLessThan(25)
  })

  it('falls back to the baseline without enough braking', () => {
    expect(fitBrakeEnvelope([new LapTrace()])).toEqual(DEFAULT_ENVELOPE)
  })
})

describe('lap analysis', () => {
  const alignment: Alignment = { a: 1, b: 0, rmsM: 1, fitted: true }

  it('shows no loss for a copy of the real lap, and rates it fine', () => {
    const trace = gameLap({ offsetM: 0, scale: 1, angle: 0, mirror: false })
    const analysis = analyzeLap(trace, 1, piastri.lengthM, piastri, zones, refPoints, alignment, DEFAULT_ENVELOPE)
    for (const corner of analysis.corners) {
      expect(corner.lossS).not.toBeNull()
      expect(Math.abs(corner.lossS!)).toBeLessThan(0.1)
    }
    const t1 = analysis.corners[0]
    expect(t1.chips.some((chip) => chipText(chip).startsWith('Skoro zatáčaš') || chipText(chip).startsWith('Neskoro'))).toBe(false)
  })

  it('finds the corner where time is lost beyond the lap\'s average', () => {
    const trace = gameLap({ offsetM: 0, scale: 1, angle: 0, mirror: false, slow: 0.8 })
    // Lose 2 s extra after T4's stretch began.
    const t4 = zones.find((z) => z.label === '4')!
    const fromCell = Math.floor(t4.apexM / GRID_M)
    for (let cell = fromCell; cell * GRID_M < piastri.lengthM; cell++) trace.channels.time[cell] += 2000
    trace.lapMs += 2000
    const analysis = analyzeLap(trace, 3, piastri.lengthM, piastri, zones, refPoints, alignment, DEFAULT_ENVELOPE)
    expect(analysis.worst[0].label).toBe('4')
    expect(analysis.worst[0].excessS!).toBeGreaterThan(1.5)
    const sum = analysis.corners.reduce((total, corner) => total + corner.lossS!, 0)
    expect(sum).toBeCloseTo((piastri.driver.lapMs / 0.8 + 2000 - piastri.driver.lapMs) / 1000, 0)
  })

  it('counts the first and last corner even with no sample right at the line', () => {
    const trace = gameLap({ offsetM: 0, scale: 1, angle: 0, mirror: false, slow: 0.8 })
    trace.lapMs = piastri.driver.lapMs / 0.8
    trace.channels.time.fill(NaN, 0, 4)
    trace.channels.time.fill(NaN, Math.floor((piastri.lengthM - 10) / GRID_M))
    const analysis = analyzeLap(trace, 1, piastri.lengthM, piastri, zones, refPoints, alignment, DEFAULT_ENVELOPE)
    expect(analysis.corners[0].lossS).not.toBeNull()
    expect(analysis.corners[analysis.corners.length - 1].lossS).not.toBeNull()
    const sum = analysis.corners.reduce((total, corner) => total + corner.lossS!, 0)
    expect(sum).toBeCloseTo((trace.lapMs - piastri.driver.lapMs) / 1000, 0)
  })

  it('gives no verdicts for corners the lap didn\'t reach', () => {
    const trace = gameLap({ offsetM: 0, scale: 1, angle: 0, mirror: false, toM: 1000 })
    const analysis = analyzeLap(trace, 1, piastri.lengthM, piastri, zones, refPoints, alignment, DEFAULT_ENVELOPE)
    const last = analysis.corners[analysis.corners.length - 1]
    expect(last.lossS).toBeNull()
    expect(last.chips).toEqual([])
    expect(analysis.worst.every((corner) => corner.lossS !== null)).toBe(true)
  })

  it('applies the skill\'s braking verdicts', () => {
    const trace = gameLap({ offsetM: 0, scale: 1, angle: 0, mirror: false, slow: 0.8 })
    // Brake 60 m earlier than the driver into T1, at low pressure.
    const brakeM = pointsOf('1').brakeM!
    for (let m = brakeM - 60; m < brakeM; m += GRID_M) trace.channels.brake[Math.floor(m / GRID_M)] = 0.5
    for (let m = brakeM; m < pointsOf('1').brakeEndM!; m += GRID_M) trace.channels.brake[Math.floor(m / GRID_M)] = 0.5
    const analysis = analyzeLap(trace, 1, piastri.lengthM, piastri, zones, refPoints, alignment, DEFAULT_ENVELOPE)
    const t1 = analysis.corners[0]
    expect(t1.own!.brakeM).toBeCloseTo(brakeM - 60, -1)
    expect(t1.chips.map(chipText).join()).toContain('Tlak len 50 %')
  })
})

describe('cues', () => {
  const alignment: Alignment = { a: 1, b: 0, rmsM: 1, fitted: true }
  const input = {
    zones,
    refPoints,
    corners: null,
    envelope: DEFAULT_ENVELOPE,
    alignment,
    gameLengthM: piastri.lengthM,
  }

  it('places brake cues at the real driver\'s points in driver mode', () => {
    const cues = buildCues({ ...input, mode: 'driver' })
    const t1 = cues.find((cue) => cue.corner === '1' && cue.kind === 'brake')!
    expect(t1.atM).toBeCloseTo(pointsOf('1').brakeM!)
    expect(cues.every((cue, i) => i === 0 || cue.atM >= cues[i - 1].atM)).toBe(true)
    expect(new Set(cues.map((cue) => cue.kind))).toEqual(new Set(['brake', 'turn', 'throttle']))
  })

  it('places them earlier for a car that needs more distance', () => {
    const driver = buildCues({ ...input, mode: 'driver' }).find((cue) => cue.corner === '1' && cue.kind === 'brake')!
    const car = buildCues({ ...input, mode: 'car' }).find((cue) => cue.corner === '1' && cue.kind === 'brake')!
    expect(car.atM).toBeLessThan(driver.atM)
  })

  it('adds no brake cue where the driver doesn\'t brake', () => {
    const cues = buildCues({ ...input, mode: 'driver' })
    expect(cues.some((cue) => cue.corner === '3' && cue.kind === 'brake')).toBe(false)
  })

  it('moves cues into the game\'s lap distance', () => {
    const shifted: Alignment = { a: 1, b: 32, rmsM: 1, fitted: true }
    const cues = buildCues({ ...input, alignment: shifted, mode: 'driver' })
    const t1 = cues.find((cue) => cue.corner === '1' && cue.kind === 'brake')!
    expect(t1.atM).toBeCloseTo(pointsOf('1').brakeM! - 32)
  })

  it('never targets a brake point later than the driver\'s or the player\'s limit', () => {
    const ref = pointsOf('1')
    const own = { ...ref, brakeM: ref.brakeM! - 50 }
    expect(brakeTarget(ref, own, 20, DEFAULT_ENVELOPE)).toBe(ref.brakeM! - 30)
    expect(brakeTarget(ref, own, 200, DEFAULT_ENVELOPE)).toBe(ref.brakeM)
    expect(brakeTarget(ref, own, -10, DEFAULT_ENVELOPE)).toBe(own.brakeM)
  })
})

describe('CueEngine', () => {
  const LENGTH = 5000
  const cue = (kind: Cue['kind'], atM: number, corner = '1'): Cue => ({ kind, atM, corner })

  /** Drives at a constant speed and lists what fires where. */
  function drive(engine: CueEngine, fromM: number, toM: number, kmh = 180, hz = 30) {
    const fired: { cue: Cue; atDistance: number; nowMs: number }[] = []
    const stepM = kmh / 3.6 / hz
    let nowMs = 0
    for (let distance = fromM; distance < toM; distance += stepM) {
      nowMs += 1000 / hz
      const hit = engine.update({ distanceM: distance % LENGTH, speedKmh: kmh, nowMs })
      if (hit) fired.push({ cue: hit, atDistance: distance, nowMs })
    }
    return fired
  }

  it('fires the lead time before the point', () => {
    const engine = new CueEngine(1.2)
    engine.setCues([cue('brake', 1000)], LENGTH)
    const fired = drive(engine, 500, 1200)
    expect(fired).toHaveLength(1)
    expect(1000 - fired[0].atDistance).toBeCloseTo(1.2 * 50, -1)
  })

  it('honours a changed lead time', () => {
    const engine = new CueEngine(2)
    engine.setCues([cue('brake', 1000)], LENGTH)
    expect(1000 - drive(engine, 500, 1200)[0].atDistance).toBeCloseTo(100, -1)
  })

  it('fires once per lap, every lap', () => {
    const engine = new CueEngine()
    engine.setCues([cue('turn', 1000)], LENGTH)
    expect(drive(engine, 0, LENGTH * 3)).toHaveLength(3)
  })

  it('handles a cue just after the line', () => {
    const engine = new CueEngine(1.2)
    engine.setCues([cue('brake', 20)], LENGTH)
    const fired = drive(engine, 4000, 5100)
    expect(fired).toHaveLength(1)
    expect(fired[0].atDistance).toBeCloseTo(LENGTH + 20 - 60, -1)
  })

  it('fires again after a flashback', () => {
    const engine = new CueEngine()
    engine.setCues([cue('brake', 3000)], LENGTH)
    expect(drive(engine, 2500, 3100)).toHaveLength(1)
    expect(engine.update({ distanceM: 3100, speedKmh: 180, nowMs: 1e6 })).toBeNull()
    // Teleporting far back makes it a cue behind the car, then ahead again.
    expect(drive(engine, 200, 3100).length).toBe(1)
  })

  it('stays quiet when nearly stopped', () => {
    const engine = new CueEngine()
    engine.setCues([cue('brake', 1000)], LENGTH)
    expect(engine.update({ distanceM: 999, speedKmh: 10, nowMs: 0 })).toBeNull()
  })

  it('stays quiet before the first crossing of the line', () => {
    const engine = new CueEngine()
    engine.setCues([cue('brake', 10)], LENGTH)
    expect(engine.update({ distanceM: -20, speedKmh: 200, nowMs: 0 })).toBeNull()
  })

  it('drops a cue that would talk over the last one, unless it is braking', () => {
    const engine = new CueEngine(1)
    engine.setCues([cue('turn', 1000), cue('throttle', 1010, '2'), cue('brake', 1020, '3')], LENGTH)
    const fired = drive(engine, 800, 1100)
    expect(fired.map((f) => f.cue.kind)).toEqual(['turn', 'brake'])
  })

  it('keeps brake-then-turn when they are only 0.6 s apart', () => {
    const engine = new CueEngine(1.2)
    engine.setCues([cue('brake', 1000), cue('turn', 1030)], LENGTH)
    expect(drive(engine, 800, 1100).map((f) => f.cue.kind)).toEqual(['brake', 'turn'])
  })

  it('does not repeat a cue when the list is rebuilt just after it fired', () => {
    const engine = new CueEngine(1.2)
    engine.setCues([cue('brake', 1000)], LENGTH)
    expect(engine.update({ distanceM: 950, speedKmh: 180, nowMs: 1000 })?.kind).toBe('brake')
    // The alignment improves and the same point moves a little further on.
    engine.setCues([cue('brake', 1020)], LENGTH)
    expect(engine.update({ distanceM: 955, speedKmh: 180, nowMs: 3000 })).toBeNull()
    expect(engine.update({ distanceM: 1010, speedKmh: 180, nowMs: 4000 })).toBeNull()
    // It is live again on the next lap.
    expect(drive(engine, 1500, LENGTH + 1100)).toHaveLength(1)
  })

  it('still fires a rebuilt cue that is further away than the lead', () => {
    const engine = new CueEngine(1.2)
    engine.update({ distanceM: 500, speedKmh: 180, nowMs: 0 })
    engine.setCues([cue('brake', 1000)], LENGTH)
    expect(drive(engine, 500, 1100)).toHaveLength(1)
  })

  it('plays the brake cue when it falls due together with an earlier one', () => {
    const engine = new CueEngine(1.2)
    engine.setCues([cue('throttle', 1090), cue('brake', 1150, '2')], LENGTH)
    // A dropout: the car reappears with both points inside the lead time.
    expect(engine.update({ distanceM: 1085, speedKmh: 200, nowMs: 0 })?.kind).toBe('brake')
  })

  it('plays the cue the car reaches first when they fall due across the line', () => {
    const engine = new CueEngine(1.2)
    engine.setCues([cue('turn', 20), cue('throttle', 4990, '9')], LENGTH)
    expect(engine.update({ distanceM: 4970, speedKmh: 200, nowMs: 0 })?.corner).toBe('9')
  })

  it('reports the next cue ahead, past the line too', () => {
    const engine = new CueEngine()
    engine.setCues([cue('brake', 100), cue('turn', 4000)], LENGTH)
    expect(engine.next(50)).toMatchObject({ cue: { kind: 'brake' }, inM: 50 })
    expect(engine.next(4500)).toMatchObject({ cue: { kind: 'brake' }, inM: 600 })
  })
})
