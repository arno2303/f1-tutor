<script setup lang="ts">
import { computed, ref } from 'vue'
import { formulaName, sessionName } from '../data/gameTables'
import { comparedTrack } from '../telemetry/comparison'
import { dateLocale, t, tn } from '../i18n'
import { formatDelta, formatLapTime } from '../telemetry/format'
import { trackName } from '../telemetry/trackNames'
import { compareStretches, cornerStretches, type SessionSummary } from '../telemetry/savedLaps'
import {
  compareWith, deleteSession, discardPrevious, lastSavedAt, savePrevious, saveCurrentSession, savedLap, savedSessions, saving,
  sessionsError, stopComparing, unsavedLapCount, unsavedPrevious,
} from '../telemetry/sessions'
import { openStudy } from '../telemetry/study'
import SavedTracks from './SavedTracks.vue'
import { distanceAtFraction, lapsVersion, meta, recorder } from '../telemetry/store'

const name = ref('')
const confirmingDelete = ref<number | null>(null)

const lapCount = computed(() => {
  void lapsVersion.value
  return recorder.laps.length
})
const bestNow = computed(() => {
  void lapsVersion.value
  return recorder.bestLap
})

const saveStatus = computed(() => {
  if (lastSavedAt.value === null) return lapCount.value ? t('results.unsaved') : ''
  const time = lastSavedAt.value.toLocaleTimeString(dateLocale.value, { hour: '2-digit', minute: '2-digit' })
  if (unsavedLapCount.value === 0) return t('results.savedAt', { time })
  return t('results.savedAtMore', { time, laps: tn('unit.laps', unsavedLapCount.value) })
})

async function save() {
  if (await saveCurrentSession(name.value)) name.value = ''
}

/** Today's lap to measure against the saved one: the best, or the latest without a valid one. */
const comparison = computed(() => {
  void lapsVersion.value
  const saved = savedLap.value
  if (!saved) return null
  const best = recorder.bestLap
  const row = best ?? recorder.laps[recorder.laps.length - 1]
  const trace = row ? recorder.traces.get(row.lap) : undefined
  if (!row || !trace) return null
  const track = comparedTrack.value
  const lengthM = meta.value?.session?.trackLength || track?.lengthM || 0
  const stretches = track ? cornerStretches(track, lengthM, distanceAtFraction) : []
  const deltas = compareStretches(trace, saved.trace, stretches, lengthM)
  const known = deltas.filter((d) => d.deltaS !== null).map((d) => d.deltaS!)
  const worst = Math.max(0, ...known)
  const sector = (own: number | null, other: number | null) => (own && other ? (own - other) / 1000 : null)
  return {
    lap: row.lap,
    ms: row.ms,
    total: (row.ms - saved.trace.lapMs) / 1000,
    sectors: [
      { name: 'S1', delta: sector(row.s1, saved.row.s1) },
      { name: 'S2', delta: sector(row.s2, saved.row.s2) },
      { name: 'S3', delta: sector(row.s3, saved.row.s3) },
    ],
    corners: deltas.map((d) => ({ ...d, isWorst: d.deltaS !== null && d.deltaS === worst && worst > 0 })),
  }
})

const savedAtText = (session: SessionSummary) =>
  new Date(session.savedAt).toLocaleString(dateLocale.value, { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })

const gapToNow = (session: SessionSummary) => {
  // The session being driven would only be compared with itself.
  if (!bestNow.value || session.bestLapMs === null || session.sessionUid === meta.value?.sessionUid) return null
  return (bestNow.value.ms - session.bestLapMs) / 1000
}
const kind = (delta: number | null) => (delta === null ? '' : delta <= 0 ? 'gain' : 'loss')

function askDelete(session: SessionSummary) {
  if (confirmingDelete.value === session.id) {
    confirmingDelete.value = null
    void deleteSession(session)
  } else {
    confirmingDelete.value = session.id
  }
}
</script>

