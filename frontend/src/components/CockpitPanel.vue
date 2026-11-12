<script setup lang="ts">
import { computed } from 'vue'
import { flagInfo, safetyCarName } from '../data/gameTables'
import { t } from '../i18n'
import { activeCue } from '../telemetry/comparison'
import { tick } from '../telemetry/store'
import GForce from './GForce.vue'

const CUE_TEXT = { brake: 'cue.flash.brake', turn: 'cue.flash.turn', throttle: 'cue.flash.throttle' } as const

const car = computed(() => tick.value?.car ?? null)
const status = computed(() => tick.value?.status ?? null)

// The game's 15 rev lights, coloured the way the in-game wheel shows them.
const leds = computed(() =>
  Array.from({ length: 15 }, (_, i) => ({
    on: ((car.value?.rev_lights ?? 0) >> i) & 1,
    color: i < 5 ? 'var(--throttle)' : i < 10 ? 'var(--brake)' : '#7f6bff',
  })),
)

const gear = computed(() => {
  const value = car.value?.gear
  if (value === undefined) return '—'
  return value === -1 ? 'R' : value === 0 ? 'N' : String(value)
})

const rpmPercent = computed(() => {
  const max = status.value?.max_rpm || 15000
  return Math.min(100, ((car.value?.rpm ?? 0) / max) * 100)
})

const throttle = computed(() => Math.round((car.value?.throttle ?? 0) * 100))
const brake = computed(() => Math.round((car.value?.brake ?? 0) * 100))

// Half of the bar's width on each side, so the centre stays at straight ahead.
const steer = computed(() => {
  const value = Math.max(-1, Math.min(1, car.value?.steer ?? 0))
  return { left: value < 0 ? 50 + value * 50 : 50, width: Math.abs(value) * 50, value }
})

const drs = computed(() => {
  if (car.value?.drs) return { text: t('cockpit.drs.open'), kind: 'on' }
  if (status.value?.drs_allowed) return { text: t('cockpit.drs.available'), kind: 'ready' }
  if (status.value?.drs_distance) return { text: t('cockpit.drs.in', { m: status.value.drs_distance }), kind: '' }
  return { text: 'DRS', kind: 'off' }
})

const flag = computed(() => flagInfo(status.value?.fia_flag))
const safetyCar = computed(() => safetyCarName(tick.value?.safetyCar ?? 0))
</script>

<template>
  <section class="card cockpit">
    <div class="leds" role="img" :aria-label="t('cockpit.revs', { percent: car?.rev_percent ?? 0 })">
      <i v-for="(led, i) in leds" :key="i" :style="led.on ? { background: led.color, boxShadow: `0 0 0.5rem ${led.color}` } : undefined"></i>
    </div>

    <div class="main">
      <div v-if="activeCue" class="cue" :class="activeCue.kind" role="status">{{ t(CUE_TEXT[activeCue.kind]) }} <small>T{{ activeCue.corner }}</small></div>
      <div class="speed">
        <div class="speed-value num" :class="{ waiting: !car }">{{ car?.speed ?? '—' }}</div>
        <div class="label">km/h</div>
      </div>
      <div class="gear">
        <div class="gear-value" :class="{ waiting: !car }">{{ gear }}</div>
        <div class="label">{{ t('cockpit.gear') }}</div>
      </div>
    </div>

    <div class="rpm">
      <div class="track"><div class="fill" :style="{ width: `${rpmPercent}%` }"></div></div>
      <div class="rpm-text num">{{ car?.rpm ?? '—' }} <span class="label">{{ t('cockpit.rpm') }}</span></div>
    </div>

    <div class="controls">
      <div class="steering">
        <div class="row"><span class="label">{{ t('cockpit.steering') }}</span><span class="num steer-value">{{ steer.value >= 0 ? '+' : '−' }}{{ Math.abs(steer.value).toFixed(2) }}</span></div>
        <div class="steer">
          <div class="steer-fill" :style="{ left: `${steer.left}%`, width: `${steer.width}%` }"></div>
          <i></i>
        </div>
      </div>
      <div class="pills">
        <span class="pill" :class="drs.kind">{{ drs.text }}</span>
        <span v-if="status?.pit_limiter" class="pill warn">{{ t('cockpit.pitLimiter') }}</span>
        <span v-if="flag" class="pill"><i :style="{ background: flag.color }"></i>{{ flag.name }}</span>
        <span v-if="safetyCar" class="pill warn">{{ safetyCar }}</span>
      </div>
    </div>

    <div class="lower">
      <div class="pedals">
        <div class="pedal">
          <div class="pedal-track"><div class="pedal-fill brake" :style="{ height: `${brake}%` }"></div></div>
          <div class="num pedal-value">{{ brake }} %</div>
          <div class="label">{{ t('cockpit.brake') }}</div>
        </div>
        <div class="pedal">
          <div class="pedal-track"><div class="pedal-fill throttle" :style="{ height: `${throttle}%` }"></div></div>
          <div class="num pedal-value">{{ throttle }} %</div>
          <div class="label">{{ t('cockpit.throttle') }}</div>
        </div>
      </div>
      <GForce class="gforce" />
    </div>
  </section>
