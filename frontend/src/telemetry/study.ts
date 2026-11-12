// State of the lap analysis view: which laps are compared, loaded and measured.

import { computed, nextTick, ref, shallowRef, watch } from 'vue'
import { dateLocale, t } from '../i18n'
import { defaultAlignment, fitAlignment, toGame, toReference, type Alignment } from './alignment'
import { analyzeLap, buildZones, drivingPoints, fitBrakeEnvelope, referenceView, type CornerZone } from './analysis'
import { driversAt, fetchReferenceLap, loadStoredAlignment } from './comparison'
import { formatLapTime } from './format'
import type { LapTrace } from './lapRecorder'
import { ownSide, realSide, studyRows, studyZones, verdictsByCorner, type LapSide, type StudyRow } from './lapStudy'
import type { RefDriver } from './reference'
import type { SavedLapRow, SessionSummary } from './savedLaps'
import { fetchSavedTrace, fetchSessionLaps, fetchSessions, savedSessions } from './sessions'
import { gameTrack, lapsVersion, meta, recorder, selectedTrack, shownTrack, viewMode, type Track } from './store'

export type SourceId = number | 'current'

export interface LapChoice {
  source: SourceId
  lap: number
}

export interface StudySource {
  id: SourceId
  label: string
  lengthM: number
}

export interface Study {
  track: Track
  lengthM: number
  a: LapSide
  b: LapSide
  bKind: 'real' | 'own'
  aRow: SavedLapRow
  bRow: SavedLapRow | null
  driver: RefDriver | null
  zones: CornerZone[]
  rows: StudyRow[]
  /** Map position (0..1) of a place on the analysed lap, and back. */
  fraction(metres: number): number
  metresAt(fraction: number): number
}

/** The track being analysed: the one picked at the top, which follows the game by default. */
export const studyTrack = computed<Track | null>(() => shownTrack.value ?? gameTrack.value)

const sessions = shallowRef<SessionSummary[]>([])
const lapTables = shallowRef(new Map<number, SavedLapRow[]>())

export const choiceA = ref<LapChoice | null>(null)
export const compareKind = ref<'real' | 'own'>('real')
export const choiceB = ref<LapChoice | null>(null)
export const driverCode = ref<string | null>(null)

export const study = shallowRef<Study | null>(null)
export const studyLoading = ref(false)
export const studyError = ref('')
/** Place on the analysed lap under the pointer, shared by the chart, map and table. */
export const hoverM = ref<number | null>(null)
/** Part of the lap shown in the chart; null shows all of it. */
export const zoom = shallowRef<{ from: number; to: number } | null>(null)

export const drivers = computed<RefDriver[]>(() => (studyTrack.value ? driversAt(studyTrack.value.id) : []))

const currentRows = computed<SavedLapRow[]>(() => {
  void lapsVersion.value
  if (!studyTrack.value || gameTrack.value !== studyTrack.value) return []
  return recorder.laps.filter((row) => recorder.traces.has(row.lap))
})

const dateText = (iso: string) =>
  new Date(iso).toLocaleString(dateLocale.value, { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })

export const sources = computed<StudySource[]>(() => {
  const list: StudySource[] = []
  if (currentRows.value.length) {
    list.push({ id: 'current', label: t('study.currentDrive'), lengthM: meta.value?.session?.trackLength ?? 0 })
  }
  for (const session of sessions.value) {
    list.push({ id: session.id, label: session.name || dateText(session.savedAt), lengthM: session.trackLength })
  }
  return list
})

export function lapsOf(source: SourceId | undefined): SavedLapRow[] {
  if (source === undefined) return []
  if (source === 'current') return currentRows.value
  return lapTables.value.get(source) ?? []
}

export const lapLabel = (row: SavedLapRow) =>
  t(row.valid ? 'study.lapOption' : 'study.lapOptionInvalid', { lap: row.lap, time: formatLapTime(row.ms) })

