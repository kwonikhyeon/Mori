// The name and base of a branch to make a worktree for, and a line on what
// making it does: in the new session screen and in the Git panel's sheet.
import type { Ref } from 'preact'
import { Icon } from '../components/Icon'
import { shortPath } from '../lib/format'
import type { Plan } from '../lib/slug'
import type { Branches } from '../lib/types'
import './branchfields.css'

export interface BranchFieldsProps {
  /** Before the ids of the fields: <id>-br, <id>-base and <id>-hint. */
  id: string
  name: string
  onName: (v: string) => void
  base: string
  onBase: (v: string) => void
  /** The base until one is chosen: the main worktree's branch, or '' for HEAD. */
  defaultBase: string
  /** null while they are not known, or when they could not be read. */
  branches: Branches | null
  plan: Plan
  inputRef?: Ref<HTMLInputElement>
  /** Focus the name when it first shows, as in a sheet opened for it. */
  autofocus?: boolean
}

export function BranchFields({ id, name, onName, base, onBase, defaultBase, branches: b, plan, inputRef, autofocus }: BranchFieldsProps) {
  // A name being typed may be wrong for a moment; the base stays as it is.
  const baseFree = plan.kind === 'new' || plan.kind === 'empty' || plan.kind === 'bad'
  return (
    <>
      <div class="bf-row">
        <div class="field bf-name">
          <label class="field-label" for={id + '-br'}>
            브랜치 이름
          </label>
          <input
            ref={inputRef}
            id={id + '-br'}
            autofocus={autofocus}
            class="input mono"
            value={name}
            placeholder="예: fix/login"
            autoComplete="off"
            autoCapitalize="off"
            spellcheck={false}
            aria-describedby={id + '-hint'}
            onInput={(e) => onName(e.currentTarget.value)}
          />
        </div>
        <div class="field bf-base">
          <label class="field-label" for={id + '-base'}>
            기준
          </label>
          <span class="bf-select">
            <select id={id + '-base'} class="input mono" value={base} disabled={!baseFree} onChange={(e) => onBase(e.currentTarget.value)}>
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
            <Icon name="chevron-down" size={16} class="bf-select-icon" />
          </span>
        </div>
      </div>
      <p id={id + '-hint'} class={'bf-hint' + (plan.kind === 'taken' || plan.kind === 'bad' ? ' is-bad' : '')}>
        <Hint plan={plan} />
      </p>
    </>
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
