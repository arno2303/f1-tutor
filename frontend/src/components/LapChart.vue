<script setup lang="ts">
import { computed, ref } from 'vue'
import { DRIVING_LANES, type Lane } from '../telemetry/chartLanes'
import { t } from '../i18n'
import { formatDelta } from '../telemetry/format'
import { gapAt, type SideChannel } from '../telemetry/lapStudy'
import { hoverM, study, zoom } from '../telemetry/study'
import { COLOR, font } from '../telemetry/theme'
import { useCanvas, type CanvasFrame } from '../telemetry/useCanvas'

const LANES: Lane[] = [
  ...DRIVING_LANES,
  { id: 'delta', label: 'lane.delta', weight: 1.6, min: 0, max: 1, format: (v) => `${formatDelta(v, 2)} s`, zero: true },
]
const TOTAL_WEIGHT = LANES.reduce((sum, lane) => sum + lane.weight, 0)
const MIN_SPAN_M = 120
const ZOOM_STEP = 1.25

const bColor = computed(() => (study.value?.bKind === 'real' ? COLOR.ref : COLOR.best))
let layout = { left: 0, plotWidth: 1 }

function range() {
  const length = study.value?.lengthM ?? 1
  return zoom.value ?? { from: 0, to: length }
}

function setRange(from: number, to: number) {
  const length = study.value?.lengthM ?? 1
  const span = Math.max(MIN_SPAN_M, Math.min(length, to - from))
  const start = Math.max(0, Math.min(length - span, from))
  zoom.value = span >= length ? null : { from: start, to: start + span }
}

const metresAtX = (x: number) => {
  const { from, to } = range()
  return from + ((x - layout.left) / layout.plotWidth) * (to - from)
}

function niceStep(span: number): number {
  for (const step of [25, 50, 100, 200, 250, 500, 1000]) if (span / step <= 12) return step
  return 2000
}

