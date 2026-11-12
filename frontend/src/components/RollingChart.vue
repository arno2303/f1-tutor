<script setup lang="ts">
import { computed, ref } from 'vue'
import { DRIVING_LANES, drawLine, type Lane } from '../telemetry/chartLanes'
import { GRID_M, type Channel, type LapTrace } from '../telemetry/lapRecorder'
import { toReference } from '../telemetry/alignment'
import { referenceLap } from '../telemetry/comparison'
import { t } from '../i18n'
import { formatDelta, formatLapTime } from '../telemetry/format'
import { savedLap } from '../telemetry/sessions'
import {
  alignment, distanceAtFraction, gameTrack, isLive, lapsVersion, liveDistance, meta, recorder, tick,
} from '../telemetry/store'
import { COLOR, font } from '../telemetry/theme'
import { useCanvas, type CanvasFrame } from '../telemetry/useCanvas'

const WINDOW_M = 700
const CURSOR_AT = 0.38

const LANES: Lane[] = [
  ...DRIVING_LANES,
  { id: 'delta', label: 'lane.deltaBest', weight: 1, min: -1, max: 1, format: (v) => `${formatDelta(v, 2)} s`, zero: true },
  { id: 'realDelta', label: 'lane.deltaReal', weight: 1.2, min: 0, max: 1, format: (v) => `${formatDelta(v, 2)} s` },
]
const TOTAL_WEIGHT = LANES.reduce((sum, lane) => sum + lane.weight, 0)

const hoverX = ref<number | null>(null)
// The purple line: a saved lap when one is chosen, otherwise today's best.
const ghostLabel = computed(() => {
  void lapsVersion.value
  if (savedLap.value) return t('chart.savedLap', { time: formatLapTime(savedLap.value.trace.lapMs) })
  return recorder.best ? t('chart.myBest') : t('chart.myBestNone')
})
const realName = computed(() => {
  const driver = referenceLap.value?.driver
  return driver ? t('chart.realLap', { driver: driver.name }) : null
})

