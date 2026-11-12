<script setup lang="ts">
import { computed } from 'vue'
import type { Level } from '../telemetry/analysis'
import {
  LEAD_OPTIONS, analysis, availableDrivers, brakeMode, comparedTrack, leadSeconds, referenceError, referenceLap,
  referenceYear, selectedDriver, testVoice, toggleVoice, voiceState,
} from '../telemetry/comparison'
import { t } from '../i18n'
import { formatLapTime } from '../telemetry/format'
import { trackName } from '../telemetry/trackNames'
import { alignment, tick } from '../telemetry/store'

const MAX_ROWS = 6

const driverCode = computed({
  get: () => selectedDriver.value?.code ?? '',
  set: (code: string) => {
    selectedDriver.value = availableDrivers.value.find((d) => d.code === code) ?? null
  },
})

const totalLoss = computed(() => {
  const a = analysis.value
  const driver = selectedDriver.value
  return a && driver ? (a.lapMs - driver.lapMs) / 1000 : null
})

const rows = computed(() => {
  const a = analysis.value
  if (!a) return []
  const measured = a.corners.filter((corner) => corner.lossS !== null)
  const largest = Math.max(0.1, ...measured.map((corner) => Math.max(0, corner.lossS!)))
  return [...measured]
    .sort((x, y) => y.excessS! - x.excessS!)
    .slice(0, MAX_ROWS)
    .map((corner) => ({
      label: corner.label,
      loss: corner.lossS!,
      width: `${(Math.max(0, corner.lossS!) / largest) * 100}%`,
      isWorst: a.worst.includes(corner),
      chips: corner.chips.slice(0, 3),
    }))
})

const hasCorners = computed(() => (comparedTrack.value?.corners.length ?? 0) > 0)
const voiceLabel = computed(() => {
  switch (voiceState.value) {
    case 'on':
      return t('coach.voice.on')
    case 'loading':
      return t('coach.voice.loading')
    case 'error':
      return t('coach.voice.error')
    default:
      return t('coach.voice.off')
  }
})
const alignmentNote = computed(() => {
  if (!tick.value?.lap || !alignment.value) return ''
  return alignment.value.fitted
    ? t('coach.aligned', { m: Math.max(1, Math.round(alignment.value.rmsM)) })
    : t('coach.aligning')
})
const levelIcon: Record<Level, string> = { bad: '●', warn: '▲', ok: '✓' }
const signed = (value: number) => `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}`
</script>

<template>
  <section class="card coach">
    <template v-if="availableDrivers.length && hasCorners">
      <p v-if="referenceError" class="error" role="alert">▲ {{ t('coach.refError') }}</p>
      <label class="driver">
        <span class="label">{{ t('coach.comparingWith') }}</span>
        <select v-model="driverCode" :aria-label="t('study.real')">
          <option v-for="driver in availableDrivers" :key="driver.code" :value="driver.code">
            {{ driver.name }} · {{ formatLapTime(driver.lapMs) }}
          </option>
        </select>
      </label>
      <div v-if="selectedDriver" class="driver-meta">
        <i :style="{ background: selectedDriver.color }"></i>
        {{ t('coach.driverMeta', { team: selectedDriver.team, year: referenceYear ?? '', lap: selectedDriver.lap }) }}
      </div>

      <div class="voice">
        <button type="button" class="voice-toggle" :class="voiceState" :aria-pressed="voiceState === 'on'" @click="toggleVoice">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 9v6h4l5 4V5L8 9H4z" />
            <path v-if="voiceState === 'on'" d="M16.5 8.5a5 5 0 0 1 0 7" />
            <path v-else d="M17 9.5l4 5M21 9.5l-4 5" />
          </svg>
          {{ voiceLabel }}
        </button>
        <div class="voice-test" role="group" :aria-label="t('coach.voice.test')">
          <button type="button" :disabled="voiceState !== 'on'" @click="testVoice('brake')">{{ t('cue.brake') }}</button>
          <button type="button" :disabled="voiceState !== 'on'" @click="testVoice('turn')">{{ t('cue.turn') }}</button>
          <button type="button" :disabled="voiceState !== 'on'" @click="testVoice('throttle')">{{ t('cue.throttle') }}</button>
        </div>
        <label>
          <span class="label">{{ t('coach.brakeBy') }}</span>
          <select v-model="brakeMode">
            <option value="driver">{{ t('coach.brakeBy.driver') }}</option>
            <option value="car">{{ t('coach.brakeBy.car') }}</option>
          </select>
        </label>
        <label>
          <span class="label">{{ t('coach.lead') }}</span>
          <select v-model.number="leadSeconds">
            <option v-for="lead in LEAD_OPTIONS" :key="lead" :value="lead">{{ lead.toFixed(1) }} s</option>
          </select>
        </label>
      </div>

      <div class="loss-head">
        <span class="card-title">{{ t('coach.whereYouLose') }}</span>
        <span v-if="analysis && totalLoss !== null" class="num total">
          {{ t('coach.lapSummary', { lap: analysis.lap, time: formatLapTime(analysis.lapMs), gap: signed(totalLoss) }) }}
        </span>
      </div>

      <ol v-if="rows.length" class="rows">
        <li v-for="row in rows" :key="row.label" :class="{ worst: row.isWorst }">
          <div class="row-head">
            <b class="corner num">T{{ row.label }}</b>
            <div class="bar"><div :style="{ width: row.width }"></div></div>
            <span class="loss num">{{ signed(row.loss) }} s</span>
          </div>
          <div class="chips">
            <span v-for="chip in row.chips" :key="chip.key" class="chip" :class="chip.level">{{ levelIcon[chip.level] }} {{ t(chip.key, chip.params) }}</span>
          </div>
        </li>
      </ol>
      <p v-else class="empty">{{ t('coach.empty') }}</p>

      <p class="note">
        {{ t('coach.note') }} {{ alignmentNote }} {{ t('coach.source') }}
      </p>
    </template>

    <p v-else-if="referenceError" class="empty">{{ t('coach.refError') }}</p>
    <p v-else-if="comparedTrack" class="empty">{{ t('coach.noRef', { track: trackName(comparedTrack) }) }}</p>
    <p v-else class="empty">{{ t('coach.pick') }}</p>

    <span v-if="referenceLap === null && availableDrivers.length && !referenceError" class="sr-only" role="status">{{ t('coach.loadingDriver') }}</span>
  </section>
