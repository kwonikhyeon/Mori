// Starts a session (spec §3 #134): where it runs (a folder, one of its
// worktrees or a new branch), which program, the task it gets first and
// its name. A new branch gets its worktree first, and that worktree stays
// chosen when the session then fails, so trying again only starts it.
import { Fragment, type ComponentChildren } from 'preact'
import { useEffect, useId, useRef, useState } from 'preact/hooks'
import { Icon } from '../components/Icon'
import { api, type NewWorktree } from '../lib/api'
import { hostLabel } from '../lib/boot'
import { shortHash, shortPath } from '../lib/format'
import { isApple } from '../lib/platform'
import { navigate } from '../lib/router'
import { branchProblem, worktreePath } from '../lib/slug'
import { load, save } from '../lib/storage'
import { apply, folders, presets, ready, terminals } from '../lib/store'
import { errorText } from '../lib/toast'
import type { Branches, FolderView, Worktree } from '../lib/types'
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

/** What a branch name does: refused by git, taken by a worktree, an existing branch, one of a remote, or new. */
type Plan =
  | { kind: 'empty' }
  | { kind: 'bad'; why: string }
  | { kind: 'taken'; path: string }
  | { kind: 'local'; path: string }
  | { kind: 'remote'; path: string; remote: string }
  | { kind: 'new'; path: string }

const wtLabel = (w: Worktree) => (w.detached || !w.branch ? shortHash(w.head) : w.branch)

/** The worktree a session runs in unless another is chosen: the folder's own, the main one, any. */
function defaultWt(f: FolderView, ws: Worktree[]): string {
  const ok = ws.filter((w) => !w.prunable)
  return (ok.find((w) => w.path === f.path) ?? ok.find((w) => w.main) ?? ok[0])?.path ?? NEW
}

function planOf(name: string, ws: Worktree[], main: string, b: Branches | null): Plan {
  if (!name) return { kind: 'empty' }
  const why = branchProblem(name)
  if (why) return { kind: 'bad', why }
  const has = ws.find((w) => !w.detached && w.branch === name)
  if (has) return { kind: 'taken', path: has.path }
  // Where the server puts it, past the worktrees there are.
  const path = worktreePath(main, name, ws.filter((w) => !w.prunable).map((w) => w.path))
  if (b?.local.some((x) => x.name === name)) return { kind: 'local', path }
  // A branch is a file under refs/heads, so fix and fix/a cannot both be.
  const clash = b?.local.find((x) => name.startsWith(x.name + '/') || x.name.startsWith(name + '/'))
  if (clash) return { kind: 'bad', why: `‘${clash.name}’ 브랜치가 있어서 이 이름은 쓸 수 없습니다` }
  // git makes a branch that follows the remote one of the same short name.
  const r = b?.remote.find((x) => x.name.slice(x.name.indexOf('/') + 1) === name)
  if (r) return { kind: 'remote', path, remote: r.name }
  return { kind: 'new', path }
}

