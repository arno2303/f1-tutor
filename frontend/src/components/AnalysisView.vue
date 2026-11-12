<script setup lang="ts">
import { computed } from 'vue'
import type { Level } from '../telemetry/analysis'
import { t } from '../i18n'
import { formatDelta, formatLapTime } from '../telemetry/format'
import { trackName } from '../telemetry/trackNames'
import {
  choiceA, choiceB, compareKind, driverCode, drivers, hoverM, lapLabel, lapsOf, sources, study, studyError, studyLoading,
  studyTrack, zoom, type LapChoice, type SourceId,
} from '../telemetry/study'
import LapChart from './LapChart.vue'
import SavedTracks from './SavedTracks.vue'
import StudyMap from './StudyMap.vue'

/** Two selects bound to one lap choice: the drive, then its lap. */
function pickerFor(choice: typeof choiceA) {
  return {
    source: computed({
      get: () => (choice.value ? String(choice.value.source) : ''),
      set: (value: string) => {
        const source: SourceId = value === 'current' ? 'current' : Number(value)
        const rows = lapsOf(source)
        const best = rows.filter((r) => r.valid).sort((x, y) => x.ms - y.ms)[0] ?? rows[rows.length - 1]
        choice.value = { source, lap: best?.lap ?? 0 } as LapChoice
      },
    }),
    lap: computed({
      get: () => (choice.value ? String(choice.value.lap) : ''),
      set: (value: string) => {
        if (choice.value) choice.value = { ...choice.value, lap: Number(value) }
      },
    }),
  }
}

const pickA = pickerFor(choiceA)
const pickB = pickerFor(choiceB)
const driver = computed({
  get: () => driverCode.value ?? drivers.value[0]?.code ?? '',
  set: (code: string) => (driverCode.value = code),
})

const total = computed(() => {
  const s = study.value
  return s ? (s.a.lapMs - s.b.lapMs) / 1000 : null
})

const sectors = computed(() => {
  const s = study.value
  if (!s?.bRow) return []
  const delta = (x: number | null, y: number | null) => (x && y ? (x - y) / 1000 : null)
  return [
    { name: 'S1', delta: delta(s.aRow.s1, s.bRow.s1) },
    { name: 'S2', delta: delta(s.aRow.s2, s.bRow.s2) },
    { name: 'S3', delta: delta(s.aRow.s3, s.bRow.s3) },
  ]
})

// Against a real driver every corner loses, so the weakest are those losing most beyond the average.
const worstLabels = computed(() => {
  const measure = (r: { deltaS: number | null; excessS: number | null }) => (study.value?.bKind === 'real' ? r.excessS : r.deltaS)
  const rows = (study.value?.rows ?? []).filter((r) => (measure(r) ?? 0) > 0)
  return new Set([...rows].sort((x, y) => measure(y)! - measure(x)!).slice(0, 3).map((r) => r.label))
})

const hoveredLabel = computed(() => {
  const m = hoverM.value
  if (m === null) return null
  return study.value?.zones.find((z) => m >= z.startM && m < z.endM)?.label ?? null
})

function zoomTo(label: string) {
  const zone = study.value?.zones.find((z) => z.label === label)
  if (!zone || !study.value) return
  const from = Math.max(0, Math.min(zone.startM, zone.apexM - 250))
  const to = Math.min(study.value.lengthM, Math.max(zone.endM, zone.apexM + 200))
  zoom.value = { from, to }
}

/** Arrow keys move the choice, as in any radio group. */
function onCompareKey(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
  event.preventDefault()
  if (!drivers.value.length) return
  compareKind.value = compareKind.value === 'real' ? 'own' : 'real'
  const buttons = (event.currentTarget as HTMLElement).querySelectorAll('button')
  buttons[compareKind.value === 'real' ? 0 : 1]?.focus()
}

const kind = (value: number | null) => (value === null ? '' : value <= 0 ? 'gain' : 'loss')
const metres = (value: number | null) => (value === null ? '—' : `${value > 0 ? '+' : value < 0 ? '−' : '±'}${Math.round(Math.abs(value))} m`)
const kmh = (value: number | null) => (value === null ? '—' : `${value > 0 ? '+' : value < 0 ? '−' : '±'}${Math.round(Math.abs(value))}`)
const levelIcon: Record<Level, string> = { bad: '●', warn: '▲', ok: '✓' }
</script>

