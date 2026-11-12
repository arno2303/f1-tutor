import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { locale, t } from '../i18n'
import tracksData from '../data/tracks.json'
import { fitAlignment, type Alignment } from './alignment'
import { buildZones, type Chip } from './analysis'
import { GRID_M, LapTrace } from './lapRecorder'
import { gapAt, gapTrend, ownLapChips, ownSide, realSide, studyRows, studyZones } from './lapStudy'
import { buildReferenceLap, type RefIndex, type RefLapFile } from './reference'
import type { Track } from './store'

// Verdicts are checked as a Slovak driver reads them.
locale.value = 'sk'
const chipText = (chip: Chip) => t(chip.key, chip.params)

const REF_DIR = new URL('../../public/reference/', import.meta.url)
const index = JSON.parse(readFileSync(new URL('index.json', REF_DIR), 'utf-8')) as RefIndex
const driver = index.tracks['4'][0]
const piastri = buildReferenceLap(JSON.parse(readFileSync(new URL('4/PIA.json', REF_DIR), 'utf-8')) as RefLapFile, driver)
const barcelona = (tracksData as unknown as Track[]).find((t) => t.id === 4)!
const LENGTH = Math.round(piastri.lengthM)

/**
 * A lap of the real line in game coordinates, with the game's line 32 m on
 * from the real one. `slow` scales the pace; `brakeEarlierM` moves T1's braking.
 */
function gameLap(slow = 1, extraMsAfter: [number, number] | null = null, brakeEarlierM = 0): LapTrace {
  const trace = new LapTrace()
  const t1Brake = 738
  for (let cell = 0; cell * GRID_M <= LENGTH; cell++) {
    const refM = cell * GRID_M + 32
    trace.channels.x[cell] = piastri.at('x', refM)
    trace.channels.z[cell] = -piastri.at('y', refM)
    trace.channels.speed[cell] = piastri.at('speed', refM) * slow
    trace.channels.throttle[cell] = piastri.at('throttle', refM)
    trace.channels.brake[cell] =
      brakeEarlierM && refM >= t1Brake - brakeEarlierM && refM < t1Brake ? 1 : piastri.at('brake', refM)
    trace.channels.steer[cell] = 0
    let ms = (piastri.timeAt(refM) - piastri.timeAt(32)) / slow
    if (extraMsAfter && refM > extraMsAfter[0]) ms += extraMsAfter[1]
    trace.channels.time[cell] = ms
  }
  trace.lapMs = piastri.driver.lapMs / slow + (extraMsAfter?.[1] ?? 0)
  return trace
}

describe('one lap against another of the player\'s', () => {
  it('shows no difference for the same lap', () => {
    const lap = gameLap()
    const a = ownSide(lap, LENGTH, 'A')
    const zones = studyZones(barcelona, LENGTH, a.view)
    const rows = studyRows(a, ownSide(lap, LENGTH, 'B'), zones)
    expect(rows).toHaveLength(barcelona.corners.length)
    for (const row of rows) {
      expect(row.deltaS).toBeCloseTo(0, 5)
      expect(row.chips.map(chipText)).toEqual(['Rovnaký nájazd'])
    }
  })

  it('puts lost time in the corner where it happened, and the stretches add up to the lap', () => {
    const a = ownSide(gameLap(1, [1650, 700]), LENGTH, 'A')
    const b = ownSide(gameLap(), LENGTH, 'B')
    const rows = studyRows(a, b, studyZones(barcelona, LENGTH, a.view))
    const worst = rows.reduce((x, y) => (y.deltaS! > x.deltaS! ? y : x))
    expect(worst.label).toBe('4')
    expect(worst.deltaS).toBeCloseTo(0.7, 2)
    expect(rows.reduce((sum, row) => sum + row.deltaS!, 0)).toBeCloseTo(0.7, 2)
    expect(gapAt(a, b, LENGTH)).toBeCloseTo(0.7, 2)
  })

  it('finds an earlier braking point', () => {
    const a = ownSide(gameLap(1, null, 40), LENGTH, 'A')
    const rows = studyRows(a, ownSide(gameLap(), LENGTH, 'B'), studyZones(barcelona, LENGTH, a.view))
    const t1 = rows.find((row) => row.label === '1')!
    expect(t1.brakeDeltaM).toBeCloseTo(-40, -1)
    expect(chipText(t1.chips[0])).toBe('Brzdíš o 40 m skôr')
  })

  it('places corners near their peak curvature without a real lap', () => {
    const a = ownSide(gameLap(), LENGTH, 'A')
    const zones = studyZones(barcelona, LENGTH, a.view)
    // Skill baseline: T1 apex at 822 m on the real lap, here 32 m earlier.
    expect(Math.abs(zones.find((z) => z.label === '1')!.apexM - 790)).toBeLessThan(40)
    expect(zones[0].startM).toBe(0)
    expect(zones[zones.length - 1].endM).toBe(LENGTH)
  })
})

