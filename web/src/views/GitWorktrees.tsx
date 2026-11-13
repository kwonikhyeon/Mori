// The worktrees of the folder the Git panel shows: one is picked to see
// its changes, and its menu opens a session in it or removes it. A new one
// is made in a sheet.
import { useEffect, useId, useState } from 'preact/hooks'
import { Confirm } from '../components/Confirm'
import { onContext } from '../components/ContextMenu'
import { Icon } from '../components/Icon'
import { Menu, type MenuItem } from '../components/Menu'
import { Sheet, SheetHead } from '../components/Sheet'
import { ApiError } from '../lib/api'
import { copyAndTell } from '../lib/copy'
import { shortPath, wtLabel } from '../lib/format'
import { sessionsByWorktree } from '../lib/queue'
import { useHost } from '../lib/scope'
import { planOf, worktreeRequest } from '../lib/slug'
import { errorText, toast, toastError } from '../lib/toast'
import type { Branches, FolderView, Worktree } from '../lib/types'
import { tip } from '../lib/tip'
import { BranchFields } from './BranchFields'
import type { Variant } from './rows'
import type { GitData } from './useGit'

/** What removing a worktree does; the path is never followed by a particle. */
function removeText(w: Worktree): string {
  const p = shortPath(w.path)
  const keeps = !w.detached && !!w.branch
  if (w.prunable) return keeps ? `${p} 폴더는 이미 없습니다. 목록에서 지우고, 브랜치는 지우지 않습니다.` : `${p} 폴더는 이미 없습니다. 목록에서 지웁니다.`
  return keeps ? `${p} 폴더를 지웁니다. 브랜치는 지우지 않습니다.` : `${p} 폴더를 지웁니다.`
}

const forceText = (why: string) => `git이 삭제를 거절했습니다:\n${why}\n\n강제로 삭제하면 커밋하지 않은 변경과 추적하지 않는 파일도 함께 지워집니다.`

interface Ask {
  w: Worktree
  /** Why git would not remove it, once asked to force it. */
  force: string | null
}

export interface WorktreeListProps {
  variant: Variant
  g: GitData
  /** The worktree of the session it is for, marked 이 세션. */
  own?: string
  onShow: (path: string) => void
  onMade: (w: Worktree) => void
  onRemoved: (path: string) => void
}