<template>
  <div class="study">
    <aside class="card side">
      <p v-if="studyError" class="error" role="alert">▲ {{ studyError }}</p>
      <template v-if="sources.length">
        <div class="picker">
          <span class="card-title">{{ t('study.analysedLap') }}</span>
          <select v-model="pickA.source.value" :aria-label="t('study.driveSelect')">
            <option v-for="source in sources" :key="source.id" :value="String(source.id)">{{ source.label }}</option>
          </select>
          <select v-model="pickA.lap.value" :aria-label="t('study.lapSelect')">
            <option v-for="row in lapsOf(choiceA?.source)" :key="row.lap" :value="String(row.lap)">{{ lapLabel(row) }}</option>
          </select>
        </div>

        <div class="picker">
          <span class="card-title">{{ t('study.compareWith') }}</span>
          <div class="segmented" role="radiogroup" :aria-label="t('study.compareWith')" @keydown="onCompareKey">
            <button
              type="button"
              role="radio"
              :aria-checked="compareKind === 'real'"
              :tabindex="compareKind === 'real' ? 0 : -1"
              :disabled="!drivers.length"
              @click="compareKind = 'real'"
            >
              {{ t('study.real') }}
            </button>
            <button type="button" role="radio" :aria-checked="compareKind === 'own'" :tabindex="compareKind === 'own' ? 0 : -1" @click="compareKind = 'own'">
              {{ t('study.own') }}
            </button>
          </div>
          <select v-if="compareKind === 'real'" v-model="driver" :aria-label="t('study.real')">
            <option v-for="d in drivers" :key="d.code" :value="d.code">{{ d.name }} · {{ formatLapTime(d.lapMs) }}</option>
          </select>
          <template v-else>
            <select v-model="pickB.source.value" :aria-label="t('study.compareDrive')">
              <option v-for="source in sources" :key="source.id" :value="String(source.id)">{{ source.label }}</option>
            </select>
            <select v-model="pickB.lap.value" :aria-label="t('study.compareLap')">
              <option
                v-for="row in lapsOf(choiceB?.source)"
                :key="row.lap"
                :value="String(row.lap)"
                :disabled="choiceB?.source === choiceA?.source && row.lap === choiceA?.lap"
              >
                {{ lapLabel(row) }}
              </option>
            </select>
          </template>
          <p v-if="!drivers.length" class="label">{{ t('study.noReal') }}</p>
        </div>

        <div v-if="study" class="summary">
          <div class="times num">
            <span><i style="background: var(--you)"></i>{{ formatLapTime(study.a.lapMs) }}</span>
            <span><i :style="{ background: study.bKind === 'real' ? 'var(--ref)' : 'var(--best)' }"></i>{{ formatLapTime(study.b.lapMs) }}</span>
            <b :class="kind(total)">{{ formatDelta(total) }} s</b>
          </div>
          <div v-if="sectors.length" class="sectors num">
            <span v-for="sector in sectors" :key="sector.name"><span class="label">{{ sector.name }}</span> <b :class="kind(sector.delta)">{{ formatDelta(sector.delta) }}</b></span>
          </div>
        </div>


        <div v-if="study" class="table">
          <div class="row header">
            <span>{{ t('study.col.corner') }}</span><span>{{ t('study.col.time') }}</span><span>{{ t('study.col.brake') }}</span><span>{{ t('study.col.min') }}</span>
          </div>
          <ol>
            <li
              v-for="row in study.rows"
              :key="row.label"
              :class="{ worst: worstLabels.has(row.label), hovered: hoveredLabel === row.label }"
            >
              <button type="button" class="row" :title="t('study.zoomCorner', { corner: row.label })" @click="zoomTo(row.label)">
                <b>T{{ row.label }}</b>
                <span class="num" :class="kind(row.deltaS)">{{ formatDelta(row.deltaS, 2) }}</span>
                <span class="num">{{ metres(row.brakeDeltaM) }}</span>
                <span class="num">{{ kmh(row.minSpeedDeltaKmh) }}</span>
              </button>
              <div class="chips">
                <span v-for="chip in row.chips.slice(0, 2)" :key="chip.key" class="chip" :class="chip.level">{{ levelIcon[chip.level] }} {{ t(chip.key, chip.params) }}</span>
              </div>
            </li>
          </ol>
        </div>
        <p class="note">
          {{ study?.bKind === 'real' ? t('study.noteReal') : t('study.note') }}
        </p>
      </template>
      <template v-else>
        <p class="empty">
          <template v-if="studyTrack">{{ t('study.noLaps', { track: trackName(studyTrack) }) }}</template>
          <template v-else>{{ t('study.pickTrack') }}</template>
        </p>
        <SavedTracks :except-id="studyTrack?.id" />
      </template>
    </aside>

    <StudyMap v-if="study" class="map" />
    <LapChart v-if="study" class="chart" />
    <div v-if="!study" class="card placeholder">
      <p>{{ studyLoading ? t('study.loading') : studyError ? studyError : t('study.pickLap') }}</p>
    </div>
  </div>
