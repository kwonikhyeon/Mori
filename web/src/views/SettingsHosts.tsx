// 설정's hosts (spec §3 #168): the hub and the hosts linked to it, linking
// another with what `mori pair` gave on it, and the part of 알림과 기기 a
// linked host keeps itself.
import { signal } from '@preact/signals'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { Confirm } from '../components/Confirm'
import { Icon } from '../components/Icon'
import { api } from '../lib/api'
import { versionText } from '../lib/format'
import { hello } from '../lib/hello'
import { isHere } from '../lib/hosts'
import { formatCode } from '../lib/pairing'
import { hub, others, reloadHosts, scopeOf, type HostScope } from '../lib/scope'
import { hosts } from '../lib/store'
import { errorText, toast, toastError } from '../lib/toast'
import type { Host } from '../lib/types'
import { nameOf } from './HostSwitch'
import { MAX_NAME, useFocusAfter } from './SettingsEdit'
import { ChildrenSwitch } from './SettingsPush'

/** The address of a host to link again: 호스트 연결 takes it and asks for a new code. */
export const relinkHost = signal('')

/** What 설정 says of the host it is for, after the host's name. */
export function settingsSub(h: HostScope): string {
  if (h.id) return `허브 ${nameOf(hub)}에 이은 호스트`
  return others.value.length ? '이 기기가 페어링한 허브' : '이 호스트의 알림과 기기'
}

// What the hub answered goes in the list at once; the whole list is read again after.
function keep(v: Host) {
  const list = hosts.peek()
  hosts.value = list.some((h) => h.id === v.id) ? list.map((h) => (h.id === v.id ? v : h)) : [...list, v]
  void reloadHosts()
}

