// Keeps the real driver's lap, the alignment, the analysis and the voice cues in
// step with the game. Cues run from WebSocket messages rather than animation
// frames, so they keep working while the browser window is in the background.

import { computed, ref, shallowRef, watch } from 'vue'
import { t } from '../i18n'
import { defaultAlignment, fitAlignment, type Alignment } from './alignment'
import {
  DEFAULT_ENVELOPE, analyzeLap, buildZones, drivingPoints, fitBrakeEnvelope, referenceView,
  type BrakeEnvelope, type CornerZone, type DrivingPoints, type LapAnalysis,
} from './analysis'
import type { LapTrace } from './lapRecorder'
import { buildReferenceLap, type RefDriver, type RefIndex, type RefLapFile, type ReferenceLap } from './reference'
import {
  alignment, gameTrack, isLive, lapsVersion, meta, recorder, referenceLengthM, shownTrack, tick, type Track,
} from './store'
import { CueEngine, buildCues, type BrakeMode, type Cue } from './voiceCues'
import { VoicePlayer } from './voicePlayer'

const FORMULA_F2 = 2
// While a track has no fitted alignment yet, how often to try during a lap.
const ALIGN_RETRY_MS = 15000
const CUE_FLASH_MS = 800

function readSetting(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeSetting(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Without storage the setting just lasts until the page reloads.
  }
}

/** Real drivers with a lap at a track. */
export function driversAt(trackId: number): RefDriver[] {
  return refIndex.value?.tracks[trackId] ?? []
}

/** The track being compared: the one being driven, otherwise the one being looked at. */
export const comparedTrack = computed<Track | null>(() => (isLive.value ? gameTrack.value : (shownTrack.value ?? gameTrack.value)))

const refIndex = shallowRef<RefIndex | null>(null)
export const referenceYear = computed(() => refIndex.value?.year ?? null)
export const availableDrivers = computed<RefDriver[]>(() => {
  const track = comparedTrack.value
  return (track && refIndex.value?.tracks[track.id]) || []
})

const driverChoice = ref(readSetting('f1tutor.driver'))
/** Falls back to the fastest driver at tracks where the chosen one has no lap. */
export const selectedDriver = computed<RefDriver | null>({
  get: () => availableDrivers.value.find((d) => d.code === driverChoice.value) ?? availableDrivers.value[0] ?? null,
  set: (driver) => {
    driverChoice.value = driver?.code ?? null
    if (driver) writeSetting('f1tutor.driver', driver.code)
  },
})

export const referenceLap = shallowRef<ReferenceLap | null>(null)
export const referenceError = ref(false)
export const zones = shallowRef<CornerZone[]>([])
export const refPoints = shallowRef<(DrivingPoints | null)[]>([])
export const analysis = shallowRef<LapAnalysis | null>(null)
const envelope = shallowRef<BrakeEnvelope>(DEFAULT_ENVELOPE)

const cache = new Map<string, ReferenceLap>()

/** A real driver's lap at a track, downloaded once and kept. */
export async function fetchReferenceLap(trackId: number, driver: RefDriver): Promise<ReferenceLap> {
  const key = `${trackId}/${driver.code}`
  let lap = cache.get(key)
  if (!lap) {
    const response = await fetch(`/reference/${key}.json`)
    if (!response.ok) throw new Error(t('errors.referenceLoad', { status: response.status }))
    lap = buildReferenceLap((await response.json()) as RefLapFile, driver)
    cache.set(key, lap)
  }
  return lap
}

async function loadReference(track: Track | null, driver: RefDriver | null): Promise<void> {
  if (!track || !driver) {
    referenceLap.value = null
    return
  }
  referenceError.value = false
  let lap: ReferenceLap
  try {
    lap = await fetchReferenceLap(track.id, driver)
  } catch {
    if (comparedTrack.value !== track || selectedDriver.value !== driver) return
    referenceError.value = true
    referenceLap.value = null
    return
  }
  // A slow download mustn't overwrite a newer choice.
  if (comparedTrack.value === track && selectedDriver.value === driver) referenceLap.value = lap
}

// Real laps of different drivers differ in length by up to 80 m, so a fit belongs to one driver's lap.
const alignmentKey = (trackId: number, driverCode: string) => `f1tutor.align.${trackId}.${driverCode}`

export function loadStoredAlignment(track: Track, driverCode: string): Alignment | null {
  const stored = readSetting(alignmentKey(track.id, driverCode))
  if (!stored) return null
  try {
    const value = JSON.parse(stored) as Alignment
    return Number.isFinite(value.a) && Number.isFinite(value.b) ? value : null
  } catch {
    return null
  }
}

/** The game's lap length, when the compared track is the one the game reports. */
function gameLength(): number | undefined {
  return comparedTrack.value === gameTrack.value ? meta.value?.session?.trackLength : undefined
}

// One full lap settles it for the session, and the fit is too heavy to repeat each lap.
let alignedFromFullLap: string | null = null

/** Returns whether a fit was found. */
function refitFrom(trace: LapTrace): boolean {
  const ref = referenceLap.value
  const track = comparedTrack.value
  const length = gameLength()
  if (!ref || !track || !length || track !== gameTrack.value) return false
  const fit = fitAlignment(trace, length, ref)
  if (!fit) return false
  alignment.value = fit
  writeSetting(alignmentKey(track.id, ref.driver.code), JSON.stringify(fit))
  return true
}

