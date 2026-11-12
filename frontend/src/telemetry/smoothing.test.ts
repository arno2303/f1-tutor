import { describe, expect, it } from 'vitest'
import { DistanceSmoother } from './smoothing'

const KMH = 180 // 50 m/s
const FRAME_MS = 1000 / 60

/** Plays updates at a rate, with optional arrival jitter, and lists the on-screen steps. */
function run(rateHz: number, jitterMs = 0, seconds = 4) {
  const smoother = new DistanceSmoother()
  const updates: { at: number; distance: number }[] = []
  for (let i = 0; i < seconds * rateHz; i++) {
    const trueAt = (i * 1000) / rateHz
    updates.push({ at: trueAt + ((i * 7919) % 100) / 100 * jitterMs, distance: 1000 + (50 * trueAt) / 1000 })
  }
  const steps: number[] = []
  let previous: number | null = null
  let next = 0
  for (let now = 0; now < seconds * 1000; now += FRAME_MS) {
    while (next < updates.length && updates[next].at <= now) {
      smoother.sample(updates[next].distance, KMH, updates[next].at)
      next++
    }
    const value = smoother.value(now)
    if (value !== null) {
      if (previous !== null) steps.push(value - previous)
      previous = value
    }
  }
  return steps.slice(30)
}

describe('DistanceSmoother', () => {
  it.each([60, 30, 20, 10])('never moves backwards and moves evenly at %i Hz', (rate) => {
    const steps = run(rate)
    expect(Math.min(...steps)).toBeGreaterThanOrEqual(0)
    const ideal = (50 * FRAME_MS) / 1000
    const average = steps.reduce((sum, step) => sum + step, 0) / steps.length
    expect(average).toBeCloseTo(ideal, 1)
    expect(Math.max(...steps)).toBeLessThan(ideal * 3)
  })

  it('stays even when Wi-Fi delays updates unevenly', () => {
    const steps = run(60, 25)
    expect(Math.min(...steps)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...steps)).toBeLessThan(3)
  })

  it('keeps moving through a short gap, then stops predicting', () => {
    const smoother = new DistanceSmoother()
    smoother.sample(1000, KMH, 0)
    smoother.value(0)
    expect(smoother.value(100)).toBeGreaterThan(1000)
    const atLimit = smoother.value(250)!
    expect(atLimit).toBeLessThanOrEqual(1012.5)
    for (let t = 300; t < 2000; t += 50) smoother.value(t)
    expect(smoother.value(2000)).toBeLessThanOrEqual(1012.5)
  })

  it('jumps straight to a new position for a new lap or a flashback', () => {
    const smoother = new DistanceSmoother()
    smoother.sample(4600, KMH, 0)
    smoother.value(0)
    smoother.sample(2, KMH, 16)
    expect(smoother.value(16)).toBeLessThan(10)
    smoother.sample(3000, KMH, 32)
    smoother.value(32)
    smoother.sample(2000, KMH, 48)
    expect(smoother.value(48)).toBeLessThan(2010)
  })

  it('has nothing to show before the first update', () => {
    expect(new DistanceSmoother().value(100)).toBeNull()
  })
})