async function ensureLapTable(source: SourceId): Promise<SavedLapRow[]> {
  if (source === 'current') return currentRows.value
  const known = lapTables.value.get(source)
  if (known) return known
  const rows = await fetchSessionLaps(source)
  lapTables.value = new Map(lapTables.value).set(source, rows)
  return rows
}

function bestRow(rows: SavedLapRow[], except?: number): SavedLapRow | undefined {
  const candidates = rows.filter((row) => row.lap !== except)
  return candidates.filter((row) => row.valid).sort((x, y) => x.ms - y.ms)[0] ?? candidates[candidates.length - 1]
}

/** Picks sensible laps when nothing valid is chosen: the newest drive's best against a real driver. */
async function ensureChoices(): Promise<void> {
  const available = sources.value
  if (!available.length) {
    choiceA.value = null
    return
  }
  if (!choiceA.value || !available.some((s) => s.id === choiceA.value!.source)) {
    const source = available[0].id
    const best = bestRow(await ensureLapTable(source))
    choiceA.value = best ? { source, lap: best.lap } : null
  } else {
    await ensureLapTable(choiceA.value.source)
  }
  if (!drivers.value.length) compareKind.value = 'own'
  if (compareKind.value === 'own') await ensureOwnB()
}

async function ensureOwnB(): Promise<void> {
  const a = choiceA.value
  if (!a) return
  const valid = choiceB.value && sources.value.some((s) => s.id === choiceB.value!.source)
  const same = choiceB.value && choiceB.value.source === a.source && choiceB.value.lap === a.lap
  if (valid && !same) {
    await ensureLapTable(choiceB.value!.source)
    return
  }
  // Another lap of the same drive first, else the best of another drive.
  const other = bestRow(await ensureLapTable(a.source), a.lap)
  if (other) {
    choiceB.value = { source: a.source, lap: other.lap }
    return
  }
  for (const source of sources.value) {
    if (source.id === a.source) continue
    const best = bestRow(await ensureLapTable(source.id))
    if (best) {
      choiceB.value = { source: source.id, lap: best.lap }
      return
    }
  }
  choiceB.value = null
}

async function traceOf(choice: LapChoice): Promise<{ trace: LapTrace; row: SavedLapRow; lengthM: number; label: string }> {
  const rows = await ensureLapTable(choice.source)
  const row = rows.find((r) => r.lap === choice.lap)
  if (!row) throw new Error(t('errors.lapGone'))
  // The drive's details, including the game's own lap length, come with the list of drives.
  if (!sources.value.some((s) => s.id === choice.source)) await refreshSources()
  const source = sources.value.find((s) => s.id === choice.source)
  if (!source) throw new Error(t('errors.driveGone'))
  const label = t('study.sideLabel', { name: source.label, lap: row.lap, time: formatLapTime(row.ms) })
  if (choice.source === 'current') {
    const trace = recorder.traces.get(row.lap)
    if (!trace) throw new Error(t('errors.lapNotInMemory'))
    return { trace, row, lengthM: source.lengthM, label }
  }
  return { trace: await fetchSavedTrace(choice.source, row), row, lengthM: source.lengthM, label }
}

let token = 0

