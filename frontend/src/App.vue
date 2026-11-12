<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import CarPanel from './components/CarPanel.vue'
import CoachPanel from './components/CoachPanel.vue'
import AnalysisView from './components/AnalysisView.vue'
import ResultsPanel from './components/ResultsPanel.vue'
import CockpitPanel from './components/CockpitPanel.vue'
import RollingChart from './components/RollingChart.vue'
import TimingPanel from './components/TimingPanel.vue'
import TopBar from './components/TopBar.vue'
import TrackMap from './components/TrackMap.vue'
import { t } from './i18n'
import { startComparison } from './telemetry/comparison'
import { startSessions } from './telemetry/sessions'
import { connection, isLive, meta, viewMode } from './telemetry/store'
import { startStudy } from './telemetry/study'

startComparison()
startSessions()
startStudy()

type SideTab = 'coach' | 'results' | 'car'
const SIDE_TABS = [
  { id: 'coach', label: 'app.tabs.coach' },
  { id: 'results', label: 'app.tabs.results' },
  { id: 'car', label: 'app.tabs.car' },
] as const
const sideTab = ref<SideTab>('coach')

/** Arrow keys move between tabs, as in any tab list. */
function onTabKey(event: KeyboardEvent) {
  const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
  if (!step) return
  const index = SIDE_TABS.findIndex((tab) => tab.id === sideTab.value)
  const next = SIDE_TABS[(index + step + SIDE_TABS.length) % SIDE_TABS.length].id
  sideTab.value = next
  document.getElementById(`tab-${next}`)?.focus()
}

// With both hands on the controller nobody touches the Mac, and a sleeping display
// would take the telemetry with it.
let wakeLock: WakeLockSentinel | null = null

async function syncWakeLock() {
  if (isLive.value && !wakeLock && document.visibilityState === 'visible') {
    try {
      wakeLock = await navigator.wakeLock.request('screen')
      wakeLock.addEventListener('release', () => (wakeLock = null))
    } catch {
      // Not supported or refused: only the display's own sleep setting applies then.
    }
  } else if (!isLive.value && wakeLock) {
    void wakeLock.release()
  }
}

watch(isLive, syncWakeLock)
onMounted(() => document.addEventListener('visibilitychange', syncWakeLock))
onBeforeUnmount(() => document.removeEventListener('visibilitychange', syncWakeLock))

const notice = computed(() => {
  if (connection.value === 'closed') {
    return { title: t('app.disconnected.title'), steps: [t('app.disconnected.step')] }
  }
  const warning = meta.value?.warning
  if (warning) {
    const text =
      warning.code === 'format'
        ? t('warning.format', { format: warning.format, supported: 2025 })
        : t('warning.packetSize', { packet: warning.packet, size: warning.size, expected: warning.expected })
    return { title: t('app.badData.title'), steps: [text] }
  }
  if (!isLive.value && meta.value) {
    const { ip, port } = meta.value.udp
    return {
      title: t('app.waiting.title'),
      steps: [
        t('app.waiting.step'),
        t('app.waiting.settings', { ip: ip ?? t('app.waiting.thisPc'), port }),
        t('app.waiting.firewall'),
      ],
    }
  }
  return null
})
</script>

<template>
  <div class="app">
    <TopBar />
    <AnalysisView v-if="viewMode === 'study'" />
    <main v-else class="panels" :class="{ stale: !isLive }">
      <TrackMap class="map" />
      <CockpitPanel class="cockpit" />
      <div class="side">
        <div class="tabs" role="tablist" :aria-label="t('app.tabs.label')" @keydown="onTabKey">
          <button
            v-for="tab in SIDE_TABS"
            :id="`tab-${tab.id}`"
            :key="tab.id"
            type="button"
            role="tab"
            :aria-selected="sideTab === tab.id"
            :aria-controls="`panel-${tab.id}`"
            :tabindex="sideTab === tab.id ? 0 : -1"
            @click="sideTab = tab.id"
          >
            {{ t(tab.label) }}
          </button>
        </div>
        <CoachPanel v-show="sideTab === 'coach'" id="panel-coach" role="tabpanel" aria-labelledby="tab-coach" class="side-panel" />
        <ResultsPanel v-show="sideTab === 'results'" id="panel-results" role="tabpanel" aria-labelledby="tab-results" class="side-panel" />
        <CarPanel v-show="sideTab === 'car'" id="panel-car" role="tabpanel" aria-labelledby="tab-car" class="side-panel" />
      </div>
      <TimingPanel class="timing" />
      <RollingChart class="chart" />
      <div v-if="notice" class="notice" role="status">
        <b>{{ notice.title }}</b>
        <p v-for="step in notice.steps" :key="step">{{ step }}</p>
      </div>
    </main>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.panels {
  position: relative;
  flex: 1;
  display: grid;
  grid-template-columns: 1.15fr 1.05fr 1fr 0.95fr;
  grid-template-rows: minmax(0, 1fr) 24rem;
  gap: 0.625rem;
  min-height: 0;
  padding: 0 0.625rem 0.625rem;
}

.chart {
  grid-column: 1 / -1;
}

.side {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 0;
  min-height: 0;
}

.side-panel {
  flex: 1;
  min-height: 0;
}

.tabs {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.25rem;
}

.tabs button {
  height: 2rem;
  border: 0;
  border-radius: 0.5rem;
  background: var(--card);
  color: var(--text-3);
  font: inherit;
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
}

.tabs button[aria-selected='true'] {
  background: var(--card-raised);
  color: var(--text);
}

/* Only panels of live data dim without a game; saved drives and the coach stay fully readable. */
.stale > :not(.notice, .map, .side) {
  opacity: 0.55;
}

.notice {
  position: absolute;
  left: 50%;
  bottom: 7.5rem;
  transform: translateX(-50%);
  max-width: 62rem;
  padding: 1rem 1.5rem;
  border: 1px solid var(--hairline);
  border-radius: 0.75rem;
  background: var(--bg);
  text-align: center;
}

.notice b {
  font-size: 1.125rem;
}

.notice p {
  margin: 0.375rem 0 0;
  color: var(--text-2);
  font-size: 0.9375rem;
}
</style>
