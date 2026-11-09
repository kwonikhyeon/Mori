// Short notes at the bottom of the screen: what an action did, or why it
// failed. Each goes away by itself.
import { signal } from '@preact/signals'
import { ApiError } from './api'

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'error'
}

export const toasts = signal<Toast[]>([])

let next = 1
const LIFE = 4_000
const MAX = 3

export function toast(text: string, kind: Toast['kind'] = 'info'): void {
  const t: Toast = { id: next++, text, kind }
  toasts.value = [...toasts.value, t].slice(-MAX)
  setTimeout(() => dismiss(t.id), kind === 'error' ? LIFE * 1.5 : LIFE)
}

export function dismiss(id: number): void {
  if (toasts.value.some((t) => t.id === id)) toasts.value = toasts.value.filter((t) => t.id !== id)
}

/** The server's message for a failed call, else what the caller says. */
export function errorText(e: unknown, fallback = '요청이 실패했습니다'): string {
  return e instanceof ApiError ? e.message : fallback
}

export function toastError(e: unknown, fallback?: string): void {
  toast(errorText(e, fallback), 'error')
}
