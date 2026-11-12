// The notification cards of Settings (spec §3 #129, #78, #82): what a
// notification looks like and a test one, this device on or off, the states
// it is told about and, for the whole host, the terminals sessions open. That
// last one is a linked host's own too (#168), so it is a piece of its own.
import { useEffect, useId, useRef, useState } from 'preact/hooks'
import { Icon } from '../components/Icon'
import { api } from '../lib/api'
import { hostLabel } from '../lib/boot'
import { browserName, osName } from '../lib/pairing'
import {
  DEFAULT_KINDS, disablePush, enablePush, isIOS, isStandalone, KIND_LABEL, KINDS, loadKinds, pushSupport, readPush, saveKinds, setKinds,
  type Support,
} from '../lib/push'
import { useHost } from '../lib/scope'
import { conn } from '../lib/store'
import { errorText, toast, toastError } from '../lib/toast'
import type { PushKind, PushSubscriptionView } from '../lib/types'
import { onWake } from '../lib/wake'

type Server = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ok'; key: string }
type Busy = '' | 'toggle' | 'kinds' | 'test'

const SUPPORT_TEXT: Record<Exclude<Support, 'ok'>, string> = {
  insecure: 'https 주소에서만 알림을 켤 수 있습니다',
  'ios-browser': '홈 화면에 추가한 앱에서만 켤 수 있습니다',
  unsupported: '이 브라우저는 웹 알림을 지원하지 않습니다',
}

/** "iPhone · 홈 화면 앱", "Mac · Chrome": which of the devices this is. */
function thisDevice(): string {
  const ua = navigator.userAgent
  return [osName(ua, navigator.maxTouchPoints), isStandalone() ? '홈 화면 앱' : browserName(ua)].filter(Boolean).join(' · ') || '이 기기'
}

/** What a person can do about notifications that cannot be turned on here. */
function noteText(support: Support, permission: NotificationPermission): string {
  if (support === 'insecure') return '브라우저는 https 주소에서만 웹 알림을 허락합니다. Tailscale의 https 주소로 여세요.'
  const ios = isIOS()
  if (support === 'ok' && permission === 'denied')
    return ios
      ? '설정 앱의 알림에서 이 앱의 알림을 허용하면 여기서 켤 수 있습니다.'
      : '브라우저의 사이트 설정에서 이 사이트의 알림을 허용하면 여기서 켤 수 있습니다.'
  if (!ios) return ''
  const who = osName(navigator.userAgent, navigator.maxTouchPoints) === 'iPad' ? 'iPad는' : 'iPhone은'
  return `${who} 홈 화면에 추가한 앱에서만 알림을 받습니다.` + (isStandalone() ? '' : ' Safari의 공유 → 홈 화면에 추가로 앱을 만든 뒤 거기서 켜세요.')
}

