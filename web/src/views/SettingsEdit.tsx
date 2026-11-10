// What Settings edits for the whole host: the folders of the list (spec §3
// #37) and the presets a session starts (#42). It also shows the hosts
// linked to this hub (#168).
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks'
import type { RefObject } from 'preact'
import { Confirm } from '../components/Confirm'
import { Icon } from '../components/Icon'
import { api } from '../lib/api'
import { formatArgv, parseArgv } from '../lib/argv'
import { shortPath } from '../lib/format'
import { isHere } from '../lib/hosts'
import { apply, folders, hosts, presets } from '../lib/store'
import { errorText, toast, toastError } from '../lib/toast'
import type { FolderView, Preset } from '../lib/types'
import { FolderPicker } from './FolderPicker'

/** Characters in a name people give (the server's maxTitle). */
const MAX_NAME = 100

/** Moves the focus, once the next render is in, to what sel finds in the card. */
function useFocusAfter(card: RefObject<HTMLElement>) {
  const [sel, setSel] = useState<string | null>(null)
  useEffect(() => {
    if (!sel) return
    card.current?.querySelector<HTMLElement>(sel)?.focus()
    setSel(null)
  }, [sel])
  return setSel
}

function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

/* ---------- 폴더 ---------- */

export function FoldersCard() {
  const id = useId()
  const card = useRef<HTMLElement>(null)
  const focusAfter = useFocusAfter(card)
  const list = folders.value
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [ask, setAsk] = useState<FolderView | null>(null)
  const [removing, setRemoving] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  // The button pressed is gone with its row. select() alone does not focus in every browser.
  useLayoutEffect(() => {
    if (!editing) return
    input.current?.focus()
    input.current?.select()
  }, [editing])

  const edit = (f: FolderView) => {
    setEditing(f.id)
    setDraft(f.name)
  }
  const done = () => {
    const f = editing
    setEditing(null)
    if (f) focusAfter(`[data-rename="${f}"]`)
  }
  const save = async (e: Event) => {
    e.preventDefault()
    const f = list.find((x) => x.id === editing)
    if (!f || saving) return
    const name = draft.trim()
    if (name === f.name) return done()
    setSaving(true)
    try {
      const v = await api.folders.rename(f.id, name)
      apply({ type: 'folders', folders: folders.value.map((x) => (x.id === v.id ? v : x)) })
      done()
    } catch (err) {
      toastError(err, '이름을 바꾸지 못했습니다')
    } finally {
      setSaving(false)
    }
  }
  const remove = async () => {
    const f = ask
    if (!f || removing) return
    setRemoving(true)
    try {
      await api.folders.remove(f.id)
      apply({ type: 'folders', folders: folders.value.filter((x) => x.id !== f.id) })
      setAsk(null)
      focusAfter('.st-card-head .btn')
      toast(`${f.name} 폴더를 목록에서 뺐습니다`)
    } catch (err) {
      toastError(err, '목록에서 빼지 못했습니다')
      setAsk(null)
    } finally {
      setRemoving(false)
    }
  }

  return (
    <section ref={card} class="st-card st-list" aria-labelledby={id}>
      <div class="st-card-head">
        <h2 id={id} class="st-h2">
          폴더 {list.length}
        </h2>
        <button type="button" class="btn btn-sm" onClick={() => setAdding(true)}>
          <Icon name="plus" size={16} stroke={2} />
          폴더 추가
        </button>
      </div>
      {list.length === 0 && <p class="st-none">등록된 폴더가 없습니다.</p>}
      {list.map((f, i) => (
        <div key={f.id}>
          {i > 0 && <div class="st-div is-tight" />}
          {editing === f.id ? (
            <form class="st-row st-rename" onSubmit={save}>
              <label class="sr-only" for={id + '-name'}>
                {f.name} 새 이름
              </label>
              <input
                id={id + '-name'}
                ref={input}
                class="input"
                value={draft}
                maxLength={MAX_NAME}
                placeholder={baseName(f.path)}
                aria-describedby={id + '-name-hint'}
                onInput={(e) => setDraft(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Escape') return
                  e.preventDefault()
                  done()
                }}
              />
              <span id={id + '-name-hint'} class="sr-only">
                비우면 폴더 이름 {baseName(f.path)}(으)로 돌아갑니다.
              </span>
              <button type="submit" class="btn btn-primary">
                {saving ? '저장하는 중' : '저장'}
              </button>
              <button type="button" class="btn" onClick={done}>
                취소
              </button>
            </form>
          ) : (
            <div class="st-row">
              <span class="st-row-icon">
                <Icon name="folder" size={20} />
              </span>
              <span class="st-row-main">
                <span class="st-row-name">
                  <span class="st-name">{f.name}</span>
                </span>
                <span class="st-row-sub mono">{shortPath(f.path)}</span>
              </span>
              <span class="st-acts">
                <button type="button" class="btn btn-icon btn-ghost" data-rename={f.id} aria-label={`${f.name} 이름 바꾸기`} title="이름 바꾸기" onClick={() => edit(f)}>
                  <Icon name="pencil" size={18} />
                </button>
                <button type="button" class="btn btn-icon btn-ghost" aria-label={`${f.name} 목록에서 빼기`} title="목록에서 빼기" onClick={() => setAsk(f)}>
                  <Icon name="trash" size={18} />
                </button>
              </span>
            </div>
          )}
        </div>
      ))}
      <FolderPicker
        open={adding}
        browse
        onPick={(f) => {
          setAdding(false)
          toast(`${f.name} 폴더를 등록했습니다`)
        }}
        onClose={() => setAdding(false)}
      />
      <Confirm
        open={!!ask}
        title="폴더를 목록에서 뺄까요?"
        text={`${ask?.name ?? ''} 폴더를 Mori 목록에서 뺍니다. 폴더 안의 파일과 워크트리, 열린 세션은 그대로 남습니다.`}
        confirm="목록에서 빼기"
        danger
        busy={removing}
        onConfirm={remove}
        onCancel={() => setAsk(null)}
      />
    </section>
  )
}

