import { describe, expect, it } from 'vitest'
import { formatClock, formatDelta, formatLapTime, formatSector } from './format'

describe('format', () => {
  it('formats lap times', () => {
    expect(formatLapTime(89496)).toBe('1:29.496')
    expect(formatLapTime(61005)).toBe('1:01.005')
    expect(formatLapTime(59999)).toBe('0:59.999')
    expect(formatLapTime(0)).toBe('—')
    expect(formatLapTime(null)).toBe('—')
  })

  it('formats sectors', () => {
    expect(formatSector(28456)).toBe('28.456')
    expect(formatSector(61000)).toBe('1:01.000')
    expect(formatSector(null)).toBe('—')
  })

  it('formats deltas with a real minus sign', () => {
    expect(formatDelta(0.25)).toBe('+0.250')
    expect(formatDelta(-1.5)).toBe('−1.500')
    expect(formatDelta(0)).toBe('±0.000')
    expect(formatDelta(null)).toBe('—')
  })

  it('formats clock time', () => {
    expect(formatClock(125)).toBe('2:05')
    expect(formatClock(-3)).toBe('0:00')
  })
})
