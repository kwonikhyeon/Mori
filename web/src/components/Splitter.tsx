// The handle between two panes (spec §3 #119): drag it, or focus it and
// use the arrows, Home and End; a double click goes back to the default.
import type { JSX } from 'preact'
import { useRef } from 'preact/hooks'
import { keyWidth } from '../lib/resize'

export interface SplitterProps {
  label: string
  /** The pane's width as drawn. */
  value: number
  min: number
  max: number
  /** 1: the pane is left of the handle and grows to the right; -1: it is right of it. */
  dir: 1 | -1
  /** The id of the pane it sizes. */
  controls?: string
  /** Every step of a drag or a key. */
  onChange: (w: number) => void
  /** Where a drag or a key ended: the width to remember. */
  onCommit: (w: number) => void
  onReset: () => void
  class?: string
  style?: JSX.CSSProperties
}

interface Drag {
  id: number
  x: number
  from: number
  last: number
}

export function Splitter(p: SplitterProps) {
  const drag = useRef<Drag | null>(null)
  const clamp = (w: number) => Math.min(p.max, Math.max(p.min, Math.round(w)))

  const down = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drag.current = { id: e.pointerId, x: e.clientX, from: p.value, last: p.value }
    e.currentTarget.dataset.dragging = ''
    document.documentElement.classList.add('is-resizing')
  }

  const move = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || e.pointerId !== d.id) return
    const w = clamp(d.from + p.dir * (e.clientX - d.x))
    if (w === d.last) return
    d.last = w
    p.onChange(w)
  }

  const end = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || e.pointerId !== d.id) return
    drag.current = null
    delete e.currentTarget.dataset.dragging
    document.documentElement.classList.remove('is-resizing')
    if (d.last !== d.from) p.onCommit(d.last)
  }

  const key = (e: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
    const w = keyWidth(p.value, p, p.dir, e)
    if (w === null) return
    e.preventDefault()
    if (w === p.value) return
    p.onChange(w)
    p.onCommit(w)
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={p.label}
      aria-controls={p.controls}
      aria-valuenow={p.value}
      aria-valuemin={p.min}
      aria-valuemax={p.max}
      tabIndex={0}
      class={'splitter' + (p.class ? ' ' + p.class : '')}
      style={p.style}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onKeyDown={key}
      onDblClick={p.onReset}
    />
  )
}