/* ---------- the two lists edited as a whole ---------- */

interface ItemHeadProps {
  id: string
  title: string
  removeLabel: string
  onRemove: () => void
}

function ItemHead({ id, title, removeLabel, onRemove }: ItemHeadProps) {
  return (
    <div class="st-item-head">
      <span id={id} class="st-item-title">
        {title}
      </span>
      <button type="button" class="btn btn-icon btn-ghost btn-sm" aria-label={removeLabel} title="빼기" onClick={onRemove}>
        <Icon name="trash" size={16} />
      </button>
    </div>
  )
}

interface EditFootProps {
  add: string
  error: string
  saving: boolean
  onAdd: () => void
  onCancel: () => void
}

function EditFoot({ add, error, saving, onAdd, onCancel }: EditFootProps) {
  return (
    <>
      <button type="button" class="btn btn-sm st-add" onClick={onAdd}>
        <Icon name="plus" size={16} stroke={2} />
        {add}
      </button>
      {error && (
        <p class="form-error" role="alert">
          {error}
        </p>
      )}
      <div class="st-edit-foot">
        <button type="button" class="btn" onClick={onCancel}>
          취소
        </button>
        <button type="submit" class="btn btn-primary">
          {saving ? '저장하는 중' : '저장'}
        </button>
      </div>
    </>
  )
}

/* ---------- 다른 호스트 ---------- */

const EDIT_BTN = '.st-card-head .btn'

/** The hosts linked to this hub. They are linked with `mori hosts link` for now. */
export function HostsCard() {
  const id = useId()
  const list = hosts.value
  return (
    <section class="st-card st-list" aria-labelledby={id}>
      <div class="st-card-head">
        <h2 id={id} class="st-h2">
          다른 호스트
        </h2>
      </div>
      {list.length === 0 && <p class="st-none">이은 호스트가 없습니다.</p>}
      {list.map((h, i) => (
        <div key={h.id}>
          {i > 0 && <div class="st-div is-tight" />}
          <div class="st-row">
            <span class="st-row-icon">
              <Icon name="monitor" size={20} />
            </span>
            <span class="st-row-main">
              <span class="st-row-name">
                <span class="st-name">{h.name}</span>
                {isHere(h.url) && <span class="st-pill">이 호스트</span>}
                {!h.linked && <span class="st-pill">끊김</span>}
              </span>
              <span class="st-row-sub mono">{[h.url, h.version].filter(Boolean).join(' · ')}</span>
            </span>
          </div>
        </div>
      ))}
      <p class="st-hint">
        다른 컴퓨터의 Mori를 이 허브에 이으려면 이 컴퓨터에서 <code>mori hosts link 주소 코드</code>를 실행하세요. 코드는 그 컴퓨터에서 <code>mori pair</code>로 받습니다.
      </p>
    </section>
  )
}

/* ---------- 프리셋 ---------- */

interface PresetDraft {
  k: number
  id: string
  name: string
  cmd: string
  task: boolean
}

