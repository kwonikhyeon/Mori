// Starts a session (spec §3 #134): where it runs (a folder, one of its
// worktrees or a new branch), which program, the task it gets first and
// its name. A new branch gets its worktree first, and that worktree stays
// chosen when the session then fails, so trying again only starts it.
import { Fragment, type ComponentChildren } from 'preact'
import { useEffect, useId, useRef, useState } from 'preact/hooks'
import { Icon } from '../components/Icon'
import { homeWorktree, shortPath, wtLabel } from '../lib/format'
import { useChordSubmit } from '../lib/ime'
import { isApple } from '../lib/platform'
import { sessionsByWorktree } from '../lib/queue'
import { useHost } from '../lib/scope'
import { planOf, worktreeRequest } from '../lib/slug'
import { load, save } from '../lib/storage'
import { errorText } from '../lib/toast'
import type { Branches, Worktree } from '../lib/types'
import { BranchFields } from './BranchFields'
import { FolderPicker } from './FolderPicker'
import { Loading, type Variant } from './rows'
import './newsession.css'

export interface NewSessionProps {
  variant: Variant
  /** The folder and worktree it was opened for (#/new?folder=&wt=). */
  folder?: string
  wt?: string
  /** Where 뒤로 goes on a phone. */
  back?: string
}

/** The folder and program the last session started with. */
interface Last {
  folder?: string
  preset?: string
}

const LAST = 'mori.new'

// 새 브랜치 among the worktree paths; no absolute path looks like it.
const NEW = ':new'


