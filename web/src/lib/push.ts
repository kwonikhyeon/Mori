// Web Push on this device (spec §3 #129): ask, subscribe with the host's
// VAPID key, and hand the subscription to the server, which keeps one per
// device. The kinds a device wants go with its subscription.
import { api, ApiError } from './api'
import { osName } from './pairing'
import { load, save } from './storage'
import type { PushKind, PushSubscriptionView } from './types'

export const KINDS: PushKind[] = ['blocked', 'waiting', 'error', 'exited']
/** What the server sends when a subscription names no kinds. */
export const DEFAULT_KINDS: PushKind[] = ['blocked', 'waiting', 'error']
export const KIND_LABEL: Record<PushKind, string> = { blocked: '승인 대기', waiting: '입력 대기', error: '오류', exited: '종료' }
const KINDS_KEY = 'mori.push.kinds'

export const DENIED = '알림이 막혀 있습니다. 브라우저의 사이트 설정에서 알림을 허용하세요.'

export type Support = 'ok' | 'insecure' | 'ios-browser' | 'unsupported'

/** Opened from the home screen, not in a browser tab. */
export function isStandalone(): boolean {
  if ((navigator as { standalone?: boolean }).standalone === true) return true
  return typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches
}

export function isIOS(): boolean {
  const os = osName(navigator.userAgent, navigator.maxTouchPoints)
  return os === 'iPhone' || os === 'iPad'
}

/** Whether this page can turn notifications on, and if not, why. */
export function pushSupport(): Support {
  if (!window.isSecureContext) return 'insecure'
  // Safari on iOS has web push only in an app added to the home screen.
  if (isIOS() && !isStandalone()) return 'ios-browser'
  const w = window as { PushManager?: unknown; Notification?: unknown }
  if (!navigator.serviceWorker || !w.PushManager || !w.Notification) return 'unsupported'
  return 'ok'
}

export function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

/** Whether sub was made with key. A browser that does not say is trusted. */
export function sameKey(sub: PushSubscription, key: string): boolean {
  const k = sub.options?.applicationServerKey
  if (!k) return true
  const a = new Uint8Array(k)
  const b = fromB64url(key)
  return a.length === b.length && a.every((x, i) => x === b[i])
}

async function current(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker?.getRegistration()
  return (await reg?.pushManager.getSubscription()) ?? null
}

/**
 * Turns notifications on for this device. Call it straight from the tap:
 * the permission prompt comes before anything is awaited, as iOS asks.
 */
export async function enablePush(key: string, kinds: PushKind[]): Promise<PushSubscriptionView> {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new ApiError(0, 'permission', permission === 'denied' ? DENIED : '알림을 허용하지 않았습니다')
  await navigator.serviceWorker.register('/sw.js')
  const reg = await navigator.serviceWorker.ready
  let sub = await reg.pushManager.getSubscription()
  if (sub && !sameKey(sub, key)) {
    // Made for a key the host no longer has: pushes would not reach it.
    await sub.unsubscribe()
    sub = null
  }
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64url(key) })
    } catch {
      throw new ApiError(0, 'subscribe', '브라우저가 알림 구독을 만들지 못했습니다')
    }
  }
  return api.push.subscribe(sub.toJSON(), kinds)
}

/** Turns notifications off for this device: the server first, so a failure changes nothing. */
export async function disablePush(): Promise<void> {
  await api.push.unsubscribe('')
  await (await current())?.unsubscribe()
}

/** Changes which kinds this device is told about. */
export async function setKinds(kinds: PushKind[]): Promise<PushSubscriptionView> {
  const sub = await current()
  if (!sub) throw new ApiError(0, 'gone', '이 기기의 알림 구독이 없습니다. 알림을 다시 켜 주세요')
  return api.push.subscribe(sub.toJSON(), kinds)
}

export interface PushState {
  /** The server's copy of this device's subscription; null when off. */
  on: PushSubscriptionView | null
  permission: NotificationPermission
}

/** On only when the browser and the server hold the same subscription. */
export async function readPush(key: string): Promise<PushState> {
  const permission = Notification.permission
  if (permission !== 'granted') return { on: null, permission }
  const sub = await current()
  if (!sub || !sameKey(sub, key)) return { on: null, permission }
  const list = await api.push.list()
  return { on: list.find((s) => s.endpoint === sub.endpoint) ?? null, permission }
}

/** The kinds this device chose, kept for while its notifications are off. */
export function loadKinds(): PushKind[] {
  const v = load<unknown>(KINDS_KEY, DEFAULT_KINDS)
  return Array.isArray(v) ? KINDS.filter((k) => v.includes(k)) : DEFAULT_KINDS
}

export function saveKinds(kinds: PushKind[]): void {
  save(KINDS_KEY, KINDS.filter((k) => kinds.includes(k)))
}
