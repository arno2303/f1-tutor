// Saving drives to the database and choosing a saved lap to compare with.

import { computed, ref, shallowRef, watch } from 'vue'
import { t, type MessageKey } from '../i18n'
import { comparedTrack } from './comparison'
import { LapTrace } from './lapRecorder'
import { buildSavePayload, decodeTrace, type SavedLapRow, type SavePayload, type SessionSummary } from './savedLaps'
import { beforeSessionReset, gameTrack, lapsVersion, lastDriveTrackId, meta, recorder, tracks } from './store'
import { trackName } from './trackNames'

export const savedSessions = shallowRef<SessionSummary[]>([])
/** Saved drives at every track, newest first, to know where there's something to look at. */
const allSessions = shallowRef<SessionSummary[]>([])
export const sessionsError = ref('')
export const saving = ref(false)
/** The saved lap the current driving is compared with. */
export const savedLap = shallowRef<{ session: SessionSummary; row: SavedLapRow; trace: LapTrace } | null>(null)
/** Sessions that ended before their laps were saved, oldest first. */
export const unsavedPrevious = shallowRef<SavePayload[]>([])
// Each holds a few hundred kB of laps; past this many the oldest are let go.
const MAX_UNSAVED_SESSIONS = 10
const lastSave = shallowRef<{ uid: string; lapCount: number; at: Date } | null>(null)

// The server answers errors with a code, translated here into the chosen language.
const ERROR_CODES: Record<string, MessageKey> = {
  trace_unreadable: 'errors.traceUnreadable',
  trace_size: 'errors.traceSize',
  session_not_found: 'errors.sessionNotFound',
  lap_not_found: 'errors.lapNotFound',
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(path, init)
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    const key = ERROR_CODES[body?.detail?.code]
    throw new Error(key ? t(key, body.detail) : t('errors.server', { status: response.status }))
  }
  return response
}

/** Shows what went wrong; `saving` says whether a drive failed to save, which matters to the driver most. */
function report(error: unknown, saving = false): void {
  // fetch fails with a TypeError when the server can't be reached at all.
  if (error instanceof TypeError) sessionsError.value = t(saving ? 'errors.serverDown' : 'errors.serverUnreachable')
  else sessionsError.value = error instanceof Error ? error.message : String(error)
}

export interface SavedTrack {
  id: number
  name: string
  count: number
}

/** Tracks with saved drives, the most recently driven first. */
export const savedTracks = computed<SavedTrack[]>(() => {
  const byTrack = new Map<number, SavedTrack>()
  for (const session of allSessions.value) {
    const known = byTrack.get(session.trackId)
    if (known) known.count++
    else {
      const track = tracks.find((candidate) => candidate.id === session.trackId)
      const name = track ? trackName(track) : session.trackName
      byTrack.set(session.trackId, { id: session.trackId, name, count: 1 })
    }
  }
  return [...byTrack.values()]
})

async function refreshAllSessions(): Promise<void> {
  try {
    allSessions.value = (await (await api('/api/sessions')).json()) as SessionSummary[]
    lastDriveTrackId.value = allSessions.value[0]?.trackId ?? null
  } catch (error) {
    report(error)
  }
}

/** Saved drives at a track, newest first. */
export async function fetchSessions(trackId: number): Promise<SessionSummary[]> {
  return (await (await api(`/api/sessions?trackId=${trackId}`)).json()) as SessionSummary[]
}

/** A drive saved again gains laps, so its cached lap table is out of date. */
function forgetCachedLaps(sessionUid: string): void {
  const session = savedSessions.value.find((s) => s.sessionUid === sessionUid)
  if (session) lapTableCache.delete(session.id)
}

export async function refreshSessions(): Promise<void> {
  void refreshAllSessions()
  const track = comparedTrack.value
  if (!track) {
    savedSessions.value = []
    return
  }
  try {
    const sessions = await fetchSessions(track.id)
    if (comparedTrack.value === track) savedSessions.value = sessions
    // A list that loads again means an earlier "can't reach the server" no longer applies.
    if (sessionsError.value === t('errors.serverUnreachable')) sessionsError.value = ''
  } catch (error) {
    report(error)
  }
}

