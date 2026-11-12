import { computed, reactive, ref, shallowRef } from 'vue'
import tracksData from '../data/tracks.json'
import { toGame, toReference, type Alignment } from './alignment'
import { LapRecorder } from './lapRecorder'
import { DistanceSmoother } from './smoothing'
import { ownBuild, reloadIfOutdated } from './version'
import type { Meta, Tick } from './types'

export interface Corner {
  label: string
  fraction: number
  labelDir: [number, number]
}

export interface Track {
  id: number
  name: string
  country: string
  lengthM: number
  points: [number, number][]
  corners: Corner[]
}

export const tracks = tracksData as unknown as Track[]
const tracksById = new Map(tracks.map((track) => [track.id, track]))

export type ConnectionState = 'connecting' | 'open' | 'closed'

export const connection = ref<ConnectionState>('connecting')
export const meta = shallowRef<Meta | null>(null)
export const tick = shallowRef<Tick | null>(null)
/** The live dashboard, or the analysis of finished laps. */
export const viewMode = ref<'live' | 'study'>('live')
export const recorder = new LapRecorder()
/** Run just before a new session wipes the laps of the old one. */
export const beforeSessionReset: (() => void)[] = []
/** Bumped when recorder.laps changes, so templates can react to it. */
export const lapsVersion = ref(0)

const TRACK_STORAGE_KEY = 'f1tutor.track'
export const AUTO_TRACK = 'auto'

function loadTrackChoice(): string {
  try {
    return localStorage.getItem(TRACK_STORAGE_KEY) ?? AUTO_TRACK
  } catch {
    return AUTO_TRACK
  }
}

const trackChoice = ref(loadTrackChoice())

/** The track picked in the selector: "auto" follows the game. */
export const selectedTrack = computed({
  get: () => trackChoice.value,
  set: (value: string) => {
    trackChoice.value = value
    try {
      localStorage.setItem(TRACK_STORAGE_KEY, value)
    } catch {
      // Without storage the choice just lasts until the page reloads.
    }
  },
})

/** Track of the most recently saved drive, shown when there's no game to follow. */
export const lastDriveTrackId = ref<number | null>(null)

/** The track the game reports, once it has. */
export const gameTrack = computed(() => {
  const id = meta.value?.session?.trackId
  return id === undefined ? null : (tracksById.get(id) ?? null)
})

/** Without a game, the saved drives and their analysis still need a track, so "auto" falls back to the last drive's. */
export const lastDriveTrack = computed(() => (lastDriveTrackId.value === null ? null : (tracksById.get(lastDriveTrackId.value) ?? null)))

export const shownTrack = computed(() => {
  if (trackChoice.value === AUTO_TRACK) return gameTrack.value ?? lastDriveTrack.value
  return tracksById.get(Number(trackChoice.value)) ?? null
})

/** The car's position only means something on the map of the track being driven. */
export const showsLivePosition = computed(() => shownTrack.value !== null && shownTrack.value === gameTrack.value)

export const isLive = computed(() => connection.value === 'open' && tick.value?.live === true)

/** How the game's lap distance maps onto the real lap, once a real lap is loaded. */
export const alignment = shallowRef<Alignment | null>(null)
export const referenceLengthM = shallowRef<number | null>(null)

const smoother = new DistanceSmoother()

/** Lap distance for this moment, moving evenly between the game's updates. */
export function liveDistance(now: number): number | null {
  const current = tick.value
  if (!current?.lap) return null
  if (!current.live || current.paused || !current.car) return current.lap.lap_distance
  return smoother.value(now)
}

// How the link to the game is doing, to tell what a freeze comes from.
export const diagnostics = reactive({
  /** Longest wait for new data in the browser, over the last few seconds. */
  connectionGapMs: 0,
  /** Longest time the page itself couldn't draw. */
  pageStallMs: 0,
  /** Messages that couldn't be read. */
  badMessages: 0,
  /** Errors thrown while handling or drawing data. */
  errors: 0,
  lastError: '',
})

const DIAGNOSTICS_WINDOW_MS = 5000
const connectionGaps: { at: number; gap: number }[] = []
const pageGaps: { at: number; gap: number }[] = []

