// Picks where a new session runs: a registered folder, or any directory of
// this computer (GET /api/fs, spec §3 #74), which is registered on the way.
// Settings opens it on browsing only, to add a folder.
import { useEffect, useId, useRef, useState } from 'preact/hooks'
import { Icon } from '../components/Icon'
import { Sheet, SheetHead } from '../components/Sheet'
import { api } from '../lib/api'
import { shortPath } from '../lib/format'
import { apply, folders } from '../lib/store'
import { errorText } from '../lib/toast'
import type { FolderView, FsListing } from '../lib/types'
import './folderpicker.css'

export interface FolderPickerProps {
  open: boolean
  /** The id of the folder chosen now. */
  value?: string
  onPick: (f: FolderView) => void
  onClose: () => void
  /** Only browse, to register a folder: no list to pick from. */
  browse?: boolean
}

export function FolderPicker({ open, ...p }: FolderPickerProps) {
  const id = useId()
  return (
    <Sheet open={open} labelledBy={id} onClose={p.onClose} class="fp">
      <Picker id={id} {...p} />
    </Sheet>
  )
}

type PickerProps = Omit<FolderPickerProps, 'open'> & { id: string }

function Picker(p: PickerProps) {
  // With nothing registered yet there is nothing to pick from.
  const [adding, setAdding] = useState(() => !!p.browse || folders.peek().length === 0)
  // The button that switched is gone; the new title takes the focus.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) first.current = false
    else document.getElementById(p.id)?.focus()
  }, [adding])
  return adding ? (
    <Browse {...p} onList={!p.browse && folders.value.length > 0 ? () => setAdding(false) : undefined} />
  ) : (
    <List {...p} onAdd={() => setAdding(true)} />
  )
}

function List({ id, value, onPick, onClose, onAdd }: PickerProps & { onAdd: () => void }) {
  return (
    <>
      <SheetHead id={id} title="폴더 고르기" onClose={onClose} />
      <div class="sheet-body">
        <ul class="fp-list">
          {folders.value.map((f) => {
            const on = f.id === value
            return (
              <li key={f.id}>
                <button type="button" class="fp-row" aria-current={on ? 'true' : undefined} autofocus={on} onClick={() => onPick(f)}>
                  <Icon name="folder" size={20} class="fp-icon" />
                  <span class="fp-main">
                    <span class="fp-name">{f.name}</span>{' '}
                    <span class="fp-path mono">{shortPath(f.path)}</span>
                  </span>
                  {f.repo && <span class="fp-tag">Git</span>}
                  {on && <Icon name="check" size={18} class="fp-check" />}
                </button>
              </li>
            )
          })}
        </ul>
      </div>
      <footer class="sheet-foot">
        <button type="button" class="btn btn-block" onClick={onAdd}>
          <Icon name="plus" size={16} />
          폴더 추가
        </button>
      </footer>
    </>
  )
}

/** Where browsing starts: beside the folder chosen now, else at home. */
function startDir(f: FolderView | undefined): string {
  if (!f) return ''
  const p = f.path.replace(/[\\/]+$/, '')
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  if (i < 0) return ''
  const up = p.slice(0, i)
  return up === '' ? '/' : /^[A-Za-z]:$/.test(up) ? up + '\\' : up
}

// Windows does not tell case apart in a path.
const samePath = (a: string, b: string) => (/^[A-Za-z]:\\|^\\\\/.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b)

function Browse({ id, value, onPick, onClose, onList, browse }: PickerProps & { onList?: () => void }) {
  const [listing, setListing] = useState<FsListing | null>(null)
  const [path, setPath] = useState('')
  const [hidden, setHidden] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)
  const field = id + '-path'

  const go = async (dir: string, h = hidden) => {
    const n = ++seq.current
    setLoading(true)
    setError(null)
    try {
      const l = await api.fs(dir, h)
      if (n !== seq.current) return
      setListing(l)
      setPath(l.path)
    } catch (e) {
      if (n === seq.current) setError(errorText(e, '폴더를 열지 못했습니다'))
    } finally {
      if (n === seq.current) setLoading(false)
    }
  }
  useEffect(() => {
    void go(startDir(folders.peek().find((f) => f.id === value)))
  }, [])

  const here = listing?.path
  const known = here ? folders.value.find((f) => samePath(f.path, here)) : undefined
  const register = async () => {
    if (!here || saving || (browse && known)) return
    if (known) {
      onPick(known)
      return
    }
    setSaving(true)
    setError(null)
    try {
      const f = await api.folders.add(here)
      // The event stream brings the same list soon; the screen needs it now.
      const fs = folders.peek()
      if (!fs.some((x) => x.id === f.id)) apply({ type: 'folders', folders: [...fs, f] })
      onPick(f)
    } catch (e) {
      setError(errorText(e, '폴더를 등록하지 못했습니다'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <SheetHead id={id} title="폴더 추가" onClose={onClose} back={onList && { label: '등록된 폴더로', onClick: onList }} />
      <form
        class="fp-bar"
        onSubmit={(e) => {
          e.preventDefault()
          const p = path.trim()
          if (p) void go(p)
        }}
      >
        <button type="button" class="btn btn-icon btn-sm" aria-label="위 폴더" title="위 폴더" disabled={!listing || listing.parent === ''} onClick={() => listing && void go(listing.parent)}>
          <Icon name="chevron-up" size={18} />
        </button>
        <label class="sr-only" for={field}>
          경로
        </label>
        <input
          id={field}
          class="input mono fp-input"
          value={path}
          enterKeyHint="go"
          autoComplete="off"
          autoCapitalize="off"
          spellcheck={false}
          onInput={(e) => setPath(e.currentTarget.value)}
        />
      </form>
      <div class="sheet-body fp-body" aria-busy={loading}>
        {error && (
          <p class="form-error" role="alert">
            {error}
          </p>
        )}
        {listing && listing.entries.length === 0 && !loading && <p class="fp-none">하위 폴더가 없습니다</p>}
        {listing && listing.entries.length > 0 && (
          <ul class="fp-list" aria-label={`${shortPath(listing.path)}의 폴더`}>
            {listing.entries.map((e) => (
              <li key={e.path}>
                <button type="button" class="fp-row" onClick={() => void go(e.path)}>
                  <Icon name="folder" size={20} class="fp-icon" />
                  <span class="fp-main">
                    <span class="fp-name">{e.name}</span>
                  </span>
                  {e.git && <span class="fp-tag">Git</span>}
                  <Icon name="chevron-right" size={16} class="fp-go" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {listing?.truncated && <p class="fp-none">2000개까지만 보입니다</p>}
        {!listing && loading && (
          <p class="fp-none" role="status">
            불러오는 중
          </p>
        )}
      </div>
      <footer class="sheet-foot fp-foot">
        <label class="fp-hidden">
          <input
            type="checkbox"
            checked={hidden}
            onChange={(e) => {
              const h = e.currentTarget.checked
              setHidden(h)
              void go(here ?? '', h)
            }}
          />
          숨긴 폴더 보기
        </label>
        <button type="button" class="btn btn-primary" disabled={!here || saving || (browse && !!known)} onClick={() => void register()}>
          {known ? (browse ? '등록된 폴더입니다' : '이 폴더 고르기') : '이 폴더 등록'}
        </button>
      </footer>
    </>
  )
}
