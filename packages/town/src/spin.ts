import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';

/** How far a press can wander, in pixels, and still be a click on a plot rather than a turn. */
export const CLICK_SLOP = 5;
/** Radians per pixel dragged: dragging 800 pixels turns the town once round. */
export const TURN_RATE = (2 * Math.PI) / 800;
/** One press of an arrow key. */
export const KEY_STEP = Math.PI / 12;

export const isDrag = (dx: number, dy: number) => Math.hypot(dx, dy) > CLICK_SLOP;
/** The angle `dx` pixels into a drag that started at `from`. Dragging right carries the front of the town to the right. */
export const dragged = (from: number, dx: number) => from - dx * TURN_RATE;
/** The same angle in (-π, π]. */
export function wrap(angle: number): number {
  const a = angle % (2 * Math.PI);
  return a > Math.PI ? a - 2 * Math.PI : a <= -Math.PI ? a + 2 * Math.PI : a;
}
/** Facing the way the town first appears. */
export const atHome = (angle: number) => Math.abs(wrap(angle)) < 1e-9;

/**
 * Turning speed in radians per millisecond when the pointer lets go at time `at`, from the drag's `[time, angle]` trail:
 * the last 80 ms of movement, or 0 if the pointer had stopped before letting go.
 */
export function releaseSpeed(trail: ReadonlyArray<readonly [number, number]>, at: number): number {
  const recent = trail.filter(([t]) => at - t <= 80);
  if (recent.length < 2 || at - recent[recent.length - 1]![0] > 40) return 0;
  const [t0, a0] = recent[0]!, [t1, a1] = recent[recent.length - 1]!;
  return t1 > t0 ? (a1 - a0) / (t1 - t0) : 0;
}
/** The glide after a flick, `ms` later: speed halves every 120 ms and stops once it is too slow to see. */
export function glide(speed: number, ms: number): number {
  const next = speed * 0.5 ** (ms / 120);
  return Math.abs(next) < 2e-5 ? 0 : next;
}

/**
 * Turns the town: drag (or flick) sideways, or the arrow keys, with Home to face the start again. A press that barely
 * moves stays a click. Without `onSpin`, nothing turns and there are no handlers.
 */
export function useSpin(angle: number, onSpin: ((angle: number) => void) | undefined) {
  const current = useRef(angle);
  current.current = angle;
  const change = useRef(onSpin);
  change.current = onSpin;
  const press = useRef<{id: number; x: number; y: number; from: number; turning: boolean; trail: Array<[number, number]>} | null>(null);
  const swallowClick = useRef(false);
  const frame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const turn = (to: number) => { cancelAnimationFrame(frame.current); change.current?.(to); };
  if (!onSpin) return {handlers: {}, home: () => {}};

  const handlers = {
    onPointerDown(event: PointerEvent<Element>) {
      cancelAnimationFrame(frame.current);
      swallowClick.current = false;
      if (event.button === 0) press.current = {id: event.pointerId, x: event.clientX, y: event.clientY, from: current.current, turning: false, trail: []};
    },
    onPointerMove(event: PointerEvent<Element>) {
      const p = press.current;
      if (!p || p.id !== event.pointerId) return;
      if (!p.turning) {
        if (!isDrag(event.clientX - p.x, event.clientY - p.y)) return;
        // Turn from here, so the town doesn't jump by the slop.
        p.turning = true;
        p.x = event.clientX;
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      const to = dragged(p.from, event.clientX - p.x);
      p.trail.push([event.timeStamp, to]);
      turn(to);
    },
    onPointerUp(event: PointerEvent<Element>) {
      const p = press.current;
      press.current = null;
      if (!p?.turning) return;
      // The click that ends a drag selects nothing.
      swallowClick.current = true;
      let speed = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : releaseSpeed(p.trail, event.timeStamp);
      let at = current.current, last = performance.now();
      const step = (now: number) => {
        const ms = now - last;
        last = now;
        speed = glide(speed, ms);
        if (!speed) return;
        at += speed * ms;
        change.current?.(at);
        frame.current = requestAnimationFrame(step);
      };
      if (speed) frame.current = requestAnimationFrame(step);
    },
    onPointerCancel() { press.current = null; },
    onClickCapture(event: MouseEvent) {
      if (!swallowClick.current) return;
      swallowClick.current = false;
      event.stopPropagation();
      event.preventDefault();
    },
    onKeyDown(event: KeyboardEvent) {
      const to = event.key === 'ArrowLeft' ? current.current + KEY_STEP : event.key === 'ArrowRight' ? current.current - KEY_STEP : event.key === 'Home' ? 0 : null;
      if (to === null) return;
      event.preventDefault();
      turn(to);
    },
  };
  return {handlers, home: () => turn(0)};
}