async function post(payload: SavePayload): Promise<void> {
  await api('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

/** Finished laps of this session that aren't in the database yet. */
export const unsavedLapCount = computed(() => {
  void lapsVersion.value
  const saved = lastSave.value?.uid === meta.value?.sessionUid ? (lastSave.value?.lapCount ?? 0) : 0
  return Math.max(0, recorder.laps.length - saved)
})

export const lastSavedAt = computed(() => (lastSave.value?.uid === meta.value?.sessionUid ? (lastSave.value?.at ?? null) : null))

export async function saveCurrentSession(name: string): Promise<boolean> {
  const payload = buildSavePayload(meta.value, recorder, gameTrack.value?.name ?? `Trať ${meta.value?.session?.trackId}`, name.trim())
  if (!payload) return false
  saving.value = true
  sessionsError.value = ''
  try {
    await post(payload)
    lastSave.value = { uid: payload.sessionUid, lapCount: payload.laps.length, at: new Date() }
    forgetCachedLaps(payload.sessionUid)
    await refreshSessions()
    return true
  } catch (error) {
    report(error, true)
    return false
  } finally {
    saving.value = false
  }
}

export async function savePrevious(): Promise<void> {
  if (!unsavedPrevious.value.length) return
  saving.value = true
  sessionsError.value = ''
  try {
    // One at a time, removing each once saved, so a failure keeps only what's still unsaved.
    for (const payload of [...unsavedPrevious.value]) {
      await post(payload)
      forgetCachedLaps(payload.sessionUid)
      unsavedPrevious.value = unsavedPrevious.value.filter((pending) => pending !== payload)
    }
    await refreshSessions()
  } catch (error) {
    report(error, true)
  } finally {
    saving.value = false
  }
}

export function discardPrevious(): void {
  unsavedPrevious.value = []
}

const lapTableCache = new Map<number, SavedLapRow[]>()
const traceCache = new Map<string, LapTrace>()

/** A saved drive's lap table. */
export async function fetchSessionLaps(sessionId: number): Promise<SavedLapRow[]> {
  let laps = lapTableCache.get(sessionId)
  if (!laps) {
    laps = ((await (await api(`/api/sessions/${sessionId}`)).json()) as { laps: SavedLapRow[] }).laps
    lapTableCache.set(sessionId, laps)
  }
  return laps
}

/** One saved lap's telemetry, downloaded once and kept. */
export async function fetchSavedTrace(sessionId: number, row: SavedLapRow): Promise<LapTrace> {
  const key = `${sessionId}/${row.lap}`
  let lap = traceCache.get(key)
  if (!lap) {
    const response = await api(`/api/sessions/${sessionId}/laps/${row.lap}/trace`)
    const { cells, trace } = (await response.json()) as { cells: number; trace: string }
    lap = decodeTrace(trace, cells, row.ms)
    traceCache.set(key, lap)
  }
  return lap
}

let compareRequest = 0

export async function compareWith(session: SessionSummary): Promise<void> {
  if (session.bestLapNumber === null || session.bestLapMs === null) return
  const request = ++compareRequest
  sessionsError.value = ''
  try {
    const row = (await fetchSessionLaps(session.id)).find((lap) => lap.lap === session.bestLapNumber)
    if (!row) throw new Error(t('errors.savedLapMissing'))
    const trace = await fetchSavedTrace(session.id, row)
    // A later click, or a change of track, wins over a slow answer.
    if (request === compareRequest && comparedTrack.value?.id === session.trackId) savedLap.value = { session, row, trace }
  } catch (error) {
    if (request === compareRequest) report(error)
  }
}

export function stopComparing(): void {
  compareRequest++
  savedLap.value = null
}

export async function deleteSession(session: SessionSummary): Promise<void> {
  sessionsError.value = ''
  try {
    await api(`/api/sessions/${session.id}`, { method: 'DELETE' })
    lapTableCache.delete(session.id)
    if (savedLap.value?.session.id === session.id) savedLap.value = null
    if (lastSave.value?.uid === session.sessionUid) lastSave.value = null
    await refreshSessions()
  } catch (error) {
    report(error)
  }
}

let started = false

export function startSessions(): void {
  if (started) return
  started = true

  // A restart in the game starts a new session; laps not yet saved shouldn't vanish with it.
  beforeSessionReset.push(() => {
    if (unsavedLapCount.value === 0) return
    const trackName = gameTrack.value?.name ?? `Trať ${meta.value?.session?.trackId}`
    const payload = buildSavePayload(meta.value, recorder, trackName, '')
    if (!payload) return
    const others = unsavedPrevious.value.filter((pending) => pending.sessionUid !== payload.sessionUid)
    unsavedPrevious.value = [...others, payload].slice(-MAX_UNSAVED_SESSIONS)
  })

  watch(
    comparedTrack,
    (track) => {
      if (savedLap.value && savedLap.value.session.trackId !== track?.id) savedLap.value = null
      void refreshSessions()
    },
    { immediate: true },
  )
}