function draw({ ctx, width, height, rem, now }: CanvasFrame) {
  const session = meta.value?.session
  const lengthM = session?.trackLength || gameTrack.value?.lengthM || 0
  const lapCells = lengthM ? Math.round(lengthM / GRID_M) : 0
  const ghost = savedLap.value?.trace ?? recorder.best
  const laneLabel = (lane: Lane) => t(lane.id === 'delta' && savedLap.value ? 'lane.deltaSaved' : lane.label)
  const distance = liveDistance(now) ?? 0

  const left = 9.25 * rem
  const right = 0.75 * rem
  const top = 1.5 * rem
  const axis = 1.375 * rem
  const gap = 0.3125 * rem
  const plotWidth = width - left - right
  const plotHeight = height - top - axis
  const metresPerPx = WINDOW_M / plotWidth
  const cursorX = left + plotWidth * CURSOR_AT
  const xOf = (metres: number) => cursorX + (metres - distance) / metresPerPx
  const startM = distance - WINDOW_M * CURSOR_AT
  const endM = startM + WINDOW_M
  const startCell = Math.floor(startM / GRID_M)
  const endCell = Math.ceil(endM / GRID_M)
  const cursorCell = Math.floor(distance / GRID_M)

  // Before the line the window shows the previous lap; past it, the reference lap again.
  const currentValue = (channel: Channel) => (cell: number) => {
    if (cell >= 0) return recorder.current.at(channel, cell)
    return lapCells && recorder.last ? recorder.last.at(channel, cell + lapCells) : NaN
  }
  const referenceValue = (channel: Channel, trace: LapTrace) => (cell: number) => {
    if (!lapCells) return trace.at(channel, cell)
    return trace.at(channel, ((cell % lapCells) + lapCells) % lapCells)
  }
  const deltaValue = (cell: number) => {
    if (!ghost) return NaN
    const own = currentValue('time')(cell)
    const reference = referenceValue('time', ghost)(cell)
    return (own - reference) / 1000
  }

  // The real driver's values at a cell of the game's own distance.
  const real = referenceLap.value
  const fit = alignment.value
  const realValue = (channel: 'speed' | 'throttle' | 'brake' | 'gear') => (cell: number) =>
    real && fit ? real.at(channel, toReference(fit, cell * GRID_M)) : NaN
  // Time is measured from the game's own line, so the real clock starts where that line falls on its lap.
  const realDeltaValue = (cell: number) => {
    if (!real || !fit) return NaN
    const own = currentValue('time')(cell)
    const elapsed = real.timeAt(toReference(fit, cell * GRID_M)) - real.timeAt(fit.b)
    return (own - elapsed) / 1000
  }
  // Against an F1 lap the gap only grows, so this lane is scaled to what's in view:
  // its slope shows where time goes, and the label gives the running total.
  let realDeltaMin = Infinity
  let realDeltaMax = -Infinity
  for (let cell = startCell; cell <= cursorCell; cell++) {
    const value = realDeltaValue(cell)
    if (Number.isNaN(value)) continue
    realDeltaMin = Math.min(realDeltaMin, value)
    realDeltaMax = Math.max(realDeltaMax, value)
  }
  if (realDeltaMax - realDeltaMin < 1) realDeltaMax = (Number.isFinite(realDeltaMin) ? realDeltaMin : 0) + 1
  if (!Number.isFinite(realDeltaMin)) realDeltaMin = 0

  // The delta scale widens with the biggest gap in view, so small gains stay readable.
  let deltaScale = 0.5
  for (let cell = startCell; cell <= cursorCell; cell++) {
    const value = deltaValue(cell)
    if (!Number.isNaN(value)) deltaScale = Math.max(deltaScale, Math.abs(value))
  }
  deltaScale = Math.ceil(deltaScale * 2) / 2

  ctx.save()
  ctx.beginPath()
  ctx.rect(left, 0, plotWidth, height)
  ctx.clip()

  ctx.fillStyle = 'rgba(255, 255, 255, 0.018)'
  ctx.fillRect(cursorX, top, plotWidth, plotHeight)

  // Places on the lap: metre ticks, corners, sectors and the line.
  ctx.font = font(rem, 0.6875)
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  ctx.lineWidth = 1
  for (let m = Math.ceil(startM / 100) * 100; m <= endM; m += 100) {
    const shown = lengthM ? ((m % lengthM) + lengthM) % lengthM : m
    ctx.fillStyle = COLOR.text3
    ctx.fillText(String(Math.round(shown)), xOf(m), height - axis / 2)
  }

  const copies = (metres: number) => (lengthM ? [metres - lengthM, metres, metres + lengthM] : [metres])
  const vertical = (x: number, color: string) => {
    ctx.strokeStyle = color
    ctx.beginPath()
    ctx.moveTo(x, top)
    ctx.lineTo(x, top + plotHeight)
    ctx.stroke()
  }
  if (gameTrack.value && lengthM) {
    for (const corner of gameTrack.value.corners) {
      for (const metres of copies(distanceAtFraction(corner.fraction))) {
        if (metres < startM || metres > endM) continue
        const x = xOf(metres)
        vertical(x, COLOR.hairline)
        ctx.font = font(rem, 0.75, 600)
        ctx.fillStyle = COLOR.text2
        ctx.fillText(`T${corner.label}`, x, top / 2)
      }
    }
  }
  if (session && lengthM) {
    const marks: [number, string][] = [[0, t('chart.finish')], [session.sector2Start, 'S2'], [session.sector3Start, 'S3']]
    for (const [at, name] of marks) {
      for (const metres of copies(at)) {
        if (metres < startM || metres > endM) continue
        const x = xOf(metres)
        vertical(x, COLOR.hairlineStrong)
        ctx.font = font(rem, 0.75, 700)
        ctx.fillStyle = COLOR.text
        ctx.fillText(name, x, top / 2)
      }
    }
  }

  // Lanes.
  const usable = plotHeight - gap * (LANES.length - 1)
  let y = top
  const laneBoxes: { lane: Lane; y: number; h: number; yOf: (value: number) => number }[] = []
  for (const lane of LANES) {
    const h = (usable * lane.weight) / TOTAL_WEIGHT
    const [min, max] =
      lane.id === 'delta' ? [-deltaScale, deltaScale] : lane.id === 'realDelta' ? [realDeltaMin, realDeltaMax] : [lane.min, lane.max]
    const inset = 0.125 * rem
    const top0 = y + inset
    const span = h - inset * 2
    const yOf = (value: number) => top0 + span - ((Math.max(min, Math.min(max, value)) - min) / (max - min)) * span
    laneBoxes.push({ lane, y, h, yOf })

    ctx.strokeStyle = COLOR.hairline
    ctx.lineWidth = 1
    ctx.beginPath()
    if (lane.zero) {
      ctx.moveTo(left, yOf(0))
      ctx.lineTo(left + plotWidth, yOf(0))
    } else {
      ctx.moveTo(left, y + h)
      ctx.lineTo(left + plotWidth, y + h)
    }
    for (const value of lane.ticks ?? []) {
      ctx.moveTo(left, yOf(value))
      ctx.lineTo(left + plotWidth, yOf(value))
    }
    ctx.stroke()

    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const washBase = lane.wash ? yOf(0) : null
    if (lane.id === 'delta') {
      drawLine(ctx, startCell, cursorCell, xOf, yOf, deltaValue, COLOR.you, false, null)
    } else if (lane.id === 'realDelta') {
      drawLine(ctx, startCell, cursorCell, xOf, yOf, realDeltaValue, COLOR.you, false, null)
    } else {
      if (ghost) {
        // Thinner, as the third line in a lane: colour alone wouldn't set it apart from the real driver's.
        ctx.lineWidth = 1.25
        drawLine(ctx, startCell, endCell, xOf, yOf, referenceValue(lane.id, ghost), COLOR.best, !!lane.step, null)
        ctx.lineWidth = 2
      }
      if (real && lane.id !== 'steer' && lane.id !== 'time' && lane.id !== 'x' && lane.id !== 'z') {
        drawLine(ctx, startCell, endCell, xOf, yOf, realValue(lane.id), COLOR.ref, !!lane.step, null)
      }
      drawLine(ctx, startCell, cursorCell, xOf, yOf, currentValue(lane.id), COLOR.you, !!lane.step, washBase)
    }
    y += h + gap
  }

  // Cursor at the car's position.
  ctx.strokeStyle = COLOR.text
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(cursorX, top)
  ctx.lineTo(cursorX, top + plotHeight)
  ctx.stroke()

  const car = tick.value?.car
  if (car) {
    const speedLane = laneBoxes[0]
    const dotY = speedLane.yOf(car.speed)
    ctx.fillStyle = COLOR.card
    ctx.beginPath()
    ctx.arc(cursorX, dotY, 0.3125 * rem + 2, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = COLOR.you
    ctx.beginPath()
    ctx.arc(cursorX, dotY, 0.3125 * rem, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()

  // Left column: what each lane is, with its value at the car.
  const laneValue = (lane: Lane): string => {
    if (lane.id === 'delta') {
      // Read at the last received position: the drawn one is predicted ahead of the recorded data.
      const lapDistance = tick.value?.lap?.lap_distance
      const value = lapDistance === undefined ? null : recorder.deltaAt(lapDistance, ghost)
      return value === null ? '—' : lane.format(value)
    }
    if (lane.id === 'realDelta') {
      const lapDistance = tick.value?.lap?.lap_distance
      const value = lapDistance === undefined || lapDistance < 0 ? NaN : realDeltaValue(Math.floor(lapDistance / GRID_M))
      return Number.isNaN(value) ? '—' : lane.format(value)
    }
    if (!car) return '—'
    const value = car[lane.id as 'speed' | 'throttle' | 'brake' | 'gear' | 'steer']
    return lane.format(value)
  }
  ctx.textBaseline = 'middle'
  for (const { lane, y: laneY, h, yOf } of laneBoxes) {
    ctx.textAlign = 'left'
    ctx.font = font(rem, 0.8125)
    ctx.fillStyle = COLOR.text3
    if (lane.id === 'speed') {
      ctx.fillText(t(lane.label), 0.25 * rem, laneY + 0.75 * rem)
      ctx.font = font(rem, 1.25, 700)
      ctx.fillStyle = COLOR.text
      ctx.fillText(laneValue(lane), 0.25 * rem, laneY + 2 * rem)
      ctx.font = font(rem, 0.6875)
      ctx.fillStyle = COLOR.text3
      ctx.textAlign = 'right'
      for (const value of lane.ticks ?? []) ctx.fillText(String(value), left - 0.375 * rem, yOf(value))
    } else {
      ctx.fillText(laneLabel(lane), 0.25 * rem, laneY + h / 2)
      ctx.textAlign = 'right'
      ctx.font = font(rem, 0.875, 600)
      ctx.fillStyle = COLOR.text
      ctx.fillText(laneValue(lane), left - 0.375 * rem, laneY + h / 2)
    }
  }

  // Hover: crosshair and both laps' values at that place on track.
  const hx = hoverX.value
  if (hx !== null && hx >= left && hx <= left + plotWidth) {
    const metres = distance + (hx - cursorX) * metresPerPx
    const cell = Math.floor(metres / GRID_M)
    ctx.strokeStyle = COLOR.text2
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(hx, top)
    ctx.lineTo(hx, top + plotHeight)
    ctx.stroke()

    const text = (lane: Lane, value: number) => (Number.isNaN(value) ? '—' : lane.format(value))
    const rows = LANES.map((lane) => {
      if (lane.id === 'delta') return [laneLabel(lane), text(lane, cell <= cursorCell ? deltaValue(cell) : NaN), '', '']
      if (lane.id === 'realDelta') return [laneLabel(lane), text(lane, cell <= cursorCell ? realDeltaValue(cell) : NaN), '', '']
      const own = cell <= cursorCell ? currentValue(lane.id)(cell) : NaN
      const best = ghost ? referenceValue(lane.id, ghost)(cell) : NaN
      const realShown = lane.id === 'steer' || lane.id === 'time' || lane.id === 'x' || lane.id === 'z' ? NaN : realValue(lane.id)(cell)
      return [laneLabel(lane), text(lane, own), text(lane, realShown), text(lane, best)]
    })
    const shownM = lengthM ? ((metres % lengthM) + lengthM) % lengthM : metres
    const boxW = 22.5 * rem
    const rowH = 1.25 * rem
    const boxH = rowH * (rows.length + 1) + 0.75 * rem
    const boxX = hx + boxW + 1 * rem > width ? hx - boxW - 0.75 * rem : hx + 0.75 * rem
    const boxY = top + 0.25 * rem
    ctx.fillStyle = '#0b0e13'
    ctx.strokeStyle = COLOR.hairlineStrong
    ctx.beginPath()
    ctx.roundRect(boxX, boxY, boxW, boxH, 0.5 * rem)
    ctx.fill()
    ctx.stroke()
    const columnA = boxX + 10.5 * rem
    const columnB = boxX + 16.25 * rem
    const columnC = boxX + boxW - 0.625 * rem
    let rowY = boxY + 0.375 * rem + rowH / 2
    ctx.font = font(rem, 0.75, 600)
    ctx.textAlign = 'left'
    ctx.fillStyle = COLOR.text
    ctx.fillText(`${Math.round(shownM)} m`, boxX + 0.625 * rem, rowY)
    ctx.textAlign = 'right'
    for (const [column, name, color] of [
      [columnA, t('chart.col.this'), COLOR.you],
      [columnB, t('chart.col.driver'), COLOR.ref],
      [columnC, savedLap.value ? t('chart.col.saved') : t('chart.col.best'), COLOR.best],
    ] as const) {
      ctx.fillStyle = color
      ctx.fillRect(column - ctx.measureText(name).width - 1 * rem, rowY - 1, 0.75 * rem, 2)
      ctx.fillStyle = COLOR.text2
      ctx.fillText(name, column, rowY)
    }
    for (const [label, own, realText, best] of rows) {
      rowY += rowH
      ctx.textAlign = 'left'
      ctx.font = font(rem, 0.75)
      ctx.fillStyle = COLOR.text3
      ctx.fillText(label, boxX + 0.625 * rem, rowY)
      ctx.textAlign = 'right'
      ctx.font = font(rem, 0.75, 600)
      ctx.fillStyle = COLOR.text
      ctx.fillText(own, columnA, rowY)
      ctx.fillText(realText, columnB, rowY)
      ctx.fillText(best, columnC, rowY)
    }
  }
}

// While driving the trace scrolls on between updates, so the chart is drawn every frame.
useCanvas(draw, {
  animate: () => isLive.value && !tick.value?.paused,
  deps: [tick, meta, lapsVersion, savedLap, referenceLap, alignment, hoverX],
})

function onPointerMove(event: PointerEvent) {
  hoverX.value = event.offsetX
}
</script>

<template>
  <section class="card chart">
    <div class="legend" :aria-label="t('chart.legend')">
      <span class="label title">{{ t('chart.title') }}</span>
      <span><i style="background: var(--you)"></i>{{ t('chart.thisLap') }}</span>
      <span v-if="realName"><i style="background: var(--ref)"></i>{{ realName }}</span>
      <span><i class="thin" style="background: var(--best)"></i>{{ ghostLabel }}</span>
    </div>
    <div class="plot">
      <canvas
        ref="canvas"
        role="img"
        :aria-label="t('chart.aria')"
        @pointermove="onPointerMove"
        @pointerleave="hoverX = null"
      ></canvas>
    </div>
  </section>
</template>

<style scoped>
.chart {
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

.legend .title {
  color: var(--text-2);
  font-size: 0.875rem;
  font-weight: 600;
}

.legend span:not(.title) {
  display: flex;
  align-items: center;
  gap: 0.375rem;
}

.legend i {
  width: 1.125rem;
  height: 2px;
  border-radius: 1px;
}

.legend i.thin {
  height: 1px;
}

.plot {
  flex: 1;
  min-height: 0;
}
</style>