describe('a lap against a real driver', () => {
  const lap = gameLap(0.85)
  const alignment = fitAlignment(lap, LENGTH, piastri)!

  it('lines up the real lap with the game\'s line', () => {
    expect(alignment.b).toBeCloseTo(32, -1)
  })

  it('starts both clocks together and ends with the lap gap', () => {
    const a = ownSide(lap, LENGTH, 'A')
    const b = realSide(piastri, alignment, 'Piastri')
    expect(gapAt(a, b, 0)).toBeCloseTo(0, 1)
    expect(gapAt(a, b, LENGTH - 2)).toBeCloseTo((lap.lapMs - piastri.driver.lapMs) / 1000, 0)
  })

  it('finishes one game lap exactly on the real lap time when given the lap length', () => {
    const b = realSide(piastri, { ...alignment, a: alignment.a * 1.004 }, 'Piastri', LENGTH)
    expect(b.elapsed(LENGTH)).toBeCloseTo(piastri.driver.lapMs, 0)
    expect(b.elapsed(0)).toBeCloseTo(0, 0)
  })

  it('reads the real values at the same place on track', () => {
    const b = realSide(piastri, alignment, 'Piastri')
    expect(b.value('speed', 1000)).toBeCloseTo(piastri.at('speed', 1032), -1)
    expect(b.value('steer', 1000)).toBeNaN()
  })

  it('uses the real corners, moved into the game\'s metres', () => {
    const a = ownSide(lap, LENGTH, 'A')
    const zones = studyZones(barcelona, LENGTH, a.view, { zones: buildZones(barcelona, piastri), alignment })
    const realT1 = buildZones(barcelona, piastri).find((z) => z.label === '1')!
    expect(zones.find((z) => z.label === '1')!.apexM).toBeCloseTo(realT1.apexM - 32, -1)
  })

  it('takes the verdicts it is given', () => {
    const a = ownSide(lap, LENGTH, 'A')
    const b = realSide(piastri, alignment, 'Piastri')
    const zones = studyZones(barcelona, LENGTH, a.view)
    const rows = studyRows(a, b, zones, new Map([['1', [{ key: 'chip.earlyBrake' as const, params: { m: 20 }, level: 'bad' as const }]]]))
    expect(chipText(rows[0].chips[0])).toBe('Skoro brzdíš, rezerva 20 m')
  })
})

describe('gap trend', () => {
  it('says where time is being lost, gained or held', () => {
    const a = ownSide(gameLap(1, [1650, 700]), LENGTH, 'A')
    const b = ownSide(gameLap(), LENGTH, 'B')
    expect(gapTrend(a, b, 1620, LENGTH)).toBe('loss')
    expect(gapTrend(a, b, 3000, LENGTH)).toBe('even')
    expect(gapTrend(b, a, 1620, LENGTH)).toBe('gain')
  })

  it('against a faster lap, shows where the most is lost rather than loss everywhere', () => {
    const slow = ownSide(gameLap(0.8, [1650, 700]), LENGTH, 'A')
    const fast = ownSide(gameLap(), LENGTH, 'B')
    expect(gapTrend(slow, fast, 3000, LENGTH)).toBe('loss')
    expect(gapTrend(slow, fast, 3000, LENGTH, true)).toBe('even')
    expect(gapTrend(slow, fast, 1620, LENGTH, true)).toBe('loss')
  })

  it('ranks the weakest corner by time lost beyond the average', () => {
    const slow = ownSide(gameLap(0.8, [1650, 700]), LENGTH, 'A')
    const rows = studyRows(slow, ownSide(gameLap(), LENGTH, 'B'), studyZones(barcelona, LENGTH, slow.view))
    const weakest = rows.reduce((x, y) => (y.excessS! > x.excessS! ? y : x))
    expect(weakest.label).toBe('4')
    expect(rows.reduce((sum, row) => sum + row.excessS!, 0)).toBeCloseTo(0, 1)
  })
})

describe('notes for two of the player\'s laps', () => {
  const blank = { a: null, b: null, brakeDeltaM: null, minSpeedDeltaKmh: null, turnInDeltaM: null }
  it('ignores differences within the data\'s precision', () => {
    expect(ownLapChips({ ...blank, brakeDeltaM: 6, minSpeedDeltaKmh: 2, turnInDeltaM: -8 })[0].key).toBe('chip.sameEntry')
  })
  it('describes each difference, in English too', () => {
    const texts = ownLapChips({ ...blank, brakeDeltaM: 22, minSpeedDeltaKmh: -7.4, turnInDeltaM: -12 }).map(chipText)
    expect(texts).toEqual(['Brzdíš o 20 m neskôr', 'Min. rýchlosť o 7 km/h nižšia', 'Zatáčaš o 10 m skôr'])
    locale.value = 'en'
    const english = ownLapChips({ ...blank, brakeDeltaM: 22, minSpeedDeltaKmh: -7.4, turnInDeltaM: -12 }).map(chipText)
    expect(english).toEqual(['Braking 20 m later', 'Min. speed 7 km/h lower', 'Turning in 10 m earlier'])
    locale.value = 'sk'
  })
})

it('keeps the alignment type usable as a fixed mapping', () => {
  const fixed: Alignment = { a: 1, b: 0, rmsM: 0, fitted: true }
  expect(realSide(piastri, fixed, 'x').elapsed(0)).toBe(0)
})