export function NewSession({ variant, folder, wt, back }: NewSessionProps) {
  const h = useHost()
  const id = useId()
  const [last] = useState(() => load<Last>(LAST, {}))
  const [pick, setPick] = useState(folder)
  const [wtPick, setWtPick] = useState(wt)
  const [branch, setBranch] = useState('')
  const [base, setBase] = useState<string | null>(null)
  // The branches of a folder, null when they could not be read.
  const [br, setBr] = useState<{ id: string; b: Branches | null } | null>(null)
  // The worktree made for the session, until the folder list has it.
  const [made, setMade] = useState<{ folder: string; wt: Worktree } | null>(null)
  const [presetPick, setPresetPick] = useState<string>()
  const [task, setTask] = useState('')
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const shown = useRef(true)
  useEffect(() => () => void (shown.current = false), [])
  const nameRef = useRef<HTMLInputElement>(null)
  const focusName = useRef(false)

  const fs = h.folders.value
  const f = fs.find((x) => x.id === pick) ?? fs.find((x) => x.id === last.folder) ?? fs[0] ?? null
  const ps = h.presets.value
  const preset = ps.find((p) => p.id === presetPick) ?? ps.find((p) => p.id === last.preset) ?? ps[0]

  const ws = f ? f.worktrees.filter((w) => !w.bare) : []
  if (f && made && made.folder === f.id && !ws.some((w) => w.path === made.wt.path)) ws.push(made.wt)
  const choice = !f?.repo
    ? undefined
    : wtPick === NEW
      ? NEW
      : (ws.find((w) => w.path === wtPick && !w.prunable)?.path ?? homeWorktree(f, ws)?.path ?? NEW)
  const main = ws.find((w) => w.main)

  const fid = f?.id
  const needBr = choice === NEW && !!fid && br?.id !== fid
  useEffect(() => {
    if (!needBr || !fid) return
    let live = true
    h.api.folders.branches(fid).then(
      (b) => {
        if (live) setBr({ id: fid, b })
      },
      () => {
        if (live) setBr({ id: fid, b: null })
      },
    )
    return () => {
      live = false
    }
  }, [needBr, fid, h])
  useEffect(() => {
    if (choice !== NEW || !focusName.current) return
    focusName.current = false
    nameRef.current?.focus()
  })

  const name = branch.trim()
  const b = br && br.id === fid ? br.b : null
  const plan = planOf(name, ws, main?.path ?? f?.path ?? '', b)
  const defaultBase = main && !main.detached && main.branch ? main.branch : ''
  const baseValue = base ?? defaultBase
  const req = worktreeRequest(plan, name, baseValue)

  // The sessions running in each worktree, so a busy one shows.
  const counts = fid ? sessionsByWorktree(h.terminals.value.values(), fid) : new Map<string, number>()

  const takesTask = !!preset?.task
  const ok = !!f && !!preset && !busy && (choice !== NEW || (!needBr && !!req))

  const pickWt = (path: string) => {
    if (path === NEW) focusName.current = true
    setWtPick(path)
    setError(null)
  }

  const start = async () => {
    if (!ok || !f || !preset) return
    setBusy(true)
    setError(null)
    try {
      let at = choice
      if (choice === NEW && req) {
        let w: Worktree
        try {
          w = await h.api.folders.addWorktree(f.id, req)
        } catch (e) {
          setError('브랜치를 만들지 못했습니다. ' + errorText(e))
          return
        }
        setMade({ folder: f.id, wt: w })
        setWtPick(w.path)
        setBranch('')
        setBase(null)
        at = w.path
      }
      const t = await h.api.terminals.create({
        folder_id: f.id,
        preset: preset.id,
        ...(at ? { worktree: at } : {}),
        ...(takesTask && task.trim() ? { task: task.trim() } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
      })
      // The list has it before the event stream brings it.
      h.apply({ type: 'terminal', terminal: t })
      save(LAST, { folder: f.id, preset: preset.id } satisfies Last)
      // Left while it was made: the session is in the list, and the screen they went to stays.
      if (shown.current) h.go({ name: 'terminal', addr: t.address, git: false }, { replace: true })
    } catch (e) {
      setError('세션을 만들지 못했습니다. ' + errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const sum: ComponentChildren[] = []
  if (f) {
    sum.push(f.name)
    if (choice === NEW) {
      sum.push(
        <>
          새 브랜치{name && ' '}
          {name && <span class="mono">{name}</span>}
        </>,
      )
    } else if (choice) {
      const w = ws.find((x) => x.path === choice)
      if (w) sum.push(<span class="mono">{wtLabel(w)}</span>)
    }
    if (preset) sum.push(preset.name)
  }

  const apple = isApple()
  const chord = useChordSubmit((f) => f.form?.requestSubmit())
  const hostName = h.name.value
  const head =
    variant === 'phone' ? (
      <header class="ns-head">
        <a class="btn btn-icon btn-ghost ns-back" href={back ?? h.href({ name: 'queue' })} aria-label="뒤로">
          <Icon name="back" size={22} />
        </a>
        <h1>새 세션</h1>
        {hostName && <span class="ns-host">{hostName}</span>}
      </header>
    ) : (
      <header class="ns-head">
        <h1>새 세션</h1>
        {hostName && <span class="ns-host">{hostName}</span>}
      </header>
    )

  if (!h.ready.value || ps.length === 0) {
    return (
      <div class={'ns ns-' + variant}>
        {head}
        <Loading />
      </div>
    )
  }

  return (
    <div class={'ns ns-' + variant}>
      {head}
      <form
        class="ns-form"
        onSubmit={(e) => {
          e.preventDefault()
          void start()
        }}
      >
        <div class="ns-scroll">
          <div class="ns-col">
            <section class="ns-card" aria-labelledby={id + '-where'}>
              <h2 class="ns-h2" id={id + '-where'}>
                위치
              </h2>
              <div class="ns-field">
                <span class="ns-label" id={id + '-fl'}>
                  폴더
                </span>
                <button type="button" class="ns-folder" aria-haspopup="dialog" aria-labelledby={`${id}-fl ${id}-fv`} onClick={() => setPicking(true)}>
                  <Icon name="folder" size={20} class="ns-folder-icon" />
                  <span class="ns-folder-main" id={id + '-fv'}>
                    {f ? (
                      <>
                        <b class="ns-folder-name">{f.name}</b>{' '}
                        <span class="ns-folder-path mono">{shortPath(f.path)}</span>
                      </>
                    ) : (
                      <b class="ns-folder-name">폴더를 고르세요</b>
                    )}
                  </span>
                  <Icon name="chevron-right" size={18} class="ns-folder-go" />
                </button>
              </div>
              {f?.repo && (
                <fieldset class="ns-field">
                  <legend class="ns-label">워크트리</legend>
                  <div class="ns-choices">
                    {ws.map((w) => {
                      const n = counts.get(w.path) ?? 0
                      return (
                        <label key={w.path} class={'ns-choice' + (w.prunable ? ' is-off' : '')}>
                          <input type="radio" name={id + '-wt'} value={w.path} checked={choice === w.path} disabled={w.prunable} onChange={() => pickWt(w.path)} />
                          <span class="ns-choice-main">
                            <span class="ns-branch mono">{wtLabel(w)}</span>{' '}
                            <span class="ns-path mono">{w.prunable ? '폴더가 없습니다' : shortPath(w.path)}</span>
                          </span>
                          {n > 0 && (
                            <>
                              {' '}
                              <span class="ns-count">세션 {n}</span>
                            </>
                          )}
                        </label>
                      )
                    })}
                    <div class={'ns-new' + (choice === NEW ? ' is-on' : '')}>
                      <label class="ns-choice">
                        <input type="radio" name={id + '-wt'} value={NEW} checked={choice === NEW} onChange={() => pickWt(NEW)} />
                        <span class="ns-choice-main">
                          <span class="ns-name">새 브랜치</span>{' '}
                          <span class="ns-sub">새 워크트리를 만들어 그 안에서 시작합니다</span>
                        </span>
                      </label>
                      {choice === NEW && (
                        <BranchFields
                          id={id}
                          name={branch}
                          onName={(v) => {
                            setBranch(v)
                            setError(null)
                          }}
                          base={baseValue}
                          onBase={setBase}
                          defaultBase={defaultBase}
                          branches={b}
                          plan={plan}
                          inputRef={nameRef}
                        />
                      )}
                    </div>
                  </div>
                </fieldset>
              )}
            </section>

            <section class="ns-card">
              <fieldset class="ns-field">
                <legend class="ns-h2">프로그램</legend>
                <div class="ns-choices">
                  {ps.map((p) => (
                    <label key={p.id} class="ns-choice">
                      <input type="radio" name={id + '-preset'} value={p.id} checked={p.id === preset?.id} onChange={() => setPresetPick(p.id)} />
                      <span class="ns-choice-main">
                        <span class="ns-name">{p.name}</span>
                      </span>{' '}
                      <span class="ns-note">{p.task ? '작업을 받음' : '작업 없음'}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            </section>

            <section class="ns-card">
              {takesTask && (
                <div class="field">
                  <label class="ns-h2" for={id + '-task'}>
                    작업
                  </label>
                  <textarea
                    id={id + '-task'}
                    class="input ns-task"
                    rows={3}
                    value={task}
                    placeholder="예: 로그인 화면의 오류 메시지를 고쳐 줘"
                    aria-describedby={id + '-th'}
                    aria-keyshortcuts={apple ? 'Meta+Enter' : 'Control+Enter'}
                    onInput={(e) => setTask(e.currentTarget.value)}
                    onKeyDown={chord.onKeyDown}
                    onCompositionEnd={chord.onCompositionEnd}
                  />
                  <p class="field-hint" id={id + '-th'}>
                    세션을 만들자마자 프로그램에 보냅니다.
                  </p>
                </div>
              )}
              <div class="field">
                <label class="ns-h2" for={id + '-title'}>
                  이름 <span class="ns-opt">(선택)</span>
                </label>
                <input
                  id={id + '-title'}
                  class="input ns-title"
                  value={title}
                  maxLength={100}
                  autoComplete="off"
                  placeholder={takesTask && task.trim() ? '비우면 작업의 앞부분' : `비우면 ${preset?.name ?? '프로그램 이름'}`}
                  onInput={(e) => setTitle(e.currentTarget.value)}
                />
              </div>
            </section>
          </div>
        </div>
        <footer class="ns-foot">
          {error && (
            <p class="form-error" role="alert">
              {error}
            </p>
          )}
          <p class="ns-sum">
            {f
              ? sum.map((s, i) => (
                  <Fragment key={i}>
                    {i > 0 && ' · '}
                    {s}
                  </Fragment>
                ))
              : '폴더를 고르세요'}
          </p>
          <button type="submit" class="btn btn-primary ns-go" disabled={!ok} aria-busy={busy}>
            세션 만들기
          </button>
        </footer>
      </form>
      <FolderPicker
        open={picking}
        value={f?.id}
        onPick={(x) => {
          setPick(x.id)
          setWtPick(undefined)
          setBranch('')
          setBase(null)
          setError(null)
          setPicking(false)
        }}
        onClose={() => setPicking(false)}
      />
    </div>
  )
}