function noteGap(list: { at: number; gap: number }[], at: number, gap: number): number {
  list.push({ at, gap })
  while (list[0].at < at - DIAGNOSTICS_WINDOW_MS) list.shift()
  return Math.round(Math.max(...list.map((entry) => entry.gap)))
}

export function reportError(error: unknown): void {
  diagnostics.errors++
  diagnostics.lastError = error instanceof Error ? error.message : String(error)
  console.error(error)
}

let lastFrameSeen: number | null = null
let lastNewDataAt = 0

function noteTick(message: Tick, now: number): void {
  const isNew = message.frame !== lastFrameSeen
  lastFrameSeen = message.frame
  if (!isNew || !message.live || message.paused) return
  // Time stuck in a pause or a menu isn't a stall.
  if (lastNewDataAt && now - lastNewDataAt < DIAGNOSTICS_WINDOW_MS) {
    diagnostics.connectionGapMs = noteGap(connectionGaps, now, now - lastNewDataAt)
  }
  lastNewDataAt = now
  if (message.lap && message.car) smoother.sample(message.lap.lap_distance, message.car.speed, now)
}

let lastDrawAt = 0
let watchingPage = false

/** Runs once per animation frame, to notice when the page itself stalls. */
function watchPage(now: number): void {
  // A hidden page isn't drawn at all, which isn't a stall.
  if (lastDrawAt && document.visibilityState === 'visible') {
    const gap = now - lastDrawAt
    if (gap < DIAGNOSTICS_WINDOW_MS) diagnostics.pageStallMs = noteGap(pageGaps, now, gap)
  }
  lastDrawAt = now
  requestAnimationFrame(watchPage)
}

let lastSessionUid: string | null = null

function handleMessage(raw: string): void {
  let message: Meta | Tick
  try {
    message = JSON.parse(raw)
  } catch {
    diagnostics.badMessages++
    return
  }
  if (message.type === 'meta') {
    reloadIfOutdated(ownBuild(import.meta.url), message.build)
    // Only a different session id is a new session: a restarted server reports none until the game's next packet.
    if (message.sessionUid && lastSessionUid && message.sessionUid !== lastSessionUid) {
      for (const listener of beforeSessionReset) listener()
      recorder.reset()
      lapsVersion.value++
    }
    if (message.sessionUid) lastSessionUid = message.sessionUid
    meta.value = message
    return
  }
  const now = performance.now()
  // A problem with recording one update must not stop the dashboard from showing it.
  try {
    noteTick(message, now)
    if (message.lap && message.live && !message.paused) {
      if (recorder.ingest(message.lap, message.car, meta.value?.session?.trackLength, message.motion)) lapsVersion.value++
    }
  } catch (error) {
    reportError(error)
  }
  tick.value = message
}

export function connect(): void {
  if (!watchingPage) {
    watchingPage = true
    requestAnimationFrame(watchPage)
  }
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  const socket = new WebSocket(`${scheme}://${location.host}/ws`)
  connection.value = 'connecting'
  socket.onopen = () => {
    connection.value = 'open'
  }
  socket.onmessage = (event) => handleMessage(event.data)
  socket.onclose = () => {
    connection.value = 'closed'
    setTimeout(connect, 1000)
  }
}

function gameLengthM(): number {
  return meta.value?.session?.trackLength || shownTrack.value?.lengthM || 1
}

/** Where on the map's lap (0..1) a game lap distance is. */
export function lapFraction(distance: number): number {
  const fraction =
    alignment.value && referenceLengthM.value
      ? toReference(alignment.value, distance) / referenceLengthM.value
      : distance / gameLengthM()
  return ((fraction % 1) + 1) % 1
}

/** The game lap distance of a place on the map's lap (0..1). */
export function distanceAtFraction(fraction: number): number {
  if (alignment.value && referenceLengthM.value) {
    const length = gameLengthM()
    return ((toGame(alignment.value, fraction * referenceLengthM.value) % length) + length) % length
  }
  return fraction * gameLengthM()
}
