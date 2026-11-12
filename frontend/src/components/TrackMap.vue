<script setup lang="ts">
import { computed } from 'vue'
import { analysis, nextCue, refPoints, referenceLap, zones } from '../telemetry/comparison'
import { GRID_M } from '../telemetry/lapRecorder'
import {
  AUTO_TRACK, alignment, distanceAtFraction, gameTrack, isLive, lapFraction, lapsVersion, liveDistance, meta, recorder,
  referenceLengthM, selectedTrack, shownTrack, showsLivePosition, tick,
} from '../telemetry/store'
import { t, type MessageKey } from '../i18n'
import { createMapFitter, type MapView as View } from '../telemetry/mapView'
import { trackCountry, trackName } from '../telemetry/trackNames'
import { COLOR, font } from '../telemetry/theme'
import { nextCorner, pointAt } from '../telemetry/trackGeometry'
import { useCanvas, type CanvasFrame } from '../telemetry/useCanvas'

const fitView = createMapFitter()

type PedalState = 'brake' | 'throttle' | 'coast'
const PEDAL_COLOR: Record<PedalState, string> = { brake: COLOR.brake, throttle: COLOR.throttle, coast: COLOR.coast }

/** Colours the line by the pedals: this lap behind the car, the real driver dimmed ahead of it. */
function drawPedalLine(ctx: CanvasRenderingContext2D, v: View, carFraction: number, rem: number) {
  const n = v.track.points.length
  const real = referenceLap.value
  const fallback = recorder.best ?? recorder.last
  const paths = new Map<string, Path2D>()
  for (let i = 0; i < n; i++) {
    const fraction = i / n
    const driven = fraction <= carFraction
    let brake = NaN
    let throttle = NaN
    if (!driven && real) {
      brake = real.at('brake', fraction * real.lengthM)
      throttle = real.at('throttle', fraction * real.lengthM)
    } else {
      const trace = driven ? recorder.current : fallback
      if (!trace) continue
      const cell = Math.floor(distanceAtFraction(fraction) / GRID_M)
      brake = trace.at('brake', cell)
      throttle = trace.at('throttle', cell)
    }
    if (Number.isNaN(brake) || Number.isNaN(throttle)) continue
    const state: PedalState = brake > 0.08 ? 'brake' : throttle > 0.15 ? 'throttle' : 'coast'
    const key = `${state}:${driven ? 1 : 0}`
    let path = paths.get(key)
    if (!path) paths.set(key, (path = new Path2D()))
    const [ax, ay] = v.track.points[i]
    const [bx, by] = v.track.points[(i + 1) % n]
    path.moveTo(v.ox + ax * v.scale, v.oy + ay * v.scale)
    path.lineTo(v.ox + bx * v.scale, v.oy + by * v.scale)
  }
  ctx.lineCap = 'round'
  ctx.lineWidth = 0.22 * rem
  for (const [key, path] of paths) {
    const [state, driven] = key.split(':')
    ctx.globalAlpha = driven === '1' ? 1 : 0.32
    ctx.strokeStyle = PEDAL_COLOR[state as PedalState]
    ctx.stroke(path)
  }
  ctx.globalAlpha = 1
}