</template>

<style scoped>
.coach {
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
  height: 100%;
  padding: 0.75rem 0.875rem;
  overflow: hidden;
}

.driver {
  display: grid;
  gap: 0.25rem;
}

select,
button {
  height: 2rem;
  padding: 0 0.5rem;
  border: 1px solid var(--control-border);
  border-radius: 0.5rem;
  background: var(--card-raised);
  color: var(--text);
  font: inherit;
  font-size: 0.8125rem;
  font-weight: 500;
  cursor: pointer;
}

select {
  width: 100%;
  min-width: 0;
}

button:disabled {
  color: var(--text-3);
  cursor: default;
}

.driver-meta {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  color: var(--text-2);
  font-size: max(0.75rem, 10.5px);
}

.driver-meta i {
  flex: none;
  width: 0.625rem;
  height: 0.625rem;
  border-radius: 50%;
}

.voice {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.375rem 0.5rem;
  padding: 0.5rem 0;
  border-block: 1px solid var(--hairline);
}

.voice label {
  display: grid;
  gap: 0.125rem;
  min-width: 0;
}

.voice-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  white-space: nowrap;
}

.voice-toggle.on {
  border-color: var(--throttle);
}

.voice-toggle.error {
  border-color: var(--brake);
}

.voice-toggle svg {
  flex: none;
  width: 1.125rem;
  height: 1.125rem;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.voice-test {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.25rem;
}

.voice-test button {
  padding: 0;
  font-size: max(0.75rem, 10.5px);
}

.loss-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
  white-space: nowrap;
}

.total {
  color: var(--text-2);
  font-size: max(0.75rem, 10.5px);
}

.rows {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  min-height: 0;
  margin: 0;
  padding: 0;
  overflow: hidden;
  list-style: none;
}

.row-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.corner {
  width: 2.25rem;
  font-size: 0.9375rem;
  font-weight: 700;
}

.bar {
  flex: 1;
  height: 0.375rem;
  border-radius: 0.1875rem;
  background: var(--card-raised);
}

.bar div {
  height: 100%;
  border-radius: 0.1875rem;
  background: var(--text-3);
}

.worst .bar div {
  background: var(--warn);
}

.loss {
  min-width: 4rem;
  font-size: 0.875rem;
  font-weight: 600;
  text-align: right;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.0625rem 0.625rem;
  margin-left: 2.75rem;
  color: var(--text-2);
  font-size: max(0.75rem, 10.5px);
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

.error {
  margin: 0;
  color: var(--bad-text);
  font-size: 0.8125rem;
}

.empty {
  flex: 1;
  margin: 0;
  color: var(--text-2);
  font-size: 0.875rem;
}

.note {
  margin: 0;
  color: var(--text-3);
  font-size: max(0.6875rem, 10px);
  line-height: 1.3;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
</style>
