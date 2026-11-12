import { onBeforeUnmount, onMounted, useTemplateRef, watch, type WatchSource } from 'vue'
import { locale } from '../i18n'

export interface CanvasFrame {
  ctx: CanvasRenderingContext2D
  width: number
  height: number
  /** CSS pixels per rem, so drawings scale with the rest of the UI. */
  rem: number
  now: number
}

export interface CanvasOptions {
  /** Redraw on every frame while this is true, such as while the car moves between updates. */
  animate?: () => boolean
  /** Redraw when any of these change. Size, display density and language are always watched. */
  deps?: WatchSource[]
}

/**
 * Draws on the component's `ref="canvas"` element when something changed, rather
 * than on every frame: an idle dashboard left open for hours shouldn't cost battery.
 */
export function useCanvas(draw: (frame: CanvasFrame) => void, options: CanvasOptions = {}) {
  const canvas = useTemplateRef<HTMLCanvasElement>('canvas')
  let observer: ResizeObserver | undefined
  let density: MediaQueryList | undefined
  let scheduled = 0
  let width = 0
  let height = 0
  let rem = 16

  function requestDraw() {
    if (!scheduled) scheduled = requestAnimationFrame(frame)
  }

  function resize() {
    const element = canvas.value
    if (!element) return
    const ratio = window.devicePixelRatio || 1
    width = element.clientWidth
    height = element.clientHeight
    element.width = Math.round(width * ratio)
    element.height = Math.round(height * ratio)
    rem = parseFloat(getComputedStyle(document.documentElement).fontSize)
    requestDraw()
  }

  // Moving the window to a screen of another density changes no size, only the pixel ratio.
  function watchDensity() {
    density?.removeEventListener('change', onDensityChange)
    density = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
    density.addEventListener('change', onDensityChange)
  }

  function onDensityChange() {
    resize()
    watchDensity()
  }

  function frame(now: number) {
    scheduled = 0
    const element = canvas.value
    const ctx = element?.getContext('2d')
    if (element && ctx && width > 0 && height > 0) {
      const ratio = element.width / width
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
      ctx.clearRect(0, 0, width, height)
      draw({ ctx, width, height, rem, now })
    }
    if (options.animate?.()) requestDraw()
  }

  watch([locale, ...(options.deps ?? [])], requestDraw)
  if (options.animate) watch(options.animate, (on) => on && requestDraw())

  onMounted(() => {
    resize()
    observer = new ResizeObserver(resize)
    observer.observe(canvas.value!)
    watchDensity()
  })

  onBeforeUnmount(() => {
    observer?.disconnect()
    density?.removeEventListener('change', onDensityChange)
    cancelAnimationFrame(scheduled)
  })

  return { requestDraw }
}
