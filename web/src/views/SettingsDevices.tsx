// The devices of Settings (spec §6.2, §3 #9): who may use this host, taking
// that away, and a code for a new device, with its QR and the time it has.
import { useEffect, useId, useRef, useState } from 'preact/hooks'
import { Confirm } from '../components/Confirm'
import { QR } from '../components/QR'
import { api } from '../lib/api'
import { toPairing } from '../lib/boot'
import { now } from '../lib/clock'
import { copyText } from '../lib/copy'
import { browserName } from '../lib/pairing'
import { isStandalone } from '../lib/push'
import { conn } from '../lib/store'
import { relTime } from '../lib/time'
import { errorText, toast, toastError } from '../lib/toast'
import type { Device } from '../lib/types'

/** How long a code lasts (spec §6.2), when the server's clock cannot be trusted. */
const CODE_LIFE = 5 * 60_000
const POLL = 3_000

interface Code {
  code: string
  link: string
  /** When it stops working, by this browser's clock. */
  until: number
}

/** 4:51 */
export function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** This device first, then the one seen last. */
function sorted(list: Device[]): Device[] {
  return [...list].sort((a, b) => Number(b.current) - Number(a.current) || b.last_seen_ms - a.last_seen_ms)
}

function deviceSub(d: Device, at: number): string {
  const b = browserName(d.user_agent)
  const parts = [b && !d.name.includes(b) ? b : '']
  if (d.current) parts.push(isStandalone() ? '홈 화면 앱' : '')
  else parts.push(`${relTime(d.last_seen_ms, at)} 접속`)
  return parts.filter(Boolean).join(' · ')
}

export interface DeviceCardsProps {
  variant: 'pc' | 'phone'
}