<template>
  <section class="card results">
    <div class="block">
      <div class="head">
        <span class="card-title">{{ t('results.current') }}</span>
        <span class="num status" role="status">{{ saveStatus }}</span>
      </div>
      <div class="now num">
        {{ tn('unit.laps', lapCount) }}<template v-if="bestNow"> · {{ t('results.best', { time: formatLapTime(bestNow.ms) }) }}</template>
      </div>
      <form class="save" @submit.prevent="save">
        <input v-model="name" maxlength="100" :placeholder="t('results.namePlaceholder')" :aria-label="t('results.nameLabel')" @keydown.stop />
        <button type="submit" class="primary" :disabled="saving || lapCount === 0 || (lastSavedAt !== null && unsavedLapCount === 0 && !name.trim())">
          {{ saving ? t('results.saving') : lastSavedAt ? t('results.saveAgain') : t('results.save') }}
        </button>
      </form>
      <p v-if="sessionsError" class="error" role="alert">▲ {{ sessionsError }}</p>
      <div v-if="unsavedPrevious.length" class="previous" role="status">
        <span v-if="unsavedPrevious.length === 1">
          {{ t('results.previous', { track: unsavedPrevious[0].trackName, laps: tn('unit.laps', unsavedPrevious[0].laps.length) }) }}
        </span>
        <span v-else>
          {{ t('results.previousMany', { drives: tn('unit.drives', unsavedPrevious.length), laps: tn('unit.laps', unsavedPrevious.reduce((sum, p) => sum + p.laps.length, 0)) }) }}
        </span>
        <span class="previous-actions">
          <button type="button" class="primary" :disabled="saving" @click="savePrevious">{{ t('results.previousSave') }}</button>
          <button type="button" @click="discardPrevious">{{ t('results.previousDiscard') }}</button>
        </span>
      </div>
    </div>

    <div v-if="savedLap" class="block compare">
      <div class="head">
        <span class="card-title">{{ t('results.compareTitle') }}</span>
        <button type="button" class="small" @click="stopComparing">{{ t('results.cancel') }}</button>
      </div>
      <div class="label">{{ t('results.savedLapLabel', { name: savedLap.session.name || savedAtText(savedLap.session), lap: savedLap.session.bestLapNumber ?? '', time: formatLapTime(savedLap.trace.lapMs) }) }}</div>
      <template v-if="comparison">
        <div class="total num">
          <span>{{ t('results.now', { time: formatLapTime(comparison.ms) }) }}</span>
          <b :class="kind(comparison.total)">{{ formatDelta(comparison.total) }} s</b>
        </div>
        <div class="sectors num">
          <span v-for="sector in comparison.sectors" :key="sector.name"><span class="label">{{ sector.name }}</span> <b :class="kind(sector.delta)">{{ formatDelta(sector.delta) }}</b></span>
        </div>
        <ol v-if="comparison.corners.length" class="corners num">
          <li v-for="corner in comparison.corners" :key="corner.label" :class="{ worst: corner.isWorst }">
            <span class="label">T{{ corner.label }}</span>
            <span :class="kind(corner.deltaS)">{{ formatDelta(corner.deltaS, 2) }}</span>
          </li>
        </ol>
      </template>
      <p v-else class="empty">{{ t('results.compareEmpty') }}</p>
    </div>

    <div class="block list-block">
      <div class="head">
        <span class="card-title">{{ t('results.savedList') }}<template v-if="comparedTrack"> · {{ trackName(comparedTrack) }}</template></span>
        <span class="label num">{{ savedSessions.length || '' }}</span>
      </div>
      <ul v-if="savedSessions.length" class="list">
        <li v-for="session in savedSessions" :key="session.id" :class="{ active: savedLap?.session.id === session.id }">
          <div class="row-main">
            <div class="row-title">{{ session.name || savedAtText(session) }}</div>
            <div class="label">
              <template v-if="session.name">{{ savedAtText(session) }} · </template>{{ sessionName(session.sessionType) }} · {{ formulaName(session.formula) }} · {{ tn('unit.laps', session.lapCount) }}
            </div>
          </div>
          <div class="row-time num">
            <b>{{ formatLapTime(session.bestLapMs) }}</b>
            <span v-if="gapToNow(session) !== null" :class="kind(gapToNow(session))">{{ formatDelta(gapToNow(session)) }}</span>
          </div>
          <div class="row-actions">
            <button type="button" class="small" :disabled="session.bestLapMs === null" :title="session.bestLapMs === null ? t('results.noValidLap') : t('results.compareHint')" @click="savedLap?.session.id === session.id ? stopComparing() : compareWith(session)">
              {{ savedLap?.session.id === session.id ? t('results.comparing') : t('results.compare') }}
            </button>
            <button type="button" class="small" @click="openStudy(session)">{{ t('results.analyse') }}</button>
            <button type="button" class="small" :class="{ danger: confirmingDelete === session.id }" @click="askDelete(session)" @blur="confirmingDelete = null">
              {{ confirmingDelete === session.id ? t('results.confirmDelete') : t('results.delete') }}
            </button>
          </div>
        </li>
      </ul>
      <template v-else>
        <p class="empty">{{ comparedTrack ? t('results.noneHere', { track: trackName(comparedTrack) }) : t('results.pickTrack') }}</p>
        <SavedTracks :except-id="comparedTrack?.id" />
      </template>
    </div>
  </section>