function draw({ ctx, width, height, rem }: CanvasFrame) {
  const current = study.value
  if (!current) return
  const { a, b, zones } = current
  const left = 9.25 * rem
  const right = 0.75 * rem
  const top = 1.5 * rem
  const axis = 1.375 * rem
  const gap = 0.3125 * rem
  const plotWidth = width - left - right
  const plotHeight = height - top - axis
  layout = { left, plotWidth }
  const { from, to } = range()
  const xOf = (m: number) => left + ((m - from) / (to - from)) * plotWidth
  // One sample per pixel column: plenty for a line, and cheap at any zoom.
  const columns = Math.max(2, Math.floor(plotWidth))
  const metresAtColumn = (i: number) => from + (i / (columns - 1)) * (to - from)

  // Corners and distance. A label too close to the previous one waits for a closer zoom.
  ctx.lineWidth = 1
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  ctx.font = font(rem, 0.75, 600)
  let lastLabelEnd = -Infinity
  for (const zone of zones) {
    if (zone.apexM < from || zone.apexM > to) continue
    const x = xOf(zone.apexM)
    ctx.strokeStyle = COLOR.hairline
    ctx.beginPath()
    ctx.moveTo(x, top)
    ctx.lineTo(x, top + plotHeight)
    ctx.stroke()
    const text = `T${zone.label}`
    const halfWidth = ctx.measureText(text).width / 2
    if (x - halfWidth < lastLabelEnd + 0.375 * rem) continue
    ctx.fillStyle = COLOR.text2
    ctx.fillText(text, x, top / 2)
    lastLabelEnd = x + halfWidth
  }
  const step = niceStep(to - from)
  ctx.font = font(rem, 0.6875)
  ctx.fillStyle = COLOR.text3
  for (let m = Math.ceil(from / step) * step; m <= to; m += step) ctx.fillText(`${m}`, xOf(m), height - axis / 2)

  // Δ is scaled to what's in view, so a small gap inside a corner stays readable.
  const raw = new Float64Array(columns)
  for (let i = 0; i < columns; i++) raw[i] = gapAt(a, b, metresAtColumn(i))
  // Lap clocks advance in small steps, which up close looks like noise; ±5 m of averaging hides it.
  const reach = Math.max(0, Math.round((5 / (to - from)) * columns))
  const deltas = new Float64Array(columns)
  let deltaMin = Infinity
  let deltaMax = -Infinity
  for (let i = 0; i < columns; i++) {
    let sum = 0
    let count = 0
    for (let k = Math.max(0, i - reach); k <= Math.min(columns - 1, i + reach); k++) {
      if (!Number.isNaN(raw[k])) {
        sum += raw[k]
        count++
      }
    }
    const value = count && !Number.isNaN(raw[i]) ? sum / count : NaN
    deltas[i] = value
    if (!Number.isNaN(value)) {
      deltaMin = Math.min(deltaMin, value)
      deltaMax = Math.max(deltaMax, value)
    }
  }
  // Fitted to what's in view: inside one corner the slope of the gap is what matters, not its size.
  if (!Number.isFinite(deltaMin)) [deltaMin, deltaMax] = [-0.5, 0.5]
  if (deltaMax - deltaMin < 0.2) {
    const middle = (deltaMin + deltaMax) / 2
    deltaMin = middle - 0.1
    deltaMax = middle + 0.1
  }

  const usable = plotHeight - gap * (LANES.length - 1)
  let y = top
  const boxes: { lane: Lane; y: number; h: number; yOf: (v: number) => number }[] = []
  for (const lane of LANES) {
    const h = (usable * lane.weight) / TOTAL_WEIGHT
    const [min, max] = lane.id === 'delta' ? [deltaMin, deltaMax] : [lane.min, lane.max]
    const inset = 0.125 * rem
    const laneTop = y
    const yOf = (v: number) => laneTop + inset + (h - inset * 2) * (1 - (Math.max(min, Math.min(max, v)) - min) / (max - min))
    boxes.push({ lane, y, h, yOf })

    ctx.strokeStyle = COLOR.hairline
    ctx.lineWidth = 1
    ctx.beginPath()
    const zeroInView = lane.id !== 'delta' || (deltaMin <= 0 && deltaMax >= 0)
    const baseline = lane.zero && zeroInView ? yOf(0) : laneTop + h
    ctx.moveTo(left, baseline)
    ctx.lineTo(left + plotWidth, baseline)
    for (const tick of lane.ticks ?? []) {
      ctx.moveTo(left, yOf(tick))
      ctx.lineTo(left + plotWidth, yOf(tick))
    }
    ctx.stroke()

    const series = (sample: (i: number) => number, color: string, step: boolean, wash: boolean) => {
      ctx.beginPath()
      let drawing = false
      let lastY = 0
      const fill = wash ? new Path2D() : null
      let fillStart: number | null = null
      let lastX = 0
      const closeFill = () => {
        if (fill && fillStart !== null) {
          fill.lineTo(lastX, yOf(0))
          fill.lineTo(fillStart, yOf(0))
          fill.closePath()
        }
        fillStart = null
      }
      for (let i = 0; i < columns; i++) {
        const value = sample(i)
        if (Number.isNaN(value)) {
          drawing = false
          closeFill()
          continue
        }
        const x = left + (i / (columns - 1)) * plotWidth
        const py = yOf(value)
        if (!drawing) ctx.moveTo(x, py)
        else {
          if (step) ctx.lineTo(x, lastY)
          ctx.lineTo(x, py)
        }
        if (fill) {
          if (fillStart === null) {
            fillStart = x
            fill.moveTo(x, yOf(0))
          }
          fill.lineTo(x, py)
        }
        drawing = true
        lastY = py
        lastX = x
      }
      closeFill()
      ctx.strokeStyle = color
      ctx.stroke()
      if (fill) {
        ctx.globalAlpha = 0.1
        ctx.fillStyle = color
        ctx.fill(fill)
        ctx.globalAlpha = 1
      }
    }

    ctx.lineWidth = 2
    ctx.lineJoin = 'round'
    if (lane.id === 'delta') {
      series((i) => deltas[i], COLOR.you, false, false)
    } else {
      const channel = lane.id as SideChannel
      series((i) => b.value(channel, metresAtColumn(i)), bColor.value, !!lane.step, false)
      series((i) => a.value(channel, metresAtColumn(i)), COLOR.you, !!lane.step, false)
    }
    y += h + gap
  }

  // Lane names, and the values at the pointer.
  const hovered = hoverM.value !== null && hoverM.value >= from && hoverM.value <= to ? hoverM.value : null
  ctx.textBaseline = 'middle'
  for (const { lane, y: laneY, h, yOf } of boxes) {
    ctx.textAlign = 'left'
    ctx.font = font(rem, 0.8125)
    ctx.fillStyle = COLOR.text3
    ctx.fillText(t(lane.label), 0.25 * rem, laneY + (lane.id === 'speed' ? 0.75 * rem : h / 2))
    if (lane.id === 'speed' || lane.id === 'delta') {
      ctx.textAlign = 'right'
      ctx.font = font(rem, 0.6875)
      const ticks = lane.id === 'speed' ? (lane.ticks ?? []) : [deltaMin, deltaMax]
      for (const value of ticks) ctx.fillText(lane.id === 'speed' ? String(value) : formatDelta(value, 2), left - 0.375 * rem, yOf(value))
    }
  }

  if (hovered !== null) {
    const x = xOf(hovered)
    ctx.strokeStyle = COLOR.text2
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x, top)
    ctx.lineTo(x, top + plotHeight)
    ctx.stroke()

    const rows = LANES.map((lane) => {
      const text = (value: number) => (Number.isNaN(value) ? '—' : lane.format(value))
      if (lane.id === 'delta') return [t(lane.label), text(gapAt(a, b, hovered)), '']
      const channel = lane.id as SideChannel
      return [t(lane.label), text(a.value(channel, hovered)), text(b.value(channel, hovered))]
    })
    const boxW = 18 * rem
    const rowH = 1.25 * rem
    const boxH = rowH * (rows.length + 1) + 0.75 * rem
    const boxX = x + boxW + 1 * rem > width ? x - boxW - 0.75 * rem : x + 0.75 * rem
    const boxY = top + 0.25 * rem
    ctx.fillStyle = '#0b0e13'
    ctx.strokeStyle = COLOR.hairlineStrong
    ctx.beginPath()
    ctx.roundRect(boxX, boxY, boxW, boxH, 0.5 * rem)
    ctx.fill()
    ctx.stroke()
    const colA = boxX + 11 * rem
    const colB = boxX + boxW - 0.625 * rem
    let rowY = boxY + 0.375 * rem + rowH / 2
    ctx.font = font(rem, 0.75, 600)
    ctx.textAlign = 'left'
    ctx.fillStyle = COLOR.text
    ctx.fillText(`${Math.round(hovered)} m`, boxX + 0.625 * rem, rowY)
    ctx.textAlign = 'right'
    for (const [column, name, color] of [[colA, t('lapChart.colLap'), COLOR.you], [colB, study.value?.bKind === 'real' ? t('lapChart.colDriver') : t('lapChart.colOther'), bColor.value]] as const) {
      ctx.fillStyle = color
      ctx.fillRect(column - ctx.measureText(name).width - 1 * rem, rowY - 1, 0.75 * rem, 2)
      ctx.fillStyle = COLOR.text2
      ctx.fillText(name, column, rowY)
    }
    for (const [label, own, other] of rows) {
      rowY += rowH
      ctx.textAlign = 'left'
      ctx.font = font(rem, 0.75)
      ctx.fillStyle = COLOR.text3
      ctx.fillText(label, boxX + 0.625 * rem, rowY)
      ctx.textAlign = 'right'
      ctx.font = font(rem, 0.75, 600)
      ctx.fillStyle = COLOR.text
      ctx.fillText(own, colA, rowY)
      ctx.fillText(other, colB, rowY)
    }
  }
}