</template>

<style scoped>
.cockpit {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0.875rem 1rem;
}

.cue {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  border-radius: 0.75rem;
  color: #07150d;
  /* Sized to the row, so the longest word (THROTTLE T12) fits in any language and window. */
  font-size: min(4.5rem, 11cqi);
  font-weight: 800;
  line-height: 1;
  white-space: nowrap;
  overflow: hidden;
}

.cue small {
  font-size: 1.5rem;
  font-weight: 700;
}

.cue.brake {
  background: var(--brake);
  color: #fff;
}

.cue.turn {
  background: var(--warn);
}

.cue.throttle {
  background: var(--throttle);
}

.leds {
  display: grid;
  grid-template-columns: repeat(15, 1fr);
  gap: 0.25rem;
}

.leds i {
  height: 0.625rem;
  border-radius: 0.1875rem;
  background: var(--card-raised);
}

.main {
  position: relative;
  container-type: inline-size;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.25rem 0.25rem 0;
}

.speed-value {
  font-size: 8rem;
  font-weight: 800;
  line-height: 0.95;
  letter-spacing: -0.03em;
}

.waiting {
  color: var(--text-3);
  font-weight: 200;
}

.gear {
  flex: none;
  width: 8.5rem;
  padding: 0.25rem 0 0.5rem;
  border-radius: 0.75rem;
  background: var(--card-raised);
  text-align: center;
}

.gear-value {
  font-size: 7rem;
  font-weight: 800;
  line-height: 1;
  color: var(--you);
}

.rpm {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.track {
  flex: 1;
  height: 0.5rem;
  border-radius: 0.25rem;
  background: var(--card-raised);
}

.fill {
  height: 100%;
  border-radius: 0.25rem;
  background: var(--you);
}

.rpm-text {
  min-width: 7.5rem;
  font-weight: 600;
  text-align: right;
}

.controls {
  display: grid;
  grid-template-columns: 1fr 1fr;
  align-items: start;
  gap: 1.25rem;
}

.lower {
  flex: 1;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 1.25rem;
  min-height: 0;
}

.pedals {
  display: flex;
  gap: 0.75rem;
  min-height: 0;
}

.pedal {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
  width: 4rem;
  min-height: 0;
}

.pedal-track {
  flex: 1;
  position: relative;
  width: 2rem;
  min-height: 0;
  border-radius: 0.375rem;
  background: var(--card-raised);
  overflow: hidden;
}

.pedal-fill {
  position: absolute;
  inset: auto 0 0;
}

.pedal-fill.brake {
  background: var(--brake);
}

.pedal-fill.throttle {
  background: var(--throttle);
}

.pedal-value {
  font-size: 1.125rem;
  white-space: nowrap;
  font-weight: 700;
}

.row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 0.375rem;
}

.steer-value {
  font-weight: 600;
}

.steer {
  position: relative;
  height: 0.75rem;
  border-radius: 0.25rem;
  background: var(--card-raised);
}

.steer-fill {
  position: absolute;
  top: 0;
  bottom: 0;
  background: var(--you);
}

.steer i {
  position: absolute;
  top: -0.1875rem;
  bottom: -0.1875rem;
  left: 50%;
  width: 2px;
  margin-left: -1px;
  background: var(--text-2);
}

.pills {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.375rem;
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.2rem 0.5rem;
  border-radius: 0.375rem;
  background: var(--card-raised);
  color: var(--text-2);
  font-size: 0.8125rem;
  font-weight: 600;
  white-space: nowrap;
}

.pill i {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
}

.pill.off {
  color: var(--text-3);
}

.pill.ready {
  color: var(--text);
  box-shadow: inset 0 0 0 1px var(--throttle);
}

.pill.on {
  background: var(--throttle);
  color: #07150d;
}

.pill.warn {
  color: var(--warn);
  box-shadow: inset 0 0 0 1px var(--warn);
}
</style>