</template>

<style scoped>
.results {
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
  height: 100%;
  padding: 0.75rem 0.875rem;
  overflow: hidden;
}

.block {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  padding-bottom: 0.625rem;
  border-bottom: 1px solid var(--hairline);
}

.list-block {
  flex: 1;
  min-height: 0;
  padding-bottom: 0;
  border-bottom: 0;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.status {
  color: var(--text-2);
  font-size: max(0.75rem, 10.5px);
  white-space: nowrap;
}

.now {
  font-size: 1rem;
  font-weight: 600;
}

.save {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0.375rem;
}

input,
button {
  height: 2rem;
  padding: 0 0.625rem;
  border: 1px solid var(--control-border);
  border-radius: 0.5rem;
  background: var(--card-raised);
  color: var(--text);
  font: inherit;
  font-size: 0.8125rem;
}

input {
  min-width: 0;
}

input::placeholder {
  color: var(--text-3);
}

button {
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}

button:disabled {
  color: var(--text-3);
  cursor: default;
}

button.primary:not(:disabled) {
  border-color: var(--you);
}

button.small {
  height: 1.625rem;
  padding: 0 0.5rem;
  font-size: max(0.75rem, 10.5px);
}

button.danger {
  border-color: var(--brake);
}

.error {
  margin: 0;
  color: var(--bad-text);
  font-size: 0.8125rem;
}

.previous {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.375rem 0.5rem;
  border-radius: 0.5rem;
  background: var(--card-raised);
  color: var(--text-2);
  font-size: max(0.75rem, 10.5px);
  box-shadow: inset 0 0 0 1px var(--warn);
}

.previous-actions {
  display: flex;
  flex: none;
  gap: 0.25rem;
}

.previous button {
  height: 1.625rem;
  padding: 0 0.5rem;
  font-size: max(0.75rem, 10.5px);
}

.total {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  font-size: 0.875rem;
}

.total b {
  font-size: 1.25rem;
  font-weight: 700;
}

.sectors {
  display: flex;
  justify-content: space-between;
  font-size: 0.8125rem;
}

.sectors b {
  font-weight: 600;
}

.gain {
  color: var(--throttle);
}

.loss {
  color: var(--bad-text);
}

.corners {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.0625rem 0.75rem;
  margin: 0;
  padding: 0.25rem 0 0;
  font-size: max(0.75rem, 10.5px);
  list-style: none;
}

.corners li {
  display: flex;
  justify-content: space-between;
  gap: 0.25rem;
}

.corners li.worst {
  font-weight: 700;
  box-shadow: 0 1px 0 var(--warn);
}

.empty {
  margin: 0;
  color: var(--text-2);
  font-size: 0.8125rem;
}

.list {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.list li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.25rem 0.5rem;
  padding: 0.375rem 0.375rem;
  border-radius: 0.375rem;
}

.list li + li {
  margin-top: 0.125rem;
}

.list li.active {
  background: var(--card-raised);
  box-shadow: inset 0.1875rem 0 0 var(--best);
}

.row-title {
  overflow: hidden;
  font-size: 0.875rem;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-main .label {
  font-size: max(0.6875rem, 10px);
}

.row-time {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  font-size: max(0.75rem, 10.5px);
}

.row-time b {
  font-size: 0.875rem;
}

.row-actions {
  display: flex;
  grid-column: 1 / -1;
  gap: 0.25rem;
}
</style>
