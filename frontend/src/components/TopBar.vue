<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { formulaName, sessionName, teamInfo, weatherName } from '../data/gameTables'
import { LOCALES, locale, setLocale, t, type Locale } from '../i18n'
import { formatClock } from '../telemetry/format'
import { trackCountry, trackName } from '../telemetry/trackNames'
import {
  AUTO_TRACK, connection, diagnostics, gameTrack, isLive, lastDriveTrack, meta, selectedTrack, tick, tracks, viewMode,
} from '../telemetry/store'

const player = computed(() => meta.value?.player ?? null)
const session = computed(() => meta.value?.session ?? null)
const team = computed(() => (player.value ? teamInfo(player.value.teamId) : null))

const status = computed(() => {
  if (connection.value === 'connecting') return { text: t('top.status.connecting'), kind: 'idle' }
  if (connection.value !== 'open') return { text: t('top.status.disconnected'), kind: 'bad' }
  if (!isLive.value) return { text: t('top.status.waiting'), kind: 'idle' }
  if (tick.value?.paused) return { text: t('top.status.paused'), kind: 'idle' }
  return { text: t('top.status.live'), kind: 'live' }
})

// Longer than this reads as a freeze on screen.
const VISIBLE_GAP_MS = 200
// A steady 30 Hz is a fine choice on a busy network, so only less than that is flagged.
const LOW_RATE_HZ = 25

const link = computed(() => {
  const udp = tick.value?.udp
  if (!isLive.value || !udp || tick.value?.paused) return null
  const problems: string[] = []
  if (diagnostics.errors) problems.push(t('top.problem.appError', { error: diagnostics.lastError }))
  if (diagnostics.badMessages) problems.push(t('top.problem.badMessages', { count: diagnostics.badMessages }))
  // Checked in this order because a stalled page also looks like a late connection.
  if (udp.maxGapMs > VISIBLE_GAP_MS) problems.push(t('top.problem.gameGap', { ms: udp.maxGapMs }))
  if (diagnostics.pageStallMs > VISIBLE_GAP_MS) problems.push(t('top.problem.pageStall', { ms: diagnostics.pageStallMs }))
  else if (diagnostics.connectionGapMs > VISIBLE_GAP_MS && udp.maxGapMs <= VISIBLE_GAP_MS) {
    problems.push(t('top.problem.connectionGap', { ms: diagnostics.connectionGapMs }))
  }
  if (udp.hz < LOW_RATE_HZ && udp.hz > 0) problems.push(t('top.problem.lowRate'))
  return { hz: udp.hz, problems }
})

const autoLabel = computed(() => {
  if (gameTrack.value) return t('top.track.fromGame', { track: trackName(gameTrack.value) })
  if (lastDriveTrack.value) return t('top.track.lastDrive', { track: trackName(lastDriveTrack.value) })
  return t('top.track.auto')
})

const sessionLine = computed(() => {
  if (!session.value) return ''
  const parts = [sessionName(session.value.sessionType)]
  const left = tick.value?.timeLeft
  if (left && session.value.totalLaps <= 1) parts.push(t('top.timeLeft', { time: formatClock(left) }))
  return parts.join(' · ')
})

const isFullscreen = ref(false)
const syncFullscreen = () => (isFullscreen.value = document.fullscreenElement !== null)

function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen()
  else void document.documentElement.requestFullscreen()
}

function onKey(event: KeyboardEvent) {
  const target = event.target as HTMLElement
  if (event.key.toLowerCase() === 'f' && !event.repeat && !event.metaKey && !event.ctrlKey && target.tagName !== 'SELECT' && target.tagName !== 'INPUT') toggleFullscreen()
}

