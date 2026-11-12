import { describe, expect, it } from 'vitest'
import tracksData from '../data/tracks.json'
import type { Track } from './store'
import { nextCorner, pointAt } from './trackGeometry'

const tracks = tracksData as unknown as Track[]
const square: Track = {
  id: 1, name: 'Štvorec', country: '', lengthM: 400,
  points: [[0, 0], [100, 0], [100, 100], [0, 100]],
  corners: [
    { label: '1', fraction: 0.25, labelDir: [1, 0] },
    { label: '2', fraction: 0.75, labelDir: [1, 0] },
  ],
}

describe('pointAt', () => {
  it('interpolates along the closed outline', () => {
    expect(pointAt(square, 0.125)).toMatchObject({ x: 50, y: 0, dx: 1, dy: 0 })
    expect(pointAt(square, 0.875)).toMatchObject({ x: 0, y: 50, dx: 0, dy: -1 })
  })

  it('wraps fractions outside 0..1', () => {
    expect(pointAt(square, 1.125).x).toBeCloseTo(50)
    expect(pointAt(square, -0.875).x).toBeCloseTo(50)
  })
})

describe('nextCorner', () => {
  it('returns the next corner and the distance to it', () => {
    const next = nextCorner(square, 0.1)!
    expect(next.corner.label).toBe('1')
    expect(next.ahead).toBeCloseTo(0.15)
  })

  it('wraps past the finish line', () => {
    const next = nextCorner(square, 0.9)!
    expect(next.corner.label).toBe('1')
    expect(next.ahead).toBeCloseTo(0.35)
  })

  it('has nothing to report on a layout without numbered corners', () => {
    expect(nextCorner({ ...square, corners: [] }, 0.5)).toBeNull()
  })
})

describe('track data', () => {
  it('covers every track the game can report', () => {
    const ids = tracks.map((track) => track.id).sort((a, b) => a - b)
    expect(ids).toEqual([0, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 19, 20, 26, 27, 29, 30, 31, 32, 39, 40, 41])
  })

  it('has evenly spaced outlines and corners in driving order', () => {
    for (const track of tracks) {
      const n = track.points.length
      expect(Math.abs((n * 8) / track.lengthM - 1)).toBeLessThan(0.01)
      const fractions = track.corners.map((corner) => corner.fraction)
      expect(fractions).toEqual([...fractions].sort((a, b) => a - b))
    }
  })

  it('keeps the same start point on reversed layouts', () => {
    const forward = tracks.find((track) => track.id === 7)!
    const reversed = tracks.find((track) => track.id === 39)!
    expect(reversed.points[0]).toEqual(forward.points[0])
    expect(reversed.points[1]).toEqual(forward.points[forward.points.length - 1])
  })
})
