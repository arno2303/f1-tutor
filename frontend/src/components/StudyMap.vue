<script setup lang="ts">
import { computed } from 'vue'
import { t } from '../i18n'
import { gapTrend, type GapTrend } from '../telemetry/lapStudy'
import { trackName } from '../telemetry/trackNames'
import { createMapFitter, mapPoint } from '../telemetry/mapView'
import { hoverM, study, zoom } from '../telemetry/study'
import { COLOR, font } from '../telemetry/theme'
import { useCanvas, type CanvasFrame } from '../telemetry/useCanvas'

const fitView = createMapFitter(2.25)
const TREND_COLOR: Record<GapTrend, string> = { gain: COLOR.throttle, loss: COLOR.brake, even: '#5b6575' }

function draw({ ctx, width, height, rem }: CanvasFrame) {
  const current = study.value
  if (!current) return
  const v = fitView(current.track, width, height, rem)
  const n = v.track.points.length
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = '#242c39'
  ctx.lineWidth = 0.6 * rem
  ctx.stroke(v.path)

  // The part of the lap shown in the chart, drawn wider underneath.
  if (zoom.value) {
    ctx.strokeStyle = COLOR.hairlineStrong
    ctx.lineWidth = 1 * rem
    ctx.beginPath()
    const from = current.fraction(zoom.value.from)
    const to = current.fraction(zoom.value.to)
    const span = ((to - from) % 1 + 1) % 1
    for (let i = 0; i <= Math.ceil(span * n); i++) {
      const p = mapPoint(v, from + i / n)
      if (i === 0) ctx.moveTo(p.x, p.y)
      else ctx.lineTo(p.x, p.y)
    }
    ctx.stroke()
  }

  // Where the analysed lap gains or loses against the other one.
  const paths = new Map<GapTrend, Path2D>()
  for (let i = 0; i < n; i++) {
    const trend = gapTrend(current.a, current.b, current.metresAt(i / n), current.lengthM, current.bKind === 'real')
    if (!trend) continue
    let path = paths.get(trend)
    if (!path) paths.set(trend, (path = new Path2D()))
    const p = mapPoint(v, i / n)
    const q = mapPoint(v, (i + 1) / n)
    path.moveTo(p.x, p.y)
    path.lineTo(q.x, q.y)
  }
  ctx.lineWidth = 0.28 * rem
  for (const [trend, path] of paths) {
    ctx.strokeStyle = TREND_COLOR[trend]
    ctx.stroke(path)
  }

  // Start line and corner numbers.
  const line = mapPoint(v, current.fraction(0))
  ctx.strokeStyle = COLOR.text
  ctx.lineWidth = 0.22 * rem
  ctx.beginPath()
  ctx.moveTo(line.x - line.dy * 0.8 * rem, line.y + line.dx * 0.8 * rem)
  ctx.lineTo(line.x + line.dy * 0.8 * rem, line.y - line.dx * 0.8 * rem)
  ctx.stroke()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const hoveredZone = hoverM.value === null ? null : current.zones.find((z) => hoverM.value! >= z.startM && hoverM.value! < z.endM)
  for (const corner of v.track.corners) {
    const p = mapPoint(v, corner.fraction)
    const isHovered = hoveredZone?.label === corner.label
    ctx.font = font(rem, isHovered ? 0.875 : 0.75, isHovered ? 700 : 500)
    ctx.fillStyle = isHovered ? COLOR.text : COLOR.text3
    ctx.fillText(corner.label, p.x + corner.labelDir[0] * 1.15 * rem, p.y + corner.labelDir[1] * 1.15 * rem)
  }

  if (hoverM.value !== null) {
    const p = mapPoint(v, current.fraction(hoverM.value))
    ctx.fillStyle = COLOR.card
    ctx.beginPath()
    ctx.arc(p.x, p.y, 0.62 * rem, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = COLOR.you
    ctx.beginPath()
    ctx.arc(p.x, p.y, 0.5 * rem, 0, Math.PI * 2)
    ctx.fill()
  }
}

useCanvas(draw, { deps: [study, zoom, hoverM] })
// Against a real driver everything is slower, so the colours compare with the lap's average gap.
const relative = computed(() => study.value?.bKind === 'real')
const otherName = computed(() => (relative.value ? study.value?.driver?.name.split(' ').slice(-1)[0] : t('studyMap.otherLap')))
</script>

<template>
  <section class="card study-map">
    <div class="head">
      <div class="title">{{ study ? trackName(study.track) : '' }}</div>
      <div class="legend" :aria-label="t('map.legend.label')">
        <span><i style="background: var(--throttle)"></i>{{ relative ? t('studyMap.lessThanAverage') : t('studyMap.gain') }}</span>
        <span><i style="background: var(--brake)"></i>{{ relative ? t('studyMap.moreThanAverage') : t('studyMap.loss') }}</span>
        <span><i style="background: #5b6575"></i>{{ relative ? t('studyMap.average') : t('studyMap.even') }}</span>
        <span class="label">{{ t('studyMap.versus', { name: otherName ?? '' }) }}</span>
      </div>
    </div>
    <div class="plot"><canvas ref="canvas" role="img" :aria-label="t('studyMap.aria', { track: study ? trackName(study.track) : '' })"></canvas></div>
  </section>
</template>

<style scoped>
.study-map {
  display: flex;
  flex-direction: column;
  padding: 0.75rem 1rem;
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
  align-items: center;
  gap: 0.875rem;
  color: var(--text-2);
  font-size: 0.8125rem;
}

.legend span {
  display: flex;
  align-items: center;
  gap: 0.375rem;
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
</style>
