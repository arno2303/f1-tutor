<script setup lang="ts">
import { computed } from 'vue'
import { t } from '../i18n'
import { formatDelta, formatLapTime, formatSector } from '../telemetry/format'
import { savedLap } from '../telemetry/sessions'
import { lapsVersion, meta, recorder, tick } from '../telemetry/store'

const lap = computed(() => tick.value?.lap ?? null)
const totalLaps = computed(() => meta.value?.session?.totalLaps ?? 0)

const delta = computed(() => {
  if (!lap.value || lap.value.lap_distance < 0) return null
  return recorder.deltaAt(lap.value.lap_distance, savedLap.value?.trace ?? recorder.best)
})
const deltaKind = computed(() => (delta.value === null ? '' : delta.value <= 0 ? 'gain' : 'loss'))

const bestLap = computed(() => {
  void lapsVersion.value
  return recorder.bestLap
})

const lapRows = computed(() => {
  void lapsVersion.value
  const best = recorder.bestLap
  return [...recorder.laps]
    .reverse()
    .map((row) => ({ ...row, isBest: row === best, gap: best && row.valid ? (row.ms - best.ms) / 1000 : null }))
})

const sectors = computed(() => {
  void lapsVersion.value
  const current = lap.value
  const s1 = current && current.sector1_ms + current.sector1_min > 0 ? current.sector1_min * 60000 + current.sector1_ms : null
  const s2 = current && current.sector2_ms + current.sector2_min > 0 ? current.sector2_min * 60000 + current.sector2_ms : null
  const describe = (name: string, value: number | null, best: number | null, active: boolean) => ({
    name,
    value,
    active,
    best,
    gap: value !== null && best !== null ? (value - best) / 1000 : null,
    kind: value === null ? '' : best === null || value <= best ? 'fast' : 'slow',
  })
  return [
    describe(t('timing.sector', { n: 1 }), s1, recorder.bestSector('s1'), current?.sector === 0),
    describe(t('timing.sector', { n: 2 }), s2, recorder.bestSector('s2'), current?.sector === 1),
    describe(t('timing.sector', { n: 3 }), null, recorder.bestSector('s3'), current?.sector === 2),
  ]
})
</script>

<template>
  <section class="card timing">
    <div class="head">
      <div class="lap-count">
        <span class="label">{{ t('timing.lap') }}</span>
        <b class="num">{{ lap?.lap_num ?? '—' }}<small v-if="totalLaps > 1"> / {{ totalLaps }}</small></b>
      </div>
      <div class="lap-count right">
        <span class="label">{{ t('timing.position') }}</span>
        <b class="num">{{ lap?.position ? `P${lap.position}` : '—' }}</b>
      </div>
    </div>

    <div class="current">
      <div class="time num" :class="{ waiting: !lap }">{{ formatLapTime(lap?.current_lap_ms) }}</div>
      <div class="status-row">
        <div class="delta num" :class="deltaKind">
          {{ formatDelta(delta) }}<span class="label">&nbsp;{{ savedLap ? t('timing.vsSaved') : t('timing.vsBest') }}</span>
        </div>
        <span v-if="lap?.lap_invalid" class="invalid" role="status">{{ t('timing.invalid') }}</span>
      </div>
    </div>

    <div class="sectors">
      <div v-for="sector in sectors" :key="sector.name" class="sector" :class="[sector.kind, { active: sector.active }]">
        <div class="label">{{ sector.name }}</div>
        <div class="sector-time num">{{ formatSector(sector.value) }}</div>
        <div class="sector-sub num">
          <template v-if="sector.gap !== null">{{ formatDelta(sector.gap) }}</template>
          <template v-else-if="sector.best !== null">{{ t('timing.bestSector', { time: formatSector(sector.best) }) }}</template>
          <template v-else>&nbsp;</template>
        </div>
      </div>
    </div>

    <div class="summary">
      <div><span class="label">{{ t('timing.lastLap') }}</span><b class="num">{{ formatLapTime(lap?.last_lap_ms) }}</b></div>
      <div><span class="label">{{ t('timing.bestLap') }}</span><b class="num">{{ formatLapTime(bestLap?.ms) }}</b></div>
      <div v-if="lap?.penalties_s"><span class="label">{{ t('timing.penalties') }}</span><b class="num">{{ lap.penalties_s }} s</b></div>
      <div v-if="lap?.warnings"><span class="label">{{ t('timing.warnings') }}</span><b class="num">{{ lap.warnings }}</b></div>
    </div>

    <div class="table-wrap">
      <table class="num">
        <thead>
          <tr><th>{{ t('timing.col.lap') }}</th><th>{{ t('timing.col.time') }}</th><th>S1</th><th>S2</th><th>S3</th><th>{{ t('timing.col.gap') }}</th></tr>
        </thead>
        <tbody>
          <tr v-for="row in lapRows" :key="row.lap" :class="{ best: row.isBest, invalid: !row.valid }">
            <td>{{ row.lap }}</td>
            <td class="strong">{{ formatLapTime(row.ms) }}</td>
            <td>{{ formatSector(row.s1) }}</td>
            <td>{{ formatSector(row.s2) }}</td>
            <td>{{ formatSector(row.s3) }}</td>
            <td>
              <template v-if="!row.valid">{{ t('timing.row.invalid') }}</template>
              <template v-else-if="row.isBest">{{ t('timing.row.best') }}</template>
              <template v-else>{{ formatDelta(row.gap) }}</template>
            </td>
          </tr>
          <tr v-if="!lapRows.length"><td colspan="6" class="empty">{{ t('timing.empty') }}</td></tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.timing {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0.875rem 1rem;
}

