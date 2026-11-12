// Converting laps to and from their saved form, and comparing a lap with a saved one.

import { CELLS, CHANNELS, GRID_M, LapTrace, lapClock, type LapRecorder, type LapRow } from './lapRecorder'
import type { Track } from './store'
import type { Meta } from './types'

export interface SavedLapPayload extends LapRow {
  cells: number
  trace: string
}

export interface SavePayload {
  sessionUid: string
  name: string
  trackId: number
  trackName: string
  trackLength: number
  sessionType: number
  formula: number
  teamId: number | null
  driverName: string
  raceNumber: number | null
  weather: number
  trackTemp: number
  airTemp: number
  gameVersion: string | null
  laps: SavedLapPayload[]
}

export interface SavedLapRow {
  lap: number
  ms: number
  s1: number | null
  s2: number | null
  s3: number | null
  valid: boolean
  clean: boolean
}

export interface SessionSummary {
  id: number
  name: string
  savedAt: string
  sessionUid: string
  trackId: number
  trackName: string
  trackLength: number
  sessionType: number
  formula: number
  teamId: number | null
  driverName: string
  lapCount: number
  validLapCount: number
  bestLapNumber: number | null
  bestLapMs: number | null
  bestS1: number | null
  bestS2: number | null
  bestS3: number | null
}

export function encodeTrace(trace: LapTrace, cells: number): string {
  const raw = new Float32Array(cells * CHANNELS.length)
  CHANNELS.forEach((channel, i) => raw.set(trace.channels[channel].subarray(0, cells), i * cells))
  const bytes = new Uint8Array(raw.buffer)
  let binary = ''
  // In pieces, because a whole lap is too many arguments for one call.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

export function decodeTrace(encoded: string, cells: number, lapMs: number): LapTrace {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const raw = new Float32Array(bytes.buffer)
  const trace = new LapTrace()
  const shown = Math.min(cells, CELLS)
  CHANNELS.forEach((channel, i) => trace.channels[channel].set(raw.subarray(i * cells, i * cells + shown)))
  trace.lapMs = lapMs
  return trace
}

/** Everything needed to save the laps driven so far, or null if there's nothing to save. */
export function buildSavePayload(meta: Meta | null, recorder: LapRecorder, trackName: string, name: string): SavePayload | null {
  const session = meta?.session
  if (!meta?.sessionUid || !session) return null
  // One extra cell, since the end of a lap can fall just past a whole number of cells.
  const cells = Math.min(CELLS, Math.ceil(session.trackLength / GRID_M) + 1)
  const laps: SavedLapPayload[] = []
  for (const row of recorder.laps) {
    const trace = recorder.traces.get(row.lap)
    if (trace) laps.push({ ...row, cells, trace: encodeTrace(trace, cells) })
  }
  if (laps.length === 0) return null
  return {
    sessionUid: meta.sessionUid,
    name,
    trackId: session.trackId,
    trackName,
    trackLength: session.trackLength,
    sessionType: session.sessionType,
    formula: session.formula,
    teamId: meta.player?.teamId ?? null,
    driverName: meta.player?.name ?? '',
    raceNumber: meta.player?.raceNumber ?? null,
    weather: session.weather,
    trackTemp: session.trackTemp,
    airTemp: session.airTemp,
    gameVersion: meta.gameVersion,
    laps,
  }
}

export interface Stretch {
  label: string
  fromM: number
  toM: number
}

/** One stretch of the lap per corner, meeting halfway between corners, in the game's metres. */
export function cornerStretches(track: Track, lengthM: number, gameDistance: (fraction: number) => number): Stretch[] {
  const apexes = track.corners
    .map((corner) => ({ label: corner.label, m: gameDistance(corner.fraction) }))
    .sort((a, b) => a.m - b.m)
  return apexes.map((apex, i) => ({
    label: apex.label,
    fromM: i === 0 ? 0 : (apexes[i - 1].m + apex.m) / 2,
    toM: i === apexes.length - 1 ? lengthM : (apex.m + apexes[i + 1].m) / 2,
  }))
}

export interface StretchDelta {
  label: string
  /** Seconds lost (positive) or gained (negative) against the saved lap, null if unknown. */
  deltaS: number | null
}

/** Both laps use the game's own distance, so they compare directly without any alignment. */
export function compareStretches(current: LapTrace, saved: LapTrace, stretches: Stretch[], lengthM: number): StretchDelta[] {
  return stretches.map(({ label, fromM, toM }) => {
    const own = lapClock(current, toM, lengthM) - lapClock(current, fromM, lengthM)
    const other = lapClock(saved, toM, lengthM) - lapClock(saved, fromM, lengthM)
    const deltaS = (own - other) / 1000
    return { label, deltaS: Number.isNaN(deltaS) ? null : deltaS }
  })
}
