<script setup lang="ts">
import { computed } from 'vue'
import { actualCompoundName, compoundInfo, ersModeName, fuelMixName, hasErs } from '../data/gameTables'
import { t, tn, type MessageKey } from '../i18n'
import { meta, tick } from '../telemetry/store'

const ERS_CAPACITY_J = 4_000_000
// Wheel indexes in the packets are RL, RR, FL, FR; shown as seen from above.
const WHEELS: { index: number; name: MessageKey }[] = [
  { index: 2, name: 'car.wheel.fl' },
  { index: 3, name: 'car.wheel.fr' },
  { index: 0, name: 'car.wheel.rl' },
  { index: 1, name: 'car.wheel.rr' },
]

// A general guide to the working range, not the exact window of each compound.
function tyreState(surface: number) {
  if (surface < 75) return { text: t('car.tyre.cold'), color: 'var(--ref)' }
  if (surface <= 110) return { text: t('car.tyre.window'), color: 'var(--throttle)' }
  if (surface <= 125) return { text: t('car.tyre.warm'), color: 'var(--warn)' }
  return { text: t('car.tyre.hot'), color: 'var(--brake)' }
}

const car = computed(() => tick.value?.car ?? null)
const status = computed(() => tick.value?.status ?? null)
const damage = computed(() => tick.value?.damage ?? null)

const tyres = computed(() =>
  WHEELS.map(({ index, name }) => {
    const surface = car.value?.tyre_surface_temps[index]
    return {
      name: t(name),
      surface,
      inner: car.value?.tyre_inner_temps[index],
      pressure: car.value?.tyre_pressures[index],
      brake: car.value?.brake_temps[index],
      wear: damage.value?.tyre_wear[index],
      state: surface === undefined ? null : tyreState(surface),
    }
  }),
)

const compound = computed(() => compoundInfo(status.value?.visual_compound))
const compoundCode = computed(() => actualCompoundName(status.value?.actual_compound))
const showErs = computed(() => hasErs(meta.value?.session?.formula))
const ersPercent = computed(() => Math.min(100, ((status.value?.ers_store_j ?? 0) / ERS_CAPACITY_J) * 100))
const fuelPercent = computed(() => {
  const capacity = status.value?.fuel_capacity_kg
  return capacity ? Math.min(100, ((status.value?.fuel_kg ?? 0) / capacity) * 100) : 0
})
const fuelMargin = computed(() => {
  const laps = status.value?.fuel_laps
  return laps === undefined ? '—' : t('car.fuelLaps', { value: `${laps >= 0 ? '+' : '−'}${Math.abs(laps).toFixed(1)}` })
})

const damageItems = computed(() => {
  const d = damage.value
  if (!d) return []
  const items: [string, number][] = [
    [t('car.damage.flWing'), d.front_left_wing],
    [t('car.damage.frWing'), d.front_right_wing],
    [t('car.damage.rearWing'), d.rear_wing],
    [t('car.damage.floor'), d.floor],
    [t('car.damage.diffuser'), d.diffuser],
    [t('car.damage.sidepod'), d.sidepod],
    [t('car.damage.gearbox'), d.gearbox],
    [t('car.damage.engine'), d.engine],
  ]
  return items.filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1])
})
const faults = computed(() => {
  const d = damage.value
  return [d?.drs_fault ? t('car.fault.drs') : '', d?.ers_fault ? t('car.fault.ers') : ''].filter(Boolean)
})
</script>