async function rebuild(): Promise<void> {
  const mine = ++token
  const track = studyTrack.value
  const a = choiceA.value
  if (!track || !a) {
    study.value = null
    return
  }
  studyLoading.value = true
  studyError.value = ''
  try {
    const first = await traceOf(a)
    const lengthM = first.lengthM || track.lengthM
    const driver = drivers.value.find((d) => d.code === driverCode.value) ?? drivers.value[0] ?? null
    // Comparing own laps only uses the real lap for corner positions, so carry on without it.
    let ref: Awaited<ReturnType<typeof fetchReferenceLap>> | null = null
    if (driver) {
      try {
        ref = await fetchReferenceLap(track.id, driver)
      } catch (error) {
        if (compareKind.value === 'real') throw error
      }
    }
    let alignment: Alignment | null = null
    if (ref) alignment = fitAlignment(first.trace, lengthM, ref) ?? loadStoredAlignment(track, ref.driver.code) ?? defaultAlignment(lengthM, ref.lengthM)
    const refZones = ref ? buildZones(track, ref) : []

    const sideA = ownSide(first.trace, lengthM, first.label)
    const zones = studyZones(track, lengthM, sideA.view, ref && alignment ? { zones: refZones, alignment } : undefined)

    let sideB: LapSide
    let bRow: SavedLapRow | null = null
    let rows: StudyRow[]
    const bKind = compareKind.value === 'real' && ref && alignment ? 'real' : 'own'
    if (bKind === 'real') {
      sideB = realSide(ref!, alignment!, `${driver!.name} · ${formatLapTime(driver!.lapMs)}`, lengthM)
      const refPoints = refZones.map((zone) => drivingPoints(referenceView(ref!), zone))
      const verdicts = analyzeLap(first.trace, first.row.lap, lengthM, ref!, refZones, refPoints, alignment!, fitBrakeEnvelope([first.trace]))
      rows = studyRows(sideA, sideB, zones, verdictsByCorner(verdicts.corners))
    } else {
      if (!choiceB.value) throw new Error(t('errors.needSecondLap'))
      const second = await traceOf(choiceB.value)
      sideB = ownSide(second.trace, second.lengthM || lengthM, second.label)
      bRow = second.row
      rows = studyRows(sideA, sideB, zones)
    }

    const wrap = (value: number) => ((value % 1) + 1) % 1
    const fraction = (metres: number) =>
      ref && alignment ? wrap(toReference(alignment, metres) / ref.lengthM) : wrap(metres / lengthM)
    const metresAt = (f: number) =>
      ref && alignment ? (((toGame(alignment, f * ref.lengthM) % lengthM) + lengthM) % lengthM) : f * lengthM

    if (mine !== token) return
    study.value = { track, lengthM, a: sideA, b: sideB, bKind, aRow: first.row, bRow, driver, zones, rows, fraction, metresAt }
  } catch (error) {
    if (mine !== token) return
    study.value = null
    studyError.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (mine === token) studyLoading.value = false
  }
}

async function refreshSources(): Promise<void> {
  const track = studyTrack.value
  if (!track) {
    sessions.value = []
    return
  }
  try {
    const list = await fetchSessions(track.id)
    if (studyTrack.value !== track) return
    const tables = new Map(lapTables.value)
    for (const session of list) if (tables.get(session.id)?.length !== session.lapCount) tables.delete(session.id)
    lapTables.value = tables
    sessions.value = list
  } catch (error) {
    studyError.value = error instanceof Error ? error.message : String(error)
  }
}

/** Opens the analysis, optionally on a saved drive's best lap. */
export async function openStudy(session?: SessionSummary): Promise<void> {
  viewMode.value = 'study'
  if (session && studyTrack.value?.id !== session.trackId) {
    // The drive may be from another track than the one picked at the top.
    selectedTrack.value = String(session.trackId)
    await nextTick()
  }
  if (session) {
    if (!sessions.value.some((s) => s.id === session.id)) sessions.value = [session, ...sessions.value]
    const rows = await ensureLapTable(session.id)
    const best = bestRow(rows)
    if (best) choiceA.value = { source: session.id, lap: best.lap }
  }
}

let started = false

export function startStudy(): void {
  if (started) return
  started = true

  // Fetched only while the analysis is open; the live view has its own list.
  watch(
    [viewMode, studyTrack, savedSessions, sources],
    async ([mode]) => {
      if (mode !== 'study') return
      await refreshSources()
      await ensureChoices()
    },
    { immediate: true },
  )
  watch(studyTrack, () => {
    choiceA.value = null
    choiceB.value = null
    zoom.value = null
  })
  watch(compareKind, async (kind) => {
    if (kind === 'own') await ensureOwnB()
  })
  watch(choiceA, async () => {
    zoom.value = null
    // Choosing the lap that was being compared against moves the comparison to another one.
    if (compareKind.value === 'own') await ensureOwnB()
  })
  watch(
    [viewMode, choiceA, compareKind, choiceB, driverCode],
    ([mode]) => {
      if (mode === 'study') void rebuild()
    },
    { deep: true },
  )
}