useCanvas(draw, { deps: [study, zoom, hoverM] })

// Wheel zooms around the pointer, dragging pans, a double click shows the whole lap.
const dragging = ref<{ x: number; from: number; to: number } | null>(null)

// A trackpad sends many small wheel events and a mouse a few large ones, so zoom follows their size.
const ZOOM_PER_PIXEL = 0.002

function onWheel(event: WheelEvent) {
  event.preventDefault()
  const { from, to } = range()
  const pixels = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? layout.plotWidth : 1
  if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
    const shift = ((event.deltaX * pixels) / layout.plotWidth) * (to - from)
    setRange(from + shift, to + shift)
    return
  }
  if (event.deltaY === 0) return
  const anchor = metresAtX(event.offsetX)
  const factor = Math.exp(event.deltaY * pixels * ZOOM_PER_PIXEL)
  setRange(anchor - (anchor - from) * factor, anchor + (to - anchor) * factor)
}

function onPointerDown(event: PointerEvent) {
  if (event.button !== 0) return
  const { from, to } = range()
  dragging.value = { x: event.offsetX, from, to }
  ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
}

function onPointerMove(event: PointerEvent) {
  const drag = dragging.value
  if (drag) {
    const metresPerPx = (drag.to - drag.from) / layout.plotWidth
    const shift = (drag.x - event.offsetX) * metresPerPx
    setRange(drag.from + shift, drag.to + shift)
  }
  const m = metresAtX(event.offsetX)
  hoverM.value = event.offsetX >= layout.left && m >= 0 && m <= (study.value?.lengthM ?? 0) ? m : null
}

