import { locale, t } from '../i18n'
import type { CueKind } from './voiceCues'

// Your own recordings, if they're in the `voice` folder. A cue without one is spoken
// by the browser's speech voice in the UI language instead.
const FILES: Record<CueKind, string> = {
  brake: '/voice/Brzda.m4a',
  turn: '/voice/Zaboc.m4a',
  throttle: '/voice/Plyn.m4a',
}

// The recordings differ in loudness and start with up to 0.4 s of silence, which
// at racing speed would put a cue 30 m late. Both are evened out when played.
const ONSET_THRESHOLD = 0.1
const ONSET_MARGIN_S = 0.02
const TARGET_PEAK = 0.9

interface Clip {
  buffer: AudioBuffer
  offsetS: number
  gain: number
}

/** Finds where the speech starts and how much to raise it, from the decoded audio. */
export function measureClip(samples: Float32Array, sampleRate: number): { offsetS: number; gain: number } {
  let peak = 0
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample))
  if (peak === 0) return { offsetS: 0, gain: 1 }
  let first = 0
  while (first < samples.length && Math.abs(samples[first]) < peak * ONSET_THRESHOLD) first++
  return { offsetS: Math.max(0, first / sampleRate - ONSET_MARGIN_S), gain: TARGET_PEAK / peak }
}

export class VoicePlayer {
  private context: AudioContext | null = null
  private clips = new Map<CueKind, Clip>()
  private playing: AudioBufferSourceNode | null = null
  private loaded = false

  /** Must be called from a click, because browsers block audio until the user acts. */
  async enable(): Promise<void> {
    this.context ??= new AudioContext()
    await this.context.resume()
    if (!this.loaded) {
      const context = this.context
      await Promise.all((Object.keys(FILES) as CueKind[]).map((kind) => this.load(context, kind)))
      this.loaded = true
    }
    if (this.clips.size < 3 && !speechAvailable()) throw new Error('No recordings and no speech voice')
  }

  play(kind: CueKind): void {
    const clip = this.clips.get(kind)
    if (!clip) {
      speak(t(`cue.${kind}`))
      return
    }
    if (!this.context) return
    this.playing?.stop()
    const source = this.context.createBufferSource()
    const gain = this.context.createGain()
    source.buffer = clip.buffer
    gain.gain.value = clip.gain
    source.connect(gain).connect(this.context.destination)
    source.start(0, clip.offsetS)
    this.playing = source
  }

  private async load(context: AudioContext, kind: CueKind): Promise<void> {
    try {
      const response = await fetch(FILES[kind])
      if (!response.ok) return
      const buffer = await context.decodeAudioData(await response.arrayBuffer())
      this.clips.set(kind, { buffer, ...measureClip(buffer.getChannelData(0), buffer.sampleRate) })
    } catch {
      // A missing or unreadable recording falls back to the speech voice.
    }
  }
}

function speechAvailable(): boolean {
  return typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined'
}

const SPEECH_LANG = { en: 'en-GB', sk: 'sk-SK' } as const

function speak(text: string): void {
  if (!speechAvailable()) return
  const lang = SPEECH_LANG[locale.value]
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = lang
  // Without a voice for the language the browser would read the word with the wrong accent.
  const prefix = lang.slice(0, 2)
  const voice = speechSynthesis.getVoices().find((candidate) => candidate.lang.toLowerCase().startsWith(prefix))
  if (voice) utterance.voice = voice
  // A cue is one word that has to land before the corner, so it's said quickly and replaces the last one.
  utterance.rate = 1.3
  speechSynthesis.cancel()
  speechSynthesis.speak(utterance)
}