export function NewSession({ variant, folder, wt, back }: NewSessionProps) {
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
  const nameRef = useRef<HTMLInputElement>(null)
  const focusName = useRef(false)

  const fs = folders.value
  const f = fs.find((x) => x.id === pick) ?? fs.find((x) => x.id === last.folder) ?? fs[0] ?? null
  const ps = presets.value
  const preset = ps.find((p) => p.id === presetPick) ?? ps.find((p) => p.id === last.preset) ?? ps[0]

  const ws = f ? f.worktrees.filter((w) => !w.bare) : []
  if (f && made && made.folder === f.id && !ws.some((w) => w.path === made.wt.path)) ws.push(made.wt)
  const choice = !f?.repo
    ? undefined
    : wtPick === NEW
      ? NEW
      : (ws.find((w) => w.path === wtPick && !w.prunable)?.path ?? defaultWt(f, ws))
  const main = ws.find((w) => w.main)

  const fid = f?.id
  const needBr = choice === NEW && !!fid && br?.id !== fid
  useEffect(() => {
    if (!needBr || !fid) return
    let live = true
    api.folders.branches(fid).then(
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
  }, [needBr, fid])
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
  // A name being typed may be wrong for a moment; the base stays as it is.
  const baseFree = plan.kind === 'new' || plan.kind === 'empty' || plan.kind === 'bad'

  // The sessions running in each worktree, so a busy one shows.
  const counts = new Map<string, number>()
  for (const t of terminals.value.values()) {
    if (t.state === 'finished' || t.folder_id !== fid) continue
    counts.set(t.worktree, (counts.get(t.worktree) ?? 0) + 1)
  }

  const takesTask = !!preset?.task
  const ok =
    !!f && !!preset && !busy && (choice !== NEW || (!needBr && (plan.kind === 'new' || plan.kind === 'local' || plan.kind === 'remote')))

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
      if (choice === NEW) {
        const req: NewWorktree =
          plan.kind === 'new' ? { branch: name, create: true, ...(baseValue ? { base: baseValue } : {}) } : { branch: name, create: false }
        let w: Worktree
        try {
          w = await api.folders.addWorktree(f.id, req)
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
      const t = await api.terminals.create({
        folder_id: f.id,
        preset: preset.id,
        ...(at ? { worktree: at } : {}),
        ...(takesTask && task.trim() ? { task: task.trim() } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
      })
      // The list has it before the event stream brings it.
      apply({ type: 'terminal', terminal: t })
      save(LAST, { folder: f.id, preset: preset.id } satisfies Last)
      navigate({ name: 'terminal', addr: t.address, git: false }, { replace: true })
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
  const hostName = hostLabel.value
  const head =
    variant === 'phone' ? (
      <header class="ns-head">
        <a class="btn btn-icon btn-ghost ns-back" href={back ?? '#/'} aria-label="뒤로">
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

  if (!ready.value || ps.length === 0) {
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
                        <>
                          <div class="ns-new-row">
                            <div class="field ns-new-name">
                              <label class="field-label" for={id + '-br'}>
                                브랜치 이름
                              </label>
                              <input
                                ref={nameRef}
                                id={id + '-br'}
                                class="input mono"
                                value={branch}
                                placeholder="예: fix/login"
                                autoComplete="off"
                                autoCapitalize="off"
                                spellcheck={false}
                                aria-describedby={id + '-hint'}
                                onInput={(e) => {
                                  setBranch(e.currentTarget.value)
                                  setError(null)
                                }}
                              />
                            </div>
                            <div class="field ns-new-base">
                              <label class="field-label" for={id + '-base'}>
                                기준
                              </label>
                              <span class="ns-select">
                                <select id={id + '-base'} class="input mono" value={baseValue} disabled={!baseFree} onChange={(e) => setBase(e.currentTarget.value)}>
                                  {b ? (
                                    <>
                                      {defaultBase === '' && <option value="">HEAD</option>}
                                      {b.local.map((x) => (
                                        <option key={x.name} value={x.name}>
                                          {x.name}
                                        </option>
                                      ))}
                                      {b.remote.length > 0 && (
                                        <optgroup label="원격">
                                          {b.remote.map((x) => (
                                            <option key={x.name} value={x.name}>
                                              {x.name}
                                            </option>
                                          ))}
                                        </optgroup>
                                      )}
                                    </>
                                  ) : (
                                    <option value={defaultBase}>{defaultBase || 'HEAD'}</option>
                                  )}
                                </select>
                                <Icon name="chevron-down" size={16} class="ns-select-icon" />
                              </span>
                            </div>
                          </div>
                          <p id={id + '-hint'} class={'ns-hint' + (plan.kind === 'taken' || plan.kind === 'bad' ? ' is-bad' : '')}>
                            <Hint plan={plan} />
                          </p>
                        </>
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
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.isComposing) return
                      e.preventDefault()
                      e.currentTarget.form?.requestSubmit()
                    }}
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

function Hint({ plan }: { plan: Plan }) {
  switch (plan.kind) {
    case 'empty':
      return <>브랜치 이름을 적으세요</>
    case 'bad':
      return <>{plan.why}</>
    case 'taken':
      return (
        <>
          이미 워크트리가 있는 브랜치입니다: <span class="mono">{shortPath(plan.path)}</span>
        </>
      )
    case 'local':
      return (
        <>
          기존 브랜치를 <span class="mono">{shortPath(plan.path)}</span>에 엽니다
        </>
      )
    case 'remote':
      return (
        <>
          <span class="mono">{shortPath(plan.path)}</span>에 만듭니다 · <span class="mono">{plan.remote}</span> 추적
        </>
      )
    case 'new':
      return (
        <>
          <span class="mono">{shortPath(plan.path)}</span>에 만듭니다
        </>
      )
  }
}