/** Marks the corners where the last lap lost the most, beyond its average pace. */
function drawBiggestLosses(ctx: CanvasRenderingContext2D, v: View, rem: number) {
  const a = analysis.value
  const lengthM = referenceLengthM.value
  if (!a || !lengthM) return
  const n = v.track.points.length
  ctx.lineCap = 'round'
  ctx.strokeStyle = COLOR.warn
  ctx.globalAlpha = 0.4
  ctx.lineWidth = 0.75 * rem
  for (const corner of a.worst) {
    const from = Math.floor(((corner.own?.brakeM ?? corner.zone.apexM - 80) / lengthM) * n)
    const to = Math.ceil(((corner.zone.apexM + 60) / lengthM) * n)
    ctx.beginPath()
    for (let i = from; i <= to; i++) {
      const [x, y] = v.track.points[((i % n) + n) % n]
      if (i === from) ctx.moveTo(v.ox + x * v.scale, v.oy + y * v.scale)
      else ctx.lineTo(v.ox + x * v.scale, v.oy + y * v.scale)
    }
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}

function drawMarkerAcross(ctx: CanvasRenderingContext2D, v: View, fraction: number, halfWidth: number, color: string, width: number) {
  const p = pointAt(v.track, fraction)
  const x = v.ox + p.x * v.scale
  const y = v.oy + p.y * v.scale
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.beginPath()
  ctx.moveTo(x - p.dy * halfWidth, y + p.dx * halfWidth)
  ctx.lineTo(x + p.dy * halfWidth, y - p.dx * halfWidth)
  ctx.stroke()
  return { x, y, nx: -p.dy, ny: p.dx, dx: p.dx, dy: p.dy }
}

function draw({ ctx, width, height, rem, now }: CanvasFrame) {
  const track = shownTrack.value
  if (!track) {
    ctx.fillStyle = COLOR.text3
    ctx.font = font(rem, 0.9375)
    ctx.textAlign = 'center'
    ctx.fillText(t('map.pickTrack'), width / 2, height / 2)
    return
  }
  const v = fitView(track, width, height, rem)
  const session = meta.value?.session

  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.strokeStyle = '#242c39'
  ctx.lineWidth = 0.6 * rem
  ctx.stroke(v.path)
  ctx.strokeStyle = COLOR.hairlineStrong
  ctx.lineWidth = 0.14 * rem
  ctx.stroke(v.path)

  const live = showsLivePosition.value
  const distance = live ? liveDistance(now) : null
  const carFraction = distance === null || distance < 0 ? null : lapFraction(distance)
  if (live) {
    drawBiggestLosses(ctx, v, rem)
    drawPedalLine(ctx, v, carFraction ?? 0, rem)
  }

  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'

  // Sector boundaries come from the game, so they only exist on the track being driven.
  if (live && session) {
    for (const [name, start] of [['S2', session.sector2Start], ['S3', session.sector3Start]] as const) {
      const m = drawMarkerAcross(ctx, v, lapFraction(start), 0.65 * rem, COLOR.text2, 0.12 * rem)
      ctx.fillStyle = COLOR.text2
      ctx.font = font(rem, 0.75, 600)
      ctx.fillText(name, m.x + m.nx * 1.3 * rem, m.y + m.ny * 1.3 * rem)
    }
  }

  // Start/finish with a chevron showing the driving direction.
  const line = drawMarkerAcross(ctx, v, 0, 0.8 * rem, COLOR.text, 0.22 * rem)
  const tip = 1.6 * rem
  ctx.fillStyle = COLOR.text
  ctx.beginPath()
  ctx.moveTo(line.x + line.dx * tip + line.nx * 1 * rem, line.y + line.dy * tip + line.ny * 1 * rem)
  ctx.lineTo(line.x + line.dx * (tip - 0.6 * rem) + line.nx * 0.72 * rem, line.y + line.dy * (tip - 0.6 * rem) + line.ny * 0.72 * rem)
  ctx.lineTo(line.x + line.dx * (tip - 0.6 * rem) + line.nx * 1.28 * rem, line.y + line.dy * (tip - 0.6 * rem) + line.ny * 1.28 * rem)
  ctx.closePath()
  ctx.fill()

  const upcoming = carFraction === null ? null : nextCorner(track, carFraction)
  for (const corner of track.corners) {
    const p = pointAt(track, corner.fraction)
    const x = v.ox + p.x * v.scale + corner.labelDir[0] * 1.15 * rem
    const y = v.oy + p.y * v.scale + corner.labelDir[1] * 1.15 * rem
    const isNext = upcoming?.corner === corner
    ctx.font = font(rem, isNext ? 0.875 : 0.75, isNext ? 700 : 500)
    ctx.fillStyle = isNext ? COLOR.text : COLOR.text3
    ctx.fillText(corner.label, x, y)
  }

  if (carFraction !== null) {
    const p = pointAt(track, carFraction)
    const x = v.ox + p.x * v.scale
    const y = v.oy + p.y * v.scale
    ctx.fillStyle = 'rgba(232, 101, 10, 0.25)'
    ctx.beginPath()
    ctx.arc(x, y, 1 * rem, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = COLOR.card
    ctx.beginPath()
    ctx.arc(x, y, 0.62 * rem, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = COLOR.you
    ctx.beginPath()
    ctx.arc(x, y, 0.5 * rem, 0, Math.PI * 2)
    ctx.fill()
  }
}

// While driving the car moves on between updates, so the map is drawn every frame.
useCanvas(draw, {
  animate: () => isLive.value && !tick.value?.paused,
  deps: [tick, meta, shownTrack, lapsVersion, analysis, referenceLap, alignment],
})

const lengthLabel = computed(() => {
  const track = shownTrack.value
  if (!track) return ''
  const metres = (showsLivePosition.value && meta.value?.session?.trackLength) || track.lengthM
  return `${(metres / 1000).toFixed(3)} km`
})

const CUE_LABEL: Record<string, MessageKey> = { brake: 'cue.brake', turn: 'cue.turn', throttle: 'cue.throttle' }

const nextCornerInfo = computed(() => {
  const track = shownTrack.value
  const distance = tick.value?.lap?.lap_distance
  if (!track || !showsLivePosition.value || distance === undefined || distance < 0) return null
  const next = nextCorner(track, lapFraction(distance))
  if (!next) return null
  const lengthM = referenceLengthM.value ?? (meta.value?.session?.trackLength || track.lengthM)

  // What the real driver did there, next to the player's own last lap.
  const index = zones.value.findIndex((zone) => zone.label === next.corner.label)
  const describe = (points: { minSpeed: number; brakeM: number | null } | null | undefined, apexM: number) => {
    if (!points) return null
    const brake = points.brakeM === null ? t('map.noBrake') : t('map.brakeBefore', { m: Math.max(0, Math.round(apexM - points.brakeM)) })
    return t('map.cornerStats', { v: Math.round(points.minSpeed), brake })
  }
  const zone = zones.value[index]
  return {
    label: next.corner.label,
    inM: Math.round(next.ahead * lengthM),
    driverName: referenceLap.value?.driver.name.split(' ').slice(-1)[0] ?? '',
    real: zone ? describe(refPoints.value[index], zone.apexM) : null,
    own: zone ? describe(analysis.value?.corners[index]?.own, zone.apexM) : null,
  }
})

const cueInfo = computed(() => {
  if (!nextCue.value || !alignment.value) return null
  return { text: t(CUE_LABEL[nextCue.value.cue.kind]), inM: Math.round(nextCue.value.inM) }
})

const hasReference = computed(() => tick.value !== null && showsLivePosition.value)
const mismatch = computed(() => selectedTrack.value !== AUTO_TRACK && gameTrack.value && !showsLivePosition.value)
</script>

<template>
  <section class="card map">
    <div class="head">
      <div>
        <div class="title">{{ shownTrack ? trackName(shownTrack) : t('map.title') }}</div>
        <div v-if="shownTrack" class="label">{{ trackCountry(shownTrack) }} · {{ lengthLabel }}</div>
      </div>
      <div v-if="hasReference" class="legend" :aria-label="t('map.legend.label')">
        <span><i style="background: var(--throttle)"></i>{{ t('map.legend.throttle') }}</span>
        <span><i style="background: var(--brake)"></i>{{ t('map.legend.brake') }}</span>
        <span><i style="background: #c3cad6"></i>{{ t('map.legend.coast') }}</span>
        <span v-if="analysis"><i class="loss-key"></i>{{ t('map.legend.loss') }}</span>
      </div>
    </div>

    <div class="plot"><canvas ref="canvas" role="img" :aria-label="t('map.aria', { track: shownTrack ? trackName(shownTrack) : '' })"></canvas></div>

    <div v-if="mismatch" class="foot notice">
      {{ t('map.mismatch', { track: gameTrack ? trackName(gameTrack) : '' }) }}
      <button type="button" @click="selectedTrack = AUTO_TRACK">{{ t('map.followGame') }}</button>
    </div>
    <div v-else-if="nextCornerInfo" class="foot">
      <div class="next-block">
        <div class="next">
          <span class="label">{{ t('map.nextCorner') }}</span>
          <span class="corner num">{{ nextCornerInfo.label }}</span>
          <span class="in num">{{ nextCornerInfo.inM }} m</span>
        </div>
        <div v-if="cueInfo" class="cue-line num"><span class="label">{{ t('map.cue') }}</span> {{ t('map.cueIn', { cue: cueInfo.text, m: cueInfo.inM }) }}</div>
      </div>
      <div class="stats">
        <span v-if="nextCornerInfo.real" class="num"><span class="label">{{ nextCornerInfo.driverName }}</span> {{ nextCornerInfo.real }}</span>
        <span v-if="nextCornerInfo.own" class="num"><span class="label">{{ t('map.you') }}</span> {{ nextCornerInfo.own }}</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.map {
  display: flex;
  flex-direction: column;
  padding: 0.875rem 1rem;
}

.head {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
}

.title {
  font-size: 1.125rem;
  font-weight: 700;
}

.legend {
  display: flex;
  gap: 0.875rem;
  color: var(--text-2);
  font-size: 0.8125rem;
}

.legend span {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  height: 1.25rem;
  white-space: nowrap;
}

.legend i {
  width: 1rem;
  height: 0.1875rem;
  border-radius: 0.125rem;
}

.plot {
  flex: 1;
  min-height: 0;
}

.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.5rem;
  min-height: 3.25rem;
  padding-top: 0.5rem;
  border-top: 1px solid var(--hairline);
}

.next {
  display: flex;
  align-items: baseline;
  gap: 0.625rem;
  white-space: nowrap;
}

.next-block {
  flex: none;
}

.cue-line {
  color: var(--text-2);
  font-size: 0.8125rem;
}

.loss-key {
  height: 0.5rem !important;
  border-radius: 0.25rem;
  background: var(--warn);
  opacity: 0.5;
}

.corner {
  font-size: 1.5rem;
  font-weight: 800;
}

.in {
  font-size: 1.125rem;
  font-weight: 600;
}

.stats {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  min-width: 0;
  color: var(--text-2);
  font-size: 0.8125rem;
  white-space: nowrap;
}

.stats span {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}

.notice {
  color: var(--text-2);
  font-size: 0.875rem;
}

.notice button {
  height: 2rem;
  padding: 0 0.75rem;
  border: 1px solid var(--control-border);
  border-radius: 0.5rem;
  background: var(--card-raised);
  color: var(--text);
  font: inherit;
  white-space: nowrap;
  cursor: pointer;
}
</style>