export function WorktreeList({ variant, g, own, onShow, onMade, onRemoved }: WorktreeListProps) {
  const h = useHost()
  const f = g.f!
  const id = useId()
  const sheet = id + '-sheet'
  const [adding, setAdding] = useState(false)
  const [ask, setAsk] = useState<Ask | null>(null)
  const [busy, setBusy] = useState(false)
  const counts = sessionsByWorktree(h.terminals.value.values(), f.id)
  const pc = variant === 'pc'
  const Head = pc ? 'h3' : 'h2'

  const remove = async () => {
    if (!ask) return
    const { w, force } = ask
    setBusy(true)
    try {
      await h.api.folders.removeWorktree(f.id, w.path, force !== null)
      setAsk(null)
      toast('워크트리를 삭제했습니다')
      onRemoved(w.path)
    } catch (e) {
      // git keeps a worktree with changes; anything else forcing does not fix.
      if (force === null && e instanceof ApiError && e.kind === 'git_failed') setAsk({ w, force: e.message })
      else {
        setAsk(null)
        toastError(e, '워크트리를 삭제하지 못했습니다')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <section class={'gw gw-' + variant} aria-labelledby={id}>
      <div class="gw-head">
        <Head id={id} class="gw-title">
          워크트리 {g.ws.length}
        </Head>
        {pc ? (
          <button type="button" class="btn btn-xs btn-icon btn-ghost gw-add" {...tip('워크트리 추가')} onClick={() => setAdding(true)}>
            <Icon name="plus" size={16} />
          </button>
        ) : (
          <button type="button" class="gw-add-phone" onClick={() => setAdding(true)}>
            <Icon name="plus" size={16} />새 워크트리
          </button>
        )}
      </div>
      <ul class="gw-list">
        {g.ws.map((w) => {
          const n = counts.get(w.path) ?? 0
          const items: MenuItem[] = []
          if (!w.prunable) items.push({ label: '이 워크트리에서 새 세션', icon: 'plus', onSelect: () => h.go({ name: 'new', folder: f.id, wt: w.path }) })
          // git keeps the main one, and a locked one even when forced once.
          if (!w.main && !w.locked) items.push({ label: '워크트리 삭제', icon: 'trash', danger: true, onSelect: () => setAsk({ w, force: null }) })
          // A right-click on the row: what its menu has, with the path to copy (spec §3 #242).
          const ctx = [
            ...items.filter((it) => !it.danger),
            { label: '경로 복사', icon: 'copy', onSelect: () => void copyAndTell(w.path, '경로를 복사했습니다') } satisfies MenuItem,
            ...items.filter((it) => it.danger).map((it) => ({ ...it, sep: true })),
          ]
          return (
            <li key={w.path} class="gw-item">
              <button
                type="button"
                class="gw-row"
                aria-current={w.path === g.shown ? 'true' : undefined}
                disabled={w.prunable}
                title={w.path}
                onClick={() => onShow(w.path)}
                onContextMenu={onContext(wtLabel(w), () => ctx)}
              >
                <span class="gw-main">
                  <span class="mono gw-branch">{wtLabel(w)}</span>{' '}
                  <span class="gw-path">{w.prunable ? '폴더가 없습니다' : shortPath(w.path)}</span>
                </span>
                {own === w.path && (
                  <>
                    {' '}
                    <span class="gw-chip">이 세션</span>
                  </>
                )}
                {w.locked && (
                  <>
                    {' '}
                    <span class="gw-tag">잠김</span>
                  </>
                )}
                {n > 0 && (
                  <>
                    {' '}
                    <span class="gw-count">세션 {n}</span>
                  </>
                )}
              </button>
              {items.length > 0 && <Menu label={`${wtLabel(w)} 워크트리 메뉴`} items={items} buttonClass="btn btn-icon btn-ghost gw-menu" iconSize={18} />}
            </li>
          )
        })}
      </ul>
      <Confirm
        open={!!ask}
        title={ask?.force != null ? '강제로 삭제할까요?' : '워크트리를 삭제할까요?'}
        text={!ask ? '' : ask.force != null ? forceText(ask.force) : removeText(ask.w)}
        confirm={ask?.force != null ? '강제로 삭제' : '삭제'}
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => setAsk(null)}
      />
      <Sheet open={adding} labelledBy={sheet} onClose={() => setAdding(false)}>
        <AddWorktree
          id={sheet}
          f={f}
          ws={g.ws}
          onClose={() => setAdding(false)}
          onMade={(w) => {
            setAdding(false)
            onMade(w)
          }}
        />
      </Sheet>
    </section>
  )
}

interface AddWorktreeProps {
  id: string
  f: FolderView
  ws: Worktree[]
  onClose: () => void
  onMade: (w: Worktree) => void
}

function AddWorktree({ id, f, ws, onClose, onMade }: AddWorktreeProps) {
  const h = useHost()
  const [name, setName] = useState('')
  const [base, setBase] = useState<string | null>(null)
  // undefined while they are read, null when they could not be.
  const [br, setBr] = useState<Branches | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    h.api.folders.branches(f.id).then(
      (b) => {
        if (live) setBr(b)
      },
      () => {
        if (live) setBr(null)
      },
    )
    return () => {
      live = false
    }
  }, [f.id, h])

  const main = ws.find((w) => w.main)
  const n = name.trim()
  const plan = planOf(n, ws, main?.path ?? f.path, br ?? null)
  const defaultBase = main && !main.detached && main.branch ? main.branch : ''
  const req = worktreeRequest(plan, n, base ?? defaultBase)
  const ok = br !== undefined && !!req && !busy

  const submit = async () => {
    if (!ok || !req) return
    setBusy(true)
    setError(null)
    try {
      const w = await h.api.folders.addWorktree(f.id, req)
      toast('워크트리를 만들었습니다')
      onMade(w)
    } catch (e) {
      setError('워크트리를 만들지 못했습니다. ' + errorText(e))
      setBusy(false)
    }
  }

  return (
    <>
      <SheetHead id={id} title="새 워크트리" onClose={onClose} />
      <form
        class="gw-form"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div class="sheet-body">
          <BranchFields
            id={id}
            autofocus
            name={name}
            onName={(v) => {
              setName(v)
              setError(null)
            }}
            base={base ?? defaultBase}
            onBase={setBase}
            defaultBase={defaultBase}
            branches={br ?? null}
            plan={plan}
          />
        </div>
        <footer class="sheet-foot gw-foot">
          {error && (
            <p class="form-error" role="alert">
              {error}
            </p>
          )}
          <button type="button" class="btn" onClick={onClose}>
            취소
          </button>
          <button type="submit" class="btn btn-primary" disabled={!ok} aria-busy={busy}>
            만들기
          </button>
        </footer>
      </form>
    </>
  )
}
