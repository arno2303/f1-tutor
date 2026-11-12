<script setup lang="ts">
import { computed, watch } from 'vue'
import { t } from '../i18n'
import { tick } from '../telemetry/store'
import { COLOR, font } from '../telemetry/theme'
import { useCanvas, type CanvasFrame } from '../telemetry/useCanvas'

const MAX_G = 6
const RINGS = [2, 4, 6]
const TRAIL_LENGTH = 90 // 3 s at 30 ticks per second
const trail: { lat: number; long: number }[] = []

watch(tick, (current) => {
  if (!current?.motion || !current.live || current.paused) return
  trail.push({ lat: current.motion.g_lat, long: current.motion.g_long })
  if (trail.length > TRAIL_LENGTH) trail.shift()
})

function draw({ ctx, width, height, rem }: CanvasFrame) {
  const cx = width / 2
  const cy = height / 2
  const radius = Math.min(width, height) / 2 - 0.5 * rem
  const unit = radius / MAX_G
  // Acceleration points up and braking down, like the car's nose on a map.
  const toX = (lat: number) => cx + Math.max(-MAX_G, Math.min(MAX_G, lat)) * unit
  const toY = (long: number) => cy - Math.max(-MAX_G, Math.min(MAX_G, long)) * unit

  ctx.lineWidth = 1
  ctx.strokeStyle = COLOR.hairline
  ctx.font = font(rem, 0.6875)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const g of RINGS) {
    ctx.beginPath()
    ctx.arc(cx, cy, g * unit, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.beginPath()
  ctx.moveTo(cx - radius, cy)
  ctx.lineTo(cx + radius, cy)
  ctx.moveTo(cx, cy - radius)
  ctx.lineTo(cx, cy + radius)
  ctx.stroke()
  for (const g of RINGS) {
    ctx.fillStyle = COLOR.card
    ctx.fillRect(cx + 0.2 * rem, cy - g * unit - 0.4 * rem, 1.1 * rem, 0.8 * rem)
    ctx.fillStyle = COLOR.text3
    ctx.fillText(`${g} g`, cx + 0.75 * rem, cy - g * unit)
  }

  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = 2
  for (let i = 1; i < trail.length; i++) {
    ctx.globalAlpha = (i / trail.length) * 0.7
    ctx.strokeStyle = COLOR.you
    ctx.beginPath()
    ctx.moveTo(toX(trail[i - 1].lat), toY(trail[i - 1].long))
    ctx.lineTo(toX(trail[i].lat), toY(trail[i].long))
    ctx.stroke()
  }
  ctx.globalAlpha = 1

  const newest = trail[trail.length - 1]
  if (newest) {
    ctx.fillStyle = COLOR.card
    ctx.beginPath()
    ctx.arc(toX(newest.lat), toY(newest.long), 0.5 * rem + 2, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = COLOR.you
    ctx.beginPath()
    ctx.arc(toX(newest.lat), toY(newest.long), 0.5 * rem, 0, Math.PI * 2)
    ctx.fill()
  }
}

useCanvas(draw, { deps: [tick] })
const motion = computed(() => tick.value?.motion ?? null)
const signed = (value: number | undefined) => (value === undefined ? '—' : `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(1)}`)
</script>

<template>
  <div class="g">
    <div class="plot"><canvas ref="canvas" role="img" :aria-label="t('gforce.aria')"></canvas></div>
    <div class="values">
      <div><span class="label">{{ t('gforce.lateral') }}</span> <b class="num">{{ signed(motion?.g_lat) }} g</b></div>
      <div><span class="label">{{ t('gforce.longitudinal') }}</span> <b class="num">{{ signed(motion?.g_long) }} g</b></div>
    </div>
  </div>
</template>

<style scoped>
.g {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  min-width: 0;
  min-height: 0;
}

.plot {
  flex: 1;
  min-height: 0;
}

.values {
  display: flex;
  justify-content: center;
  gap: 1.5rem;
  font-size: 0.875rem;
  white-space: nowrap;
}

b {
  font-weight: 600;
}
</style>