.head,
.summary {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
}

.lap-count,
.summary > div {
  display: flex;
  flex-direction: column;
  gap: 0.0625rem;
}

.right {
  text-align: right;
}

.lap-count b {
  font-size: 1.5rem;
  font-weight: 800;
  line-height: 1.1;
}

small {
  color: var(--text-3);
  font-size: 1rem;
  font-weight: 500;
}

.time {
  font-size: 4.25rem;
  font-weight: 800;
  line-height: 1;
  letter-spacing: -0.025em;
}

.waiting {
  color: var(--text-3);
  font-weight: 200;
}

.status-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
  margin-top: 0.375rem;
}

.delta {
  font-size: 1.25rem;
  font-weight: 700;
  white-space: nowrap;
}

.delta .label {
  font-weight: 500;
}

.delta.gain {
  color: var(--throttle);
}

.delta.loss {
  color: var(--bad-text);
}

.invalid {
  color: var(--bad-text);
  font-size: 0.875rem;
  font-weight: 700;
  white-space: nowrap;
}

.sectors {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.375rem;
}

.sector {
  padding: 0.5rem 0.625rem;
  border-top: 0.1875rem solid var(--hairline);
  border-radius: 0.375rem;
  background: var(--card-raised);
}

.sector.active {
  border-top-color: var(--text);
}

.sector.fast {
  border-top-color: var(--throttle);
}

.sector.slow {
  border-top-color: var(--warn);
}

.sector-time {
  font-size: 1.25rem;
  font-weight: 700;
}

.sector-sub {
  min-height: 1rem;
  color: var(--text-2);
  font-size: max(0.75rem, 10.5px);
}

.summary b {
  font-size: 1.25rem;
  font-weight: 700;
}

.table-wrap {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  border-top: 1px solid var(--hairline);
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8125rem;
}

th {
  padding: 0.375rem 0.25rem;
  color: var(--text-3);
  font-weight: 500;
  text-align: right;
}

td {
  padding: 0.25rem;
  color: var(--text-2);
  text-align: right;
  white-space: nowrap;
}

th:first-child,
td:first-child {
  text-align: left;
}

td.strong {
  color: var(--text);
  font-weight: 600;
}

tr.best td {
  background: var(--card-raised);
  color: var(--text);
}

tr.best td:first-child {
  box-shadow: inset 0.1875rem 0 0 var(--you);
  padding-left: 0.5rem;
}

tr.invalid td {
  color: var(--text-3);
}

tr.invalid td.strong {
  color: var(--text-3);
  font-weight: 500;
  text-decoration: line-through;
}

.empty {
  padding: 0.75rem 0;
  color: var(--text-3);
  text-align: center;
}
</style>