function refreshAnalysis(): void {
  const ref = referenceLap.value
  const length = gameLength()
  const trace = recorder.last
  const row = recorder.laps[recorder.laps.length - 1]
  if (!ref || !length || !alignment.value || !trace || !row || comparedTrack.value !== gameTrack.value) {
    analysis.value = null
    return
  }
  envelope.value = fitBrakeEnvelope(recorder.best && recorder.best !== trace ? [trace, recorder.best] : [trace])
  analysis.value = analyzeLap(trace, row.lap, length, ref, zones.value, refPoints.value, alignment.value, envelope.value)
}

// ---- Voice

export type VoiceState = 'off' | 'loading' | 'on' | 'error'
export const voiceState = ref<VoiceState>('off')
export const LEAD_OPTIONS = [0.8, 1.0, 1.2, 1.5, 2.0]
export const leadSeconds = ref(Number(readSetting('f1tutor.lead')) || 1.2)
const brakeModeChoice = ref(readSetting('f1tutor.brakeMode') as BrakeMode | null)

/**
 * Real F1 cars brake far later than an F2 car can, so F2 starts from its own limit
 * and the player can switch to the driver's literal points at any time.
 */
export const brakeMode = computed<BrakeMode>({
  get: () => brakeModeChoice.value ?? (meta.value?.session?.formula === FORMULA_F2 ? 'car' : 'driver'),
  set: (mode) => {
    brakeModeChoice.value = mode
    writeSetting('f1tutor.brakeMode', mode)
  },
})

/** The cue just fired, for the on-screen flash, whether or not the voice is on. */
export const activeCue = shallowRef<Cue | null>(null)
export const nextCue = shallowRef<{ cue: Cue; inM: number } | null>(null)

const engine = new CueEngine(leadSeconds.value)
const player = new VoicePlayer()
let flashTimer: ReturnType<typeof setTimeout> | undefined

export async function toggleVoice(): Promise<void> {
  if (voiceState.value === 'on') {
    voiceState.value = 'off'
    return
  }
  voiceState.value = 'loading'
  try {
    await player.enable()
    voiceState.value = 'on'
    player.play('brake')
  } catch {
    voiceState.value = 'error'
  }
}

export function testVoice(kind: Cue['kind']): void {
  if (voiceState.value === 'on') player.play(kind)
}

function rebuildCues(): void {
  const length = gameLength()
  const ref = referenceLap.value
  if (!ref || !length || !alignment.value || comparedTrack.value !== gameTrack.value) {
    engine.setCues([], 1)
    nextCue.value = null
    return
  }
  engine.setCues(
    buildCues({
      zones: zones.value,
      refPoints: refPoints.value,
      corners: analysis.value?.corners ?? null,
      mode: brakeMode.value,
      envelope: envelope.value,
      alignment: alignment.value,
      gameLengthM: length,
    }),
    length,
  )
}

// ---- Wiring

let wired = false
let nextAlignAttemptAt = 0

export function startComparison(): void {
  if (wired) return
  wired = true

  fetch('/reference/index.json')
    .then((response) => {
      if (!response.ok) throw new Error(String(response.status))
      return response.json()
    })
    .then((index: RefIndex) => (refIndex.value = index))
    // Otherwise the coach would claim F1 doesn't race this track.
    .catch(() => (referenceError.value = true))

  watch([comparedTrack, selectedDriver], ([track, driver]) => void loadReference(track, driver), { immediate: true })

  // A new real lap or a different track length means everything is measured afresh.
  watch(
    [referenceLap, gameLength],
    ([ref, length]) => {
      const track = comparedTrack.value
      if (!ref || !track) {
        zones.value = []
        refPoints.value = []
        alignment.value = null
        referenceLengthM.value = null
        analysis.value = null
        rebuildCues()
        return
      }
      const trackZones = buildZones(track, ref)
      zones.value = trackZones
      refPoints.value = trackZones.map((zone) => drivingPoints(referenceView(ref), zone))
      referenceLengthM.value = ref.lengthM
      alignment.value = loadStoredAlignment(track, ref.driver.code) ?? defaultAlignment(length ?? ref.lengthM, ref.lengthM)
      refreshAnalysis()
      rebuildCues()
    },
    { immediate: true },
  )

  watch(lapsVersion, () => {
    const key = `${meta.value?.sessionUid}/${referenceLap.value?.driver.code}`
    if (recorder.last && alignedFromFullLap !== key && refitFrom(recorder.last)) alignedFromFullLap = key
    refreshAnalysis()
    rebuildCues()
  })

  watch(brakeMode, rebuildCues)
  watch(leadSeconds, (value) => {
    engine.leadS = value
    writeSetting('f1tutor.lead', String(value))
  })

  // Flush 'sync' so cues keep up with each message, even in a background tab.
  watch(
    tick,
    (current) => {
      const lap = current?.lap
      const car = current?.car
      if (!lap || !car || !current.live || current.paused) return

      const now = performance.now()
      if (!alignment.value?.fitted && now >= nextAlignAttemptAt) {
        nextAlignAttemptAt = now + ALIGN_RETRY_MS
        const before = alignment.value
        refitFrom(recorder.current)
        if (alignment.value !== before) rebuildCues()
      }

      nextCue.value = engine.next(lap.lap_distance)
      if (lap.pit_status !== 0) return
      const fired = engine.update({ distanceM: lap.lap_distance, speedKmh: car.speed, nowMs: now })
      if (!fired) return
      if (voiceState.value === 'on') player.play(fired.kind)
      activeCue.value = fired
      clearTimeout(flashTimer)
      flashTimer = setTimeout(() => (activeCue.value = null), CUE_FLASH_MS)
    },
    { flush: 'sync' },
  )
}