function zoomBy(factor: number) {
  const { from, to } = range()
  const middle = (from + to) / 2
  setRange(middle - ((to - from) / 2) * factor, middle + ((to - from) / 2) * factor)
}

const legendA = computed(() => study.value?.a.label ?? '')
const legendB = computed(() => study.value?.b.label ?? '')
</script>

<template>
  <section class="card lap-chart">
    <div class="legend" :aria-label="t('chart.legend')">
      <span><i style="background: var(--you)"></i>{{ legendA }}</span>
      <span><i :style="{ background: bColor }"></i>{{ legendB }}</span>
      <span class="spacer"></span>
      <span class="hint">{{ t('lapChart.hint') }}</span>
      <button type="button" :aria-label="t('lapChart.zoomOut')" @click="zoomBy(ZOOM_STEP)">−</button>
      <button type="button" :aria-label="t('lapChart.zoomIn')" @click="zoomBy(1 / ZOOM_STEP)">+</button>
      <button type="button" :disabled="!zoom" @click="zoom = null">{{ t('lapChart.whole') }}</button>
    </div>
    <div class="plot">
      <canvas
        ref="canvas"
        role="img"
        :aria-label="t('lapChart.aria')"
        @wheel="onWheel"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="dragging = null"
        @pointercancel="dragging = null"
        @lostpointercapture="dragging = null"
        @pointerleave="hoverM = null"
        @dblclick="zoom = null"
      ></canvas>
    </div>
  </section>
</template>

<style scoped>
.lap-chart {
  display: flex;
  flex-direction: column;
  padding: 0.625rem 0.75rem 0.25rem;
}

.legend {
  display: flex;
  align-items: center;
  gap: 1.25rem;
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
  width: 1.125rem;
  height: 2px;
  border-radius: 1px;
}

.spacer {
  flex: 1;
}

.hint {
  color: var(--text-3);
  font-size: max(0.75rem, 10.5px);
}

button {
  height: 1.75rem;
  min-width: 1.75rem;
  padding: 0 0.5rem;
  border: 1px solid var(--control-border);
  border-radius: 0.375rem;
  background: var(--card-raised);
  color: var(--text);
  font: inherit;
  font-size: 0.8125rem;
  cursor: pointer;
}

button:disabled {
  color: var(--text-3);
  cursor: default;
}

.plot {
  flex: 1;
  min-height: 0;
  cursor: grab;
  touch-action: none;
}

.plot:active {
  cursor: grabbing;
}
</style>