export function DeviceCards({ variant }: DeviceCardsProps) {
  const id = useId()
  const [list, setList] = useState<Device[] | null>(null)
  const [error, setError] = useState('')
  const [code, setCode] = useState<Code | null>(null)
  const [expired, setExpired] = useState(false)
  const [making, setMaking] = useState(false)
  const [tick, setTick] = useState(0)
  const [ask, setAsk] = useState<Device | null>(null)
  const [revoking, setRevoking] = useState(false)
  // The row asked about is gone with its button: the focus goes to the card.
  const [refocus, setRefocus] = useState(0)
  const head = useRef<HTMLHeadingElement>(null)
  // The devices there were before the code was made: one more is the one it paired.
  const known = useRef<Set<string> | null>(null)
  const codeRef = useRef<Code | null>(null)
  codeRef.current = code
  const seq = useRef(0)

  const load = async () => {
    const n = ++seq.current
    try {
      const ds = await api.devices()
      if (n !== seq.current) return
      setList(ds)
      setError('')
      if (!codeRef.current) return
      // Not read before the code: the devices from now on are the ones there were.
      if (!known.current) known.current = new Set(ds.map((d) => d.id))
      const fresh = ds.find((d) => !known.current!.has(d.id))
      if (fresh) {
        known.current = null
        setCode(null)
        toast(`${fresh.name} 기기를 연결했습니다`)
      }
    } catch (e) {
      if (n === seq.current) setError(errorText(e, '기기 목록을 읽지 못했습니다'))
    }
  }

  const open = conn.value === 'open'
  const first = useRef(true)
  useEffect(() => {
    if (first.current || open) void load()
    first.current = false
  }, [open])

  // The time left, every second, and the device list while the code waits for one.
  useEffect(() => {
    if (!code) return
    const t = setInterval(() => {
      const at = Date.now()
      if (at >= code.until) {
        known.current = null
        setCode(null)
        setExpired(true)
      } else setTick(at)
    }, 1000)
    const p = setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, POLL)
    return () => {
      clearInterval(t)
      clearInterval(p)
    }
  }, [code])

  useEffect(() => {
    if (refocus) head.current?.focus()
  }, [refocus])

  const make = async () => {
    if (making) return
    setMaking(true)
    try {
      // Asked first: a device cannot pair with a code that is not there yet.
      const before = await api.devices().catch(() => list)
      const p = await api.pairCode('')
      const at = Date.now()
      const ttl = p.expires_ms - at
      known.current = before ? new Set(before.map((d) => d.id)) : null
      if (before) setList(before)
      setTick(at)
      setExpired(false)
      setCode({ code: p.code, link: new URL(p.url, location.origin).href, until: at + (ttl > 0 && ttl <= CODE_LIFE ? ttl : CODE_LIFE) })
    } catch (e) {
      toastError(e, '코드를 만들지 못했습니다')
    } finally {
      setMaking(false)
    }
  }

  const revoke = async () => {
    const d = ask
    if (!d || revoking) return
    setRevoking(true)
    try {
      if (d.current) {
        await api.logout()
        setAsk(null)
        toPairing()
        return
      }
      await api.revokeDevice(d.id)
      setList((l) => l && l.filter((x) => x.id !== d.id))
      setAsk(null)
      setRefocus((n) => n + 1)
      toast(`${d.name} 연결을 해제했습니다`)
    } catch (e) {
      toastError(e, '연결을 해제하지 못했습니다')
      setAsk(null)
      void load()
    } finally {
      setRevoking(false)
    }
  }

  const copy = async () => {
    if (!code) return
    if (await copyText(code.link)) toast('링크를 복사했습니다')
    else toast('복사하지 못했습니다', 'error')
  }

  const ds = list ? sorted(list) : []
  const at = now.value
  const left = code ? code.until - Math.max(tick, 0) : 0

  return (
    <>
      <section class="st-card st-list" aria-labelledby={id + '-dev'}>
        <h2 id={id + '-dev'} ref={head} class="st-h2" tabIndex={-1}>
          기기{list ? ` ${list.length}` : ''}
        </h2>
        {error && !list && (
          <p class="form-error" role="alert">
            {error}
          </p>
        )}
        {list && ds.length === 0 && <p class="st-none">연결된 기기가 없습니다.</p>}
        {ds.map((d, i) => {
          const sub = deviceSub(d, at)
          return (
            <div key={d.id}>
              {i > 0 && <div class="st-div is-tight" />}
              <div class="st-row">
                <span class="st-row-main">
                  <span class="st-row-name">
                    <span class="st-name">{d.name}</span>
                    {d.current && <span class="st-pill">이 기기</span>}
                  </span>
                  {sub && <span class="st-row-sub">{sub}</span>}
                </span>
                <button
                  type="button"
                  class="btn btn-danger st-revoke"
                  aria-label={d.current ? '이 기기 연결 해제' : `${d.name} 연결 해제`}
                  onClick={() => setAsk(d)}
                >
                  해제
                </button>
              </div>
            </div>
          )
        })}
      </section>

      <section class="st-card" aria-labelledby={id + '-pair'}>
        <h2 id={id + '-pair'} class="st-h2">
          새 기기 페어링
        </h2>
        {code ? (
          <>
            <div class="st-pair">
              <QR value={code.link} size={variant === 'pc' ? 152 : 104} label="페어링 QR 코드" />
              <div class="st-pair-code">
                <span class="st-pair-label">코드</span>
                <span class="st-pair-value mono">{code.code}</span>
                <span class="st-pair-left">{mmss(left)} 남음 · 한 번만 쓸 수 있습니다</span>
              </div>
            </div>
            <div class="st-field">
              <span id={id + '-link'} class="field-label">
                링크
              </span>
              <div class="st-link">
                <span class="st-link-text mono" aria-labelledby={id + '-link'} role="textbox" aria-readonly="true">
                  {code.link}
                </span>
                <button type="button" class="btn btn-primary" onClick={copy}>
                  복사
                </button>
              </div>
            </div>
            <p class="st-hint">새 기기에서 QR을 찍거나 링크를 여세요.</p>
          </>
        ) : (
          <p class="st-text">
            {expired ? '코드가 만료되었습니다. 새 코드를 만드세요.' : '새 기기에서 열 링크와 QR 코드를 만듭니다. 코드는 5분 동안 한 번만 쓸 수 있습니다.'}
          </p>
        )}
        {/* One button in both views, so the focus stays on it when the code comes. */}
        <button type="button" class={'btn btn-block st-btn' + (code ? '' : ' btn-primary')} onClick={make}>
          {making ? '만드는 중…' : code || expired ? '새 코드 만들기' : '코드 만들기'}
        </button>
      </section>

      <Confirm
        open={!!ask}
        title={ask?.current ? '이 기기의 연결을 해제할까요?' : `${ask?.name ?? ''} 연결을 해제할까요?`}
        text={
          ask?.current
            ? '이 브라우저는 다시 페어링해야 이 호스트를 쓸 수 있습니다.'
            : '그 기기는 다시 페어링해야 이 호스트를 쓸 수 있습니다.'
        }
        confirm="연결 해제"
        danger
        busy={revoking}
        onConfirm={revoke}
        onCancel={() => setAsk(null)}
      />
    </>
  )
}