export function PushCards() {
  const id = useId()
  const [support] = useState(pushSupport)
  const [server, setServer] = useState<Server>({ state: 'loading' })
  const [on, setOn] = useState<PushSubscriptionView | null>(null)
  const [permission, setPermission] = useState<NotificationPermission>(() => (support === 'ok' ? Notification.permission : 'default'))
  const [local, setLocal] = useState(loadKinds)
  const [busy, setBusyState] = useState<Busy>('')
  // What a change asks for, shown while it is on its way.
  const [want, setWant] = useState<boolean | null>(null)
  const [wantKinds, setWantKinds] = useState<PushKind[] | null>(null)
  const busyRef = useRef<Busy>('')
  const seq = useRef(0)

  const setBusy = (b: Busy) => {
    busyRef.current = b
    setBusyState(b)
  }

  const load = async () => {
    // A change on its way says how things are once it is done.
    if (busyRef.current) return
    const n = ++seq.current
    try {
      const { key } = await api.push.key()
      const st = support === 'ok' ? await readPush(key) : null
      if (n !== seq.current || busyRef.current) return
      setServer({ state: 'ok', key })
      if (st) {
        setOn(st.on)
        setPermission(st.permission)
      }
    } catch (e) {
      if (n !== seq.current || busyRef.current) return
      setServer({ state: 'error', message: errorText(e, '알림 설정을 읽지 못했습니다') })
    }
  }

  // Again when the stream comes back, and when the page is seen again:
  // the permission may have been changed in the browser's settings.
  const open = conn.value === 'open'
  const first = useRef(true)
  useEffect(() => {
    if (first.current || open) void load()
    first.current = false
  }, [open])
  useEffect(() => onWake(() => void load()), [])

  /** Starts a change: another one waits until it is done. */
  const begin = (b: Busy) => {
    setBusy(b)
    seq.current++
  }

  const isOn = want ?? !!on
  const kinds = wantKinds ?? (on ? (on.kinds.length ? on.kinds : DEFAULT_KINDS) : local)
  const ready = server.state === 'ok'
  const canPush = support === 'ok' && ready && permission !== 'denied'

  const keep = (v: PushSubscriptionView) => {
    const ks = v.kinds.length ? v.kinds : DEFAULT_KINDS
    setOn(v)
    setLocal(ks)
    saveKinds(ks)
  }

  const toggle = (el: HTMLInputElement) => {
    const next = el.checked
    if (busyRef.current || server.state !== 'ok') {
      el.checked = !next
      return
    }
    begin('toggle')
    setWant(next)
    // Straight from the tap, so the browser lets the page ask.
    const done = next ? enablePush(server.key, kinds.length ? kinds : DEFAULT_KINDS).then(keep) : disablePush().then(() => setOn(null))
    done
      .then(() => toast(next ? '이 기기에서 알림을 켰습니다' : '이 기기에서 알림을 껐습니다'))
      .catch((e) => toastError(e, next ? '알림을 켜지 못했습니다' : '알림을 끄지 못했습니다'))
      .finally(() => {
        setWant(null)
        setPermission(Notification.permission)
        setBusy('')
      })
  }

  const pick = (k: PushKind, el: HTMLInputElement) => {
    const checked = el.checked
    if (busyRef.current) {
      el.checked = !checked
      return
    }
    const next = KINDS.filter((x) => (x === k ? checked : kinds.includes(x)))
    if (!on) {
      // Kept for when this device turns notifications on.
      setLocal(next)
      saveKinds(next)
      return
    }
    begin('kinds')
    setWantKinds(next)
    // No kinds would mean the server's defaults: off is what was asked.
    const done = next.length
      ? setKinds(next).then(keep)
      : disablePush().then(() => {
          setOn(null)
          setLocal([])
          saveKinds([])
          toast('알릴 상태를 모두 꺼서 이 기기의 알림을 껐습니다')
        })
    done
      .catch((e) => {
        toastError(e, '알릴 상태를 바꾸지 못했습니다')
        return true
      })
      .then((failed) => {
        setWantKinds(null)
        setBusy('')
        if (failed === true) void load()
      })
  }

  const test = () => {
    if (busyRef.current || !on) return
    begin('test')
    api.push
      .test()
      .then(
        () => {
          toast('시험 알림을 보냈습니다')
          return false
        },
        (e) => {
          toastError(e, '시험 알림을 보내지 못했습니다')
          return true
        },
      )
      .then((failed) => {
        setBusy('')
        // A subscription the push service no longer has is gone from the server too.
        if (failed) void load()
      })
  }

  const sub =
    server.state === 'error'
      ? server.message
      : support !== 'ok'
        ? SUPPORT_TEXT[support]
        : permission === 'denied'
          ? '알림이 막혀 있습니다'
          : thisDevice()
  const note = server.state === 'error' ? '' : noteText(support, permission)

  return (
    <>
      <section class="st-card" aria-labelledby={id + '-look'}>
        <h2 id={id + '-look'} class="st-h2">
          이렇게 알립니다
        </h2>
        <div class="st-preview" aria-hidden="true">
          <span class="st-preview-icon">
            <Icon name="bell" size={20} />
          </span>
          <span class="st-preview-main">
            <span class="st-preview-app">Mori</span>
            <span class="st-preview-title">{hostLabel.value || '이 호스트'} · 승인 대기</span>
            <span class="st-preview-body">세션 이름 — 프로그램이 보낸 메시지</span>
          </span>
        </div>
        <p class="sr-only">
          알림 제목은 호스트 이름과 상태, 본문은 세션 이름과 프로그램이 보낸 메시지입니다.
        </p>
        <button
          type="button"
          class="btn btn-block st-btn"
          disabled={!on}
          aria-describedby={on ? undefined : id + '-test'}
          onClick={test}
        >
          <Icon name="bell" size={18} />
          {busy === 'test' ? '보내는 중…' : '시험 알림 보내기'}
        </button>
        {!on && (
          <p id={id + '-test'} class="st-hint">
            이 기기에서 알림을 켜면 보낼 수 있습니다.
          </p>
        )}
      </section>

      <section class="st-card st-list" aria-labelledby={id + '-push'}>
        <h2 id={id + '-push'} class="st-h2">
          알림
        </h2>
        <label class="st-row">
          <span class="st-row-main">
            <span id={id + '-on'} class="st-row-name">
              이 기기에서 알림 받기
            </span>
            <span id={id + '-on-sub'} class="st-row-sub">
              {sub}
            </span>
          </span>
          <input
            type="checkbox"
            role="switch"
            class="st-check"
            checked={isOn}
            disabled={!canPush}
            aria-labelledby={id + '-on'}
            aria-describedby={id + '-on-sub'}
            onChange={(e) => toggle(e.currentTarget)}
          />
        </label>
        <div class="st-div" />
        <fieldset class="st-kinds" disabled={!canPush}>
          <legend>알릴 상태</legend>
          {KINDS.map((k) => (
            <label key={k} class="st-row st-kind">
              <span class={`st-dot st-dot-${k}`} aria-hidden="true" />
              <span class="st-kind-name">{KIND_LABEL[k]}</span>
              <input type="checkbox" class="st-check" checked={kinds.includes(k)} onChange={(e) => pick(k, e.currentTarget)} />
            </label>
          ))}
        </fieldset>
        <div class="st-div" />
        <ChildrenSwitch />
        {note && <p class="st-note">{note}</p>}
      </section>
    </>
  )
}