function drop(id: string) {
  hosts.value = hosts.peek().filter((h) => h.id !== id)
  void reloadHosts()
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/* ---------- 연결한 호스트 ---------- */

/** The hub and the hosts linked to it: how each is, and what can be done with it. */
export function HostsCard() {
  const id = useId()
  const card = useRef<HTMLElement>(null)
  const focusAfter = useFocusAfter(card)
  const list = hosts.value
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [relaying, setRelaying] = useState<string | null>(null)
  const [ask, setAsk] = useState<Host | null>(null)
  const [removing, setRemoving] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  // The button pressed is gone with its row. select() alone does not focus in every browser.
  useLayoutEffect(() => {
    if (!editing) return
    input.current?.focus()
    input.current?.select()
  }, [editing])

  const edit = (h: Host) => {
    setEditing(h.id)
    setDraft(h.name)
  }
  const done = () => {
    const e = editing
    setEditing(null)
    if (e) focusAfter(`[data-rename="${e}"]`)
  }
  const save = async (e: Event) => {
    e.preventDefault()
    const h = list.find((x) => x.id === editing)
    const name = draft.trim()
    if (!h || !name || saving) return
    if (name === h.name) return done()
    setSaving(true)
    try {
      keep(await api.hosts.rename(h.id, name))
      done()
    } catch (err) {
      toastError(err, '이름을 바꾸지 못했습니다')
    } finally {
      setSaving(false)
    }
  }
  // The hub answers with the host even when the relay did not come on; the row says why.
  const relay = async (h: Host) => {
    if (relaying) return
    setRelaying(h.id)
    try {
      const v = await api.hosts.relay(h.id)
      keep(v)
      if (v.relay) {
        toast(`알림을 다시 이었습니다: ${v.name}`)
        focusAfter(`[data-rename="${v.id}"]`)
      } else {
        toast(`알림을 다시 잇지 못했습니다: ${v.name}`, 'error')
      }
    } catch (err) {
      toastError(err, '알림을 다시 잇지 못했습니다')
    } finally {
      setRelaying(null)
    }
  }
  const unlink = async () => {
    const h = ask
    if (!h || removing) return
    setRemoving(true)
    try {
      await api.hosts.unlink(h.id)
      drop(h.id)
      setAsk(null)
      focusAfter('.st-h2')
      toast(`연결을 해제했습니다: ${h.name}`)
    } catch (err) {
      toastError(err, '연결을 해제하지 못했습니다')
      setAsk(null)
    } finally {
      setRemoving(false)
    }
  }

  return (
    <section ref={card} class="st-card st-list" aria-labelledby={id}>
      <h2 id={id} class="st-h2" tabIndex={-1}>
        연결한 호스트 {1 + others.value.length}곳
      </h2>
      <ul class="st-hosts">
        <li>
          <HubRow />
        </li>
        {list.map((h) => (
          <li key={h.id}>
            <div class="st-div is-tight" />
            {editing === h.id ? (
              <form class="st-row st-rename" aria-label={`${h.name} 이름 바꾸기`} onSubmit={save}>
                <label class="sr-only" for={id + '-name'}>
                  이름
                </label>
                <input
                  id={id + '-name'}
                  ref={input}
                  class="input"
                  value={draft}
                  maxLength={MAX_NAME}
                  autoComplete="off"
                  onInput={(e) => setDraft(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Escape') return
                    e.preventDefault()
                    done()
                  }}
                />
                <button type="submit" class="btn btn-primary" disabled={!draft.trim()}>
                  {saving ? '저장하는 중' : '저장'}
                </button>
                <button type="button" class="btn" onClick={done}>
                  취소
                </button>
              </form>
            ) : (
              <HostRow h={h} relaying={relaying === h.id} onRelay={() => void relay(h)} onEdit={() => edit(h)} onUnlink={() => setAsk(h)} />
            )}
          </li>
        ))}
      </ul>
      <Confirm
        open={!!ask}
        title={`${ask?.name ?? ''} 연결을 해제할까요?`}
        text={
          ask && isHere(ask.url)
            ? '이 허브 자신을 가리키는 옛 항목을 목록에서 지웁니다.'
            : '이 허브가 그 호스트에 둔 연결과 알림 중계를 지웁니다. 다시 이으려면 그 호스트에서 mori pair로 새 코드를 받아야 합니다.'
        }
        confirm="연결 해제"
        danger
        busy={removing}
        onConfirm={unlink}
        onCancel={() => setAsk(null)}
      />
    </section>
  )
}

function HubRow() {
  // Before the overview, the hub's hello says its version.
  const v = hub.host.value?.version ?? hello.value?.version
  return (
    <div class="st-row">
      <span class="st-row-icon">
        <Icon name="monitor" size={20} />
      </span>
      <span class="st-row-main">
        <span class="st-row-name">
          <span class="st-name">{nameOf(hub)}</span>
          <span class="st-pill">이 호스트</span>
          <span class="st-pill">허브</span>
        </span>
        <span class="st-row-sub mono">{location.host}</span>
        <span class="st-row-sub">{['이 기기가 페어링한 곳', v && versionText(v)].filter(Boolean).join(' · ')}</span>
      </span>
    </div>
  )
}

interface HostRowProps {
  h: Host
  relaying: boolean
  onRelay: () => void
  onEdit: () => void
  onUnlink: () => void
}

function HostRow({ h, relaying, onRelay, onEdit, onUnlink }: HostRowProps) {
  const id = useId()
  // An entry for the hub itself is from before the hub knew its own address.
  const self = isHere(h.url)
  const linked = !self && h.linked
  const state = scopeOf(h.id)?.problem.value === 'unreachable' ? '닿지 못함' : '연결됨'
  return (
    <>
      <div class="st-row">
        <span class="st-row-icon">
          <Icon name="monitor" size={20} />
        </span>
        <span class="st-row-main">
          <span class="st-row-name">
            <span class="st-name">{h.name}</span>
            {!self && !h.linked && <span class="st-pill">끊김</span>}
          </span>
          <span class="st-row-sub mono">{hostOf(h.url)}</span>
          {self ? (
            <span class="st-row-sub is-wrap">이 허브 자신을 가리키는 옛 항목입니다</span>
          ) : !h.linked ? (
            <span class="st-row-sub is-wrap">그 호스트가 이 허브의 연결을 해제했거나 아직 잇지 않았습니다</span>
          ) : (
            <span class="st-row-sub">{[state, h.relay ? '알림 켬' : '알림 꺼짐', h.version && versionText(h.version)].filter(Boolean).join(' · ')}</span>
          )}
        </span>
      </div>
      {linked && !h.relay && (
        <div id={id + '-warn'} class="st-host-warn">
          <Icon name="warning" size={16} />
          <span class="st-host-warn-main">
            <span>알림 중계를 켜지 못했습니다 — 이 호스트의 승인 대기 알림이 폰에 오지 않습니다</span>
            {h.relay_error && <span class="st-host-why">{h.relay_error}</span>}
          </span>
        </div>
      )}
      <div class="st-host-acts">
        {!self && !h.linked && (
          <button
            type="button"
            class="btn btn-sm"
            onClick={() => {
              relinkHost.value = h.url
            }}
          >
            새 코드로 다시 연결
          </button>
        )}
        {/* aria-disabled, not disabled: the focus stays on the button while it works. */}
        {linked && !h.relay && (
          <button type="button" class="btn btn-sm" aria-describedby={id + '-warn'} aria-disabled={relaying || undefined} onClick={onRelay}>
            {relaying ? '다시 잇는 중' : '알림 다시 연결'}
          </button>
        )}
        {linked && (
          <button type="button" class="btn btn-sm" data-rename={h.id} aria-label={`${h.name} 이름 바꾸기`} onClick={onEdit}>
            이름 바꾸기
          </button>
        )}
        <button type="button" class="btn btn-sm btn-danger" aria-label={`${h.name} 연결 해제`} onClick={onUnlink}>
          연결 해제
        </button>
      </div>
    </>
  )
}

/* ---------- 호스트 연결 ---------- */

/** Links another host, with the link or the address and code `mori pair` gave on it. */
export function LinkHostCard() {
  const id = useId()
  const head = useRef<HTMLHeadingElement>(null)
  const codeRef = useRef<HTMLInputElement>(null)
  const [url, setUrl] = useState('')
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // 새 코드로 다시 연결, from the list or from the host's own screen: the
  // card may only now be on the screen.
  const relink = relinkHost.value
  useEffect(() => {
    if (!relink) return
    relinkHost.value = ''
    setUrl(relink)
    setCode('')
    setError('')
    codeRef.current?.focus()
  }, [relink])

  const submit = async (e: Event) => {
    e.preventDefault()
    const u = url.trim()
    if (!u || busy) return
    const known = new Set(hosts.peek().map((h) => h.id))
    setBusy(true)
    setError('')
    try {
      const v = await api.hosts.link(u, code.trim(), name.trim())
      keep(v)
      setUrl('')
      setCode('')
      setName('')
      // The button is off with the fields empty; the card keeps the focus.
      head.current?.focus()
      toast(known.has(v.id) ? `다시 이었습니다: ${v.name}` : `호스트를 이었습니다: ${v.name}`)
    } catch (err) {
      setError(errorText(err, '호스트를 잇지 못했습니다'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section class="st-card" aria-labelledby={id}>
      <h2 id={id} ref={head} class="st-h2" tabIndex={-1}>
        호스트 연결
      </h2>
      <p class="st-text">
        그 호스트에서 <code>mori pair</code>로 받은 링크를 붙여 넣거나, 주소와 코드를 넣으세요.
      </p>
      <form class="st-hostlink" noValidate onSubmit={submit}>
        <div class="field">
          <label class="field-label" for={id + '-url'}>
            페어링 링크 또는 주소
          </label>
          <input
            id={id + '-url'}
            class="input mono"
            type="text"
            inputMode="url"
            value={url}
            placeholder="https://desk.example.ts.net/pair#code=…"
            autoCapitalize="off"
            autoComplete="off"
            spellcheck={false}
            onInput={(e) => setUrl(e.currentTarget.value)}
          />
        </div>
        <div class="field">
          <label class="field-label" for={id + '-code'}>
            코드
          </label>
          <input
            id={id + '-code'}
            ref={codeRef}
            class="input mono"
            value={code}
            placeholder="XXXX-XXXX"
            maxLength={9}
            autoCapitalize="characters"
            autoComplete="off"
            autoCorrect="off"
            spellcheck={false}
            aria-describedby={id + '-code-hint'}
            onInput={(e) => setCode(formatCode(e.currentTarget.value))}
          />
          <span id={id + '-code-hint'} class="field-hint">
            링크에 코드가 들어 있으면 비워 둡니다.
          </span>
        </div>
        <div class="field">
          <label class="field-label" for={id + '-name'}>
            이름
          </label>
          <input
            id={id + '-name'}
            class="input"
            value={name}
            maxLength={MAX_NAME}
            autoComplete="off"
            aria-describedby={id + '-name-hint'}
            onInput={(e) => setName(e.currentTarget.value)}
          />
          <span id={id + '-name-hint'} class="field-hint">
            비우면 그 호스트의 이름을 씁니다.
          </span>
        </div>
        {error && (
          <p class="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" class="btn btn-primary" disabled={!url.trim()}>
          {busy ? '연결하는 중' : '연결'}
        </button>
      </form>
    </section>
  )
}

/* ---------- a linked host's 알림과 기기 ---------- */

/** What a linked host keeps of 알림과 기기 itself; the rest is the hub's. */
export function HostNoticesCard() {
  const id = useId()
  return (
    <section class="st-card st-list" aria-labelledby={id}>
      <h2 id={id} class="st-h2">
        알림과 기기
      </h2>
      <ChildrenSwitch />
      <p class="st-hint">이 기기가 받을 알림, 페어링한 기기, 호스트 연결은 허브 {nameOf(hub)} 설정에서 바꿉니다.</p>
      <a class="btn btn-sm st-hub-link" href={hub.href({ name: 'settings' })}>
        허브 설정 열기
      </a>
    </section>
  )
}