<template>
  <section class="card car">
    <div class="head">
      <div class="card-title">{{ t('car.tyres') }}</div>
      <div class="compound">
        <i :style="{ borderColor: compound.color }"></i>
        <span>{{ compound.name }}<template v-if="compoundCode"> · {{ compoundCode }}</template></span>
        <span v-if="status" class="label num">{{ tn('unit.laps', status.tyre_age_laps) }}</span>
      </div>
    </div>

    <div class="tyres">
      <div v-for="tyre in tyres" :key="tyre.name" class="tyre">
        <div class="state-bar" :style="{ background: tyre.state?.color ?? 'var(--hairline)' }"></div>
        <div class="label">{{ tyre.name }}</div>
        <div class="temp num">{{ tyre.surface ?? '—' }}<small>°C</small></div>
        <div class="state">{{ tyre.state?.text ?? '—' }}</div>
        <dl class="num">
          <div><dt>{{ t('car.core') }}</dt><dd>{{ tyre.inner ?? '—' }} °</dd></div>
          <div><dt>{{ t('car.brake') }}</dt><dd>{{ tyre.brake ?? '—' }} °</dd></div>
          <div><dt>{{ t('car.pressure') }}</dt><dd>{{ tyre.pressure?.toFixed(1) ?? '—' }}</dd></div>
          <div><dt>{{ t('car.wear') }}</dt><dd>{{ tyre.wear?.toFixed(0) ?? '—' }} %</dd></div>
        </dl>
      </div>
    </div>

    <div v-if="showErs" class="meter">
      <div class="row"><span class="label">{{ t('car.ers', { mode: ersModeName(status?.ers_mode) }) }}</span><b class="num">{{ ersPercent.toFixed(0) }} %</b></div>
      <div class="track"><div class="fill" :style="{ width: `${ersPercent}%` }"></div></div>
    </div>
    <div class="meter">
      <div class="row">
        <span class="label">{{ t('car.fuel', { mix: fuelMixName(status?.fuel_mix) }) }}</span>
        <b class="num">{{ status?.fuel_kg.toFixed(1) ?? '—' }} kg · {{ fuelMargin }}</b>
      </div>
      <div class="track"><div class="fill" :style="{ width: `${fuelPercent}%` }"></div></div>
    </div>

    <div class="facts">
      <div><span class="label">{{ t('car.brakeBias') }}</span><b class="num">{{ status?.brake_bias ?? '—' }} %</b></div>
      <div><span class="label">{{ t('car.engineTemp') }}</span><b class="num">{{ car?.engine_temp ?? '—' }} °C</b></div>
    </div>

    <div class="damage">
      <span class="label">{{ t('car.damage') }}</span>
      <span v-if="!damageItems.length && !faults.length" class="none">{{ damage ? t('car.damage.none') : '—' }}</span>
      <template v-else>
        <span v-for="fault in faults" :key="fault" class="item bad">{{ fault }}</span>
        <span v-for="[name, value] in damageItems" :key="name" class="item num">{{ name }} {{ value }} %</span>
      </template>
    </div>
  </section>
</template>

<style scoped>
.car {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0.875rem 1rem;
}

.head,
.row,
.facts {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.compound {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
  font-weight: 600;
  white-space: nowrap;
}

.compound i {
  width: 0.875rem;
  height: 0.875rem;
  border: 0.1875rem solid;
  border-radius: 50%;
}

.tyres {
  flex: 1;
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  gap: 0.5rem;
  min-height: 0;
}

.tyre {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 0.625rem 0.625rem 0.5rem;
  border-radius: 0.5rem;
  background: var(--card-raised);
  overflow: hidden;
}

.state-bar {
  position: absolute;
  inset: 0 0 auto;
  height: 0.1875rem;
}

.temp {
  font-size: 2rem;
  font-weight: 700;
  line-height: 1.15;
}

.temp small {
  margin-left: 0.125rem;
  color: var(--text-3);
  font-size: 0.875rem;
  font-weight: 500;
}

.state {
  color: var(--text-2);
  font-size: 0.8125rem;
}

dl {
  display: grid;
  gap: 0.0625rem;
  margin: auto 0 0;
  font-size: max(0.75rem, 10.5px);
}

dl div {
  display: flex;
  justify-content: space-between;
}

dt {
  color: var(--text-3);
}

dd {
  margin: 0;
  color: var(--text-2);
}

.meter .row {
  margin-bottom: 0.3125rem;
}

b {
  font-size: 0.875rem;
  font-weight: 600;
  white-space: nowrap;
}

.track {
  height: 0.5rem;
  border-radius: 0.25rem;
  background: var(--card-raised);
}

.fill {
  height: 100%;
  border-radius: 0.25rem;
  background: var(--text-2);
}

.facts > div {
  display: flex;
  flex-direction: column;
  gap: 0.0625rem;
}

.facts > div:last-child {
  text-align: right;
}

.damage {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.25rem 0.625rem;
  font-size: 0.8125rem;
}

.none {
  color: var(--text-2);
}

.item {
  color: var(--warn);
}

.item.bad {
  color: var(--bad-text);
  font-weight: 600;
}
</style>