/**
 * 하위 터미널도 알림: a setting of the whole host the screen is on, for every
 * device. Read from that host, again when its stream comes back; the switch
 * is there once the host has said how it is.
 */
export function ChildrenSwitch() {
  const h = useHost()
  const id = useId()
  // What the host said, null until it has; and whether the last read failed.
  const [children, setChildren] = useState<boolean | null>(null)
  const [failed, setFailed] = useState(false)
  // What a change asks for, shown while it is on its way.
  const [want, setWant] = useState<boolean | null>(null)
  const busy = useRef(false)
  const seq = useRef(0)

  const load = async () => {
    // A change on its way says how things are once it is done.
    if (busy.current) return
    const n = ++seq.current
    try {
      const s = await h.api.push.settings()
      if (n !== seq.current || busy.current) return
      setChildren(s.children)
      setFailed(false)
    } catch {
      if (n !== seq.current || busy.current) return
      setFailed(true)
    }
  }

  const open = h.conn.value === 'open'
  const first = useRef(true)
  useEffect(() => {
    if (first.current || open) void load()
    first.current = false
  }, [open])
  useEffect(() => onWake(() => void load()), [])

  const pick = (el: HTMLInputElement) => {
    const v = el.checked
    if (busy.current || failed || children === null) {
      el.checked = !v
      return
    }
    busy.current = true
    seq.current++
    setWant(v)
    h.api.push
      .putSettings({ children: v })
      .then((s) => setChildren(s.children))
      .catch((e) => toastError(e, '설정을 바꾸지 못했습니다'))
      .finally(() => {
        busy.current = false
        setWant(null)
      })
  }

  return (
    <label class="st-row">
      <span class="st-row-main">
        <span id={id + '-name'} class="st-row-name">
          하위 터미널도 알림
        </span>
        <span id={id + '-sub'} class="st-row-sub is-wrap">
          {failed ? '설정을 읽지 못했습니다. 연결되면 다시 읽습니다.' : '세션 안에서 따로 연 터미널까지 알립니다. 이 호스트의 모든 기기에 적용됩니다.'}
        </span>
      </span>
      {children === null && !failed ? (
        <span class="st-check" aria-hidden="true" />
      ) : (
        <input
          type="checkbox"
          role="switch"
          class="st-check"
          checked={want ?? !!children}
          disabled={failed}
          aria-labelledby={id + '-name'}
          aria-describedby={id + '-sub'}
          onChange={(e) => pick(e.currentTarget)}
        />
      )}
    </label>
  )
}
