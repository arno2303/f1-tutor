import { afterEach, describe, expect, it, vi } from 'vitest'
import { locale } from '../i18n'
import { measureClip, VoicePlayer } from './voicePlayer'

describe('measureClip', () => {
  const RATE = 48000

  it('skips the silence before the speech and evens out the level', () => {
    const samples = new Float32Array(RATE)
    for (let i = RATE * 0.38; i < RATE * 0.76; i++) samples[Math.floor(i)] = 0.3 * Math.sin(i / 10)
    const { offsetS, gain } = measureClip(samples, RATE)
    expect(offsetS).toBeGreaterThan(0.34)
    expect(offsetS).toBeLessThan(0.38)
    expect(gain).toBeCloseTo(3, 1)
  })

  it('keeps a clip that starts straight away', () => {
    const samples = new Float32Array(1000).fill(0.5)
    expect(measureClip(samples, RATE).offsetS).toBe(0)
  })

  it('leaves silence alone', () => {
    expect(measureClip(new Float32Array(1000), RATE)).toEqual({ offsetS: 0, gain: 1 })
  })
})

class FakeAudioContext {
  destination = {}
  async resume() {}
  async decodeAudioData() {
    return { sampleRate: 48000, getChannelData: () => new Float32Array(100).fill(0.5) }
  }
  createBufferSource() {
    return { buffer: null, connect: (node: unknown) => node, start: vi.fn(), stop: vi.fn() }
  }
  createGain() {
    return { gain: { value: 1 }, connect: (node: unknown) => node }
  }
}

class FakeUtterance {
  lang = ''
  rate = 1
  voice: unknown = null
  constructor(public text: string) {}
}

function stubAudio(recordings: boolean, speech = true) {
  const spoken: FakeUtterance[] = []
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('fetch', async () =>
    recordings ? { ok: true, arrayBuffer: async () => new ArrayBuffer(8) } : { ok: false, status: 404 },
  )
  if (speech) {
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance)
    vi.stubGlobal('speechSynthesis', {
      getVoices: () => [{ lang: 'sk-SK', name: 'Laura' }, { lang: 'en-GB', name: 'Daniel' }],
      cancel: vi.fn(),
      speak: (utterance: FakeUtterance) => spoken.push(utterance),
    })
  }
  return spoken
}

describe('VoicePlayer', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    locale.value = 'en'
  })

  it('speaks the cue in the UI language when there are no recordings', async () => {
    const spoken = stubAudio(false)
    const player = new VoicePlayer()
    await player.enable()
    player.play('brake')
    locale.value = 'sk'
    player.play('turn')
    expect(spoken.map((u) => [u.text, u.lang, (u.voice as { name: string }).name])).toEqual([
      ['Brake', 'en-GB', 'Daniel'],
      ['Zaboč', 'sk-SK', 'Laura'],
    ])
  })

  it('prefers the recordings when they are there', async () => {
    const spoken = stubAudio(true)
    const player = new VoicePlayer()
    await player.enable()
    player.play('throttle')
    expect(spoken).toEqual([])
  })

  it('fails only when there is neither a recording nor a speech voice', async () => {
    stubAudio(false, false)
    await expect(new VoicePlayer().enable()).rejects.toThrow()
  })
})