</template>

<style scoped>
.study {
  flex: 1;
  display: grid;
  grid-template-columns: 27rem minmax(0, 1fr);
  grid-template-rows: minmax(0, 0.42fr) minmax(0, 1fr);
  gap: 0.625rem;
  min-height: 0;
  padding: 0 0.625rem 0.625rem;
}

.side {
  grid-row: 1 / -1;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0.875rem 1rem;
  overflow: hidden;
}

.placeholder {
  grid-row: 1 / -1;
  display: grid;
  place-items: center;
  color: var(--text-2);
}

.picker {
  display: grid;
  gap: 0.375rem;
}

select,
.segmented button {
  height: 2rem;
  padding: 0 0.5rem;
  border: 1px solid var(--control-border);
  border-radius: 0.5rem;
  background: var(--card-raised);
  color: var(--text);
  font: inherit;
  font-size: 0.8125rem;
}

select {
  width: 100%;
}

.segmented {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.25rem;
}

.segmented button {
  color: var(--text-3);
  font-weight: 600;
  cursor: pointer;
}

.segmented button[aria-checked='true'] {
  border-color: var(--you);
  color: var(--text);
}

.segmented button:disabled {
  cursor: default;
  opacity: 0.5;
}

.summary {
  display: grid;
  gap: 0.375rem;
  padding: 0.625rem 0;
  border-block: 1px solid var(--hairline);
}

.times {
  display: flex;
  align-items: baseline;
  gap: 1rem;
  font-size: 0.9375rem;
  font-weight: 600;
}

.times span {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}

.times i {
  width: 1rem;
  height: 2px;
}

.times b {
  margin-left: auto;
  font-size: 1.375rem;
}

.sectors {
  display: flex;
  justify-content: space-between;
  font-size: 0.8125rem;
}

.gain {
  color: var(--throttle);
}

.loss {
  color: var(--bad-text);
}

.error {
  margin: 0;
  color: var(--bad-text);
  font-size: 0.8125rem;
}

.table {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.table ol {
  flex: 1;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.row {
  display: grid;
  grid-template-columns: 3rem 1fr 1fr 1fr;
  align-items: baseline;
  width: 100%;
  padding: 0.25rem 0.375rem;
  border: 0;
  background: none;
  color: var(--text);
  font: inherit;
  font-size: 0.8125rem;
  text-align: right;
  cursor: pointer;
}

.row > :first-child {
  text-align: left;
}

.row:focus-visible {
  outline-offset: -2px;
}

.row.header {
  color: var(--text-3);
  font-size: max(0.75rem, 10.5px);
  cursor: default;
}

li {
  border-radius: 0.375rem;
}

li.hovered {
  background: var(--card-raised);
}

li.worst .row b {
  box-shadow: 0 2px 0 var(--warn);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0 0.625rem;
  padding: 0 0.375rem 0.25rem 3.375rem;
  color: var(--text-2);
  font-size: max(0.6875rem, 10px);
}

.chip.bad::first-letter {
  color: var(--brake);
}

.chip.warn::first-letter {
  color: var(--warn);
}

.chip.ok::first-letter {
  color: var(--throttle);
}

.note {
  margin: 0;
  color: var(--text-3);
  font-size: max(0.6875rem, 10px);
  line-height: 1.3;
}

.empty {
  margin: 0;
  color: var(--text-2);
  font-size: 0.875rem;
}
</style>
