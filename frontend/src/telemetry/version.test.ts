import { describe, expect, it } from 'vitest'
import { isOutdated, ownBuild } from './version'

describe('build check', () => {
  it('reads the page\'s own script name', () => {
    expect(ownBuild('http://127.0.0.1:8000/assets/index-Dj6abM-E.js')).toBe('index-Dj6abM-E.js')
    expect(ownBuild('http://localhost:5173/src/main.ts')).toBeNull()
  })

  it('reloads only a built page that differs from the server\'s build', () => {
    expect(isOutdated('index-old.js', 'index-new.js')).toBe(true)
    expect(isOutdated('index-new.js', 'index-new.js')).toBe(false)
    expect(isOutdated(null, 'index-new.js')).toBe(false)
    expect(isOutdated('index-old.js', null)).toBe(false)
  })
})