export function PresetsCard() {
  const id = useId()
  const card = useRef<HTMLElement>(null)
  const focusAfter = useFocusAfter(card)
  const list = presets.value
  const [draft, setDraft] = useState<PresetDraft[] | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const nextK = useRef(1)

  const start = () => {
    const d = list.map((p) => ({ k: nextK.current++, id: p.id, name: p.name, cmd: formatArgv(p.argv), task: p.task }))
    setDraft(d)
    setError('')
    if (d.length) focusAfter(`[data-k="${d[0].k}"] input`)
  }
  const stop = () => {
    setDraft(null)
    setError('')
    focusAfter(EDIT_BTN)
  }
  const add = () => {
    const ds = draft ?? []
    const ids = new Set(ds.map((d) => d.id))
    let n = 1
    while (ids.has(`preset-${n}`)) n++
    const d: PresetDraft = { k: nextK.current++, id: `preset-${n}`, name: '', cmd: '', task: false }
    setDraft([...ds, d])
    focusAfter(`[data-k="${d.k}"] input`)
  }
  const change = <F extends 'id' | 'name' | 'cmd' | 'task'>(k: number, field: F, v: PresetDraft[F]) =>
    setDraft((ds) => ds && ds.map((d) => (d.k === k ? { ...d, [field]: v } : d)))
  const drop = (k: number) => {
    setDraft((ds) => ds && ds.filter((d) => d.k !== k))
    focusAfter('.st-add')
  }
  const save = async (e: Event) => {
    e.preventDefault()
    if (!draft || saving) return
    const out: Preset[] = []
    for (const d of draft) {
      const argv = parseArgv(d.cmd)
      if (!argv) {
        setError(`프리셋 ${d.name.trim() || d.id.trim()}: 명령의 따옴표가 닫히지 않았습니다`)
        return
      }
      out.push({ id: d.id.trim(), name: d.name.trim(), argv, task: d.task })
    }
    setSaving(true)
    setError('')
    try {
      presets.value = await api.presets.put(out)
      stop()
      toast('프리셋을 저장했습니다')
    } catch (err) {
      setError(errorText(err, '저장하지 못했습니다'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section ref={card} class="st-card st-list" aria-labelledby={id}>
      <div class="st-card-head">
        <h2 id={id} class="st-h2">
          프리셋 {list.length}
        </h2>
        {!draft && (
          <button type="button" class="btn btn-sm" onClick={start}>
            <Icon name="pencil" size={16} />
            편집
          </button>
        )}
      </div>
      {draft ? (
        <form class="st-edit" noValidate onSubmit={save}>
          {draft.map((d, i) => {
            const f = `${id}-${d.k}`
            const title = d.name.trim() || `프리셋 ${i + 1}`
            return (
              <div key={d.k} class="st-item" role="group" aria-labelledby={f + '-t'} data-k={d.k}>
                <ItemHead id={f + '-t'} title={title} removeLabel={`${title} 빼기`} onRemove={() => drop(d.k)} />
                <div class="st-item-fields is-pair">
                  <label class="field">
                    <span class="field-label">이름</span>
                    <input class="input" value={d.name} maxLength={MAX_NAME} placeholder="Claude Code" onInput={(e) => change(d.k, 'name', e.currentTarget.value)} />
                  </label>
                  {/* A hint stays out of the label, or it is read as the name. */}
                  <div class="field">
                    <label class="field-label" for={f + '-i'}>
                      id
                    </label>
                    <input
                      id={f + '-i'}
                      class="input mono"
                      value={d.id}
                      maxLength={32}
                      autoCapitalize="off"
                      autoComplete="off"
                      spellcheck={false}
                      aria-describedby={f + '-ih'}
                      onInput={(e) => change(d.k, 'id', e.currentTarget.value)}
                    />
                    <span id={f + '-ih'} class="field-hint">
                      영문 소문자, 숫자, _, -로 1~32자
                    </span>
                  </div>
                </div>
                <div class="field">
                  <label class="field-label" for={f + '-c'}>
                    명령
                  </label>
                  <input
                    id={f + '-c'}
                    class="input mono"
                    value={d.cmd}
                    placeholder="claude"
                    autoCapitalize="off"
                    autoComplete="off"
                    spellcheck={false}
                    aria-describedby={f + '-ch'}
                    onInput={(e) => change(d.k, 'cmd', e.currentTarget.value)}
                  />
                  <span id={f + '-ch'} class="field-hint">
                    비우면 이 컴퓨터의 셸을 엽니다. 공백이 든 인수는 따옴표로 묶습니다.
                  </span>
                </div>
                <label class="st-task">
                  <input
                    type="checkbox"
                    class="st-check"
                    checked={d.task}
                    aria-labelledby={f + '-tn'}
                    aria-describedby={f + '-th'}
                    onChange={(e) => change(d.k, 'task', e.currentTarget.checked)}
                  />
                  <span class="st-task-main">
                    <span id={f + '-tn'} class="st-task-name">
                      작업을 받음
                    </span>
                    <span id={f + '-th'} class="field-hint">
                      새 세션의 작업 내용을 마지막 인수로 넘깁니다.
                    </span>
                  </span>
                </label>
              </div>
            )
          })}
          <EditFoot add="프리셋 추가" error={error} saving={saving} onAdd={add} onCancel={stop} />
        </form>
      ) : (
        list.map((p, i) => (
          <div key={p.id}>
            {i > 0 && <div class="st-div is-tight" />}
            <div class="st-row">
              <span class="st-row-icon">
                <Icon name="terminal" size={20} />
              </span>
              <span class="st-row-main">
                <span class="st-row-name">
                  <span class="st-name">{p.name}</span>
                  {p.task && <span class="st-pill">작업 받음</span>}
                </span>
                <span class={'st-row-sub' + (p.argv.length ? ' mono' : '')}>{p.argv.length ? formatArgv(p.argv) : '이 컴퓨터의 셸'}</span>
              </span>
            </div>
          </div>
        ))
      )}
    </section>
  )
}