onMounted(() => {
  document.addEventListener('fullscreenchange', syncFullscreen)
  document.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', syncFullscreen)
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <header class="bar">
    <div class="brand">F1 <span>Tutor</span></div>

    <div class="status" :class="status.kind" role="status"><i></i>{{ status.text }}</div>

    <div v-if="link" class="link" :class="{ warn: link.problems.length }" :title="link.problems.join(' · ')">
      <span class="num">{{ t('top.link.rate', { hz: link.hz }) }}</span>
      <span v-if="link.problems.length" class="problem">▲ {{ link.problems[0] }}</span>
    </div>

    <div v-if="player" class="driver">
      <span class="stripe" :style="{ background: team?.color ?? 'var(--text-3)' }"></span>
      <span class="number num">{{ player.raceNumber }}</span>
      <div>
        <div class="name" :title="player.name">{{ player.name || t('top.player') }}</div>
        <div class="label">{{ team?.name }}<template v-if="session"> · {{ formulaName(session.formula) }}</template></div>
      </div>
    </div>

    <div v-if="session" class="session">
      <div class="item">
        <div class="value">{{ sessionLine }}</div>
        <div class="label">{{ t('top.session') }}</div>
      </div>
      <div class="item">
        <div class="value">{{ weatherName(session.weather) }}</div>
        <div class="label">{{ t('top.weather') }}</div>
      </div>
      <div class="item">
        <div class="value num">{{ session.trackTemp }} °C</div>
        <div class="label">{{ t('top.trackTemp') }}</div>
      </div>
      <div class="item">
        <div class="value num">{{ session.airTemp }} °C</div>
        <div class="label">{{ t('top.airTemp') }}</div>
      </div>
    </div>

    <div class="controls">
      <div class="mode" role="group" :aria-label="t('top.view.label')">
        <button type="button" :aria-pressed="viewMode === 'live'" @click="viewMode = 'live'">{{ t('top.view.live') }}</button>
        <button type="button" :aria-pressed="viewMode === 'study'" @click="viewMode = 'study'">{{ t('top.view.study') }}</button>
      </div>
      <label class="track-select">
        <span class="label">{{ t('top.track.label') }}</span>
        <select v-model="selectedTrack">
          <option :value="AUTO_TRACK">{{ autoLabel }}</option>
          <option v-for="track in tracks" :key="track.id" :value="String(track.id)">{{ trackName(track) }} · {{ trackCountry(track) }}</option>
        </select>
      </label>
      <label class="language">
        <span class="sr-only">{{ t('top.language') }}</span>
        <select :value="locale" :aria-label="t('top.language')" @change="setLocale(($event.target as HTMLSelectElement).value as Locale)">
          <option v-for="option in LOCALES" :key="option.code" :value="option.code">{{ option.label }}</option>
        </select>
      </label>
      <button type="button" :title="isFullscreen ? t('top.fullscreen.exitTitle') : t('top.fullscreen.enterTitle')" @click="toggleFullscreen">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path v-if="!isFullscreen" d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />
          <path v-else d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5" />
        </svg>
        {{ isFullscreen ? t('top.fullscreen.exit') : t('top.fullscreen.enter') }}
      </button>
    </div>
  </header>
</template>

<style scoped>
.bar {
  display: flex;
  align-items: center;
  gap: 1.5rem;
  height: 3.75rem;
  padding: 0 1rem;
}

.bar > * {
  min-width: 0;
}

.brand,
.status,
.controls {
  flex: none;
}

.brand {
  white-space: nowrap;
  font-size: 1.375rem;
  font-weight: 800;
  letter-spacing: -0.02em;
}

.brand span {
  color: var(--you);
}

.status {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.3rem 0.75rem;
  border-radius: 99rem;
  background: var(--card);
  color: var(--text-2);
  font-size: 0.875rem;
  font-weight: 600;
  white-space: nowrap;
}

.status i {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--text-3);
}

.status.live {
  color: var(--text);
}

.status.live i {
  background: var(--throttle);
  box-shadow: 0 0 0.5rem var(--throttle);
}

.status.bad i {
  background: var(--brake);
}

.link {
  display: flex;
  flex-shrink: 1;
  gap: 0.5rem;
  overflow: hidden;
  color: var(--text-3);
  font-size: 0.8125rem;
  white-space: nowrap;
}

.problem {
  overflow: hidden;
  text-overflow: ellipsis;
}

.link.warn .problem {
  color: var(--warn);
  font-weight: 600;
}

.driver {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.stripe {
  width: 0.25rem;
  height: 2.25rem;
  border-radius: 0.125rem;
}

.number {
  font-size: 1.75rem;
  font-weight: 800;
}

.driver > div {
  min-width: 0;
}

.name,
.driver .label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.name {
  font-size: 1rem;
  font-weight: 700;
}

.session {
  display: flex;
  flex-shrink: 2;
  overflow: hidden;
  gap: 1.5rem;
  padding-left: 1.5rem;
  border-left: 1px solid var(--hairline);
}

.session .item {
  min-width: 0;
}

.value {
  overflow: hidden;
  font-size: 0.9375rem;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.controls {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-left: auto;
}

.mode {
  display: flex;
  padding: 0.1875rem;
  border-radius: 0.625rem;
  background: var(--card);
}

.mode button {
  height: 1.875rem;
  border: 0;
  background: none;
  color: var(--text-3);
  font-weight: 600;
}

.mode button[aria-pressed='true'] {
  background: var(--card-raised);
  color: var(--text);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}

.track-select {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

select,
button {
  height: 2.25rem;
  padding: 0 0.75rem;
  border: 1px solid var(--control-border);
  border-radius: 0.5rem;
  background: var(--card);
  color: var(--text);
  font: inherit;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
}

select:hover,
button:hover {
  background: var(--card-raised);
}

select {
  max-width: 17rem;
}

button {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  white-space: nowrap;
}

svg {
  width: 1.125rem;
  height: 1.125rem;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
