// The branch of a new worktree, as the new session screen and the Git
// panel show it before anything is made: where the server puts it (spec §3
// #15, #134), by the rules of gitx.BranchSlug and gitx.WorktreePath,
// whether git takes the name at all, and what making it then does.
import type { NewWorktree } from './api'
import type { Branches, Worktree } from './types'

// A long branch name must not make a directory name the file system refuses.
const MAX_SLUG = 64

/** A directory name of a branch name: what is not [A-Za-z0-9._-] becomes -, one - for a run. */
export function branchSlug(branch: string): string {
  let s = ''
  let dash = false
  for (const ch of branch) {
    if (ch === '-' || !/^[A-Za-z0-9._]$/.test(ch)) {
      if (!dash) s += '-'
      dash = true
      continue
    }
    dash = false
    s += ch
  }
  s = s.slice(0, MAX_SLUG).replace(/^[-.]+|[-.]+$/g, '')
  if (s === '') return 'wt'
  if (windowsDevice(s)) return 'wt-' + s
  return s
}

// Windows keeps these names for devices, with any extension: CON, aux.txt, com1.
function windowsDevice(name: string): boolean {
  return /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/i.test(name.split('.')[0])
}

/**
 * <parent>/<name>.wt/<slug> beside the main worktree, with -2, -3 and so on
 * after the slug while a worktree in taken has that path. The server also
 * skips a directory that is there for another reason; what it made comes back.
 */
export function worktreePath(mainRoot: string, branch: string, taken: string[] = []): string {
  const win = /^[A-Za-z]:\\|^\\\\/.test(mainRoot)
  const sep = win ? '\\' : '/'
  let root = mainRoot
  while (root.length > 1 && root.endsWith(sep) && !/^[A-Za-z]:\\$/.test(root)) root = root.slice(0, -1)
  const i = root.lastIndexOf(sep)
  const parent = root.slice(0, i + 1)
  const base = parent + root.slice(i + 1) + '.wt' + sep + branchSlug(branch)
  // Windows does not tell case apart in a path; macOS may, so only exact.
  const key = (p: string) => (win ? p.toLowerCase() : p)
  const have = new Set(taken.map(key))
  let p = base
  for (let n = 2; have.has(key(p)); n++) p = `${base}-${n}`
  return p
}

/**
 * Why git would not take name (trimmed) for a branch, or null: the rules of
 * git check-ref-format --branch, which the server asks before it makes one.
 */
export function branchProblem(name: string): string | null {
  if (name.startsWith('-')) return '브랜치 이름은 ‘-’로 시작할 수 없습니다'
  if (name === 'HEAD') return '‘HEAD’는 브랜치 이름으로 쓸 수 없습니다'
  if (/[ \t]/.test(name)) return '브랜치 이름에 공백은 쓸 수 없습니다'
  if (/[\x00-\x1f\x7f]/.test(name)) return '브랜치 이름에 제어 문자는 쓸 수 없습니다'
  const ch = /[~^:?*[\\]/.exec(name)?.[0]
  if (ch) return `브랜치 이름에 ‘${ch}’ 문자는 쓸 수 없습니다`
  if (name.includes('..')) return '브랜치 이름에 연속된 점(..)은 쓸 수 없습니다'
  if (name.includes('@{')) return '브랜치 이름에 ‘@{’는 쓸 수 없습니다'
  if (name.startsWith('/') || name.endsWith('/')) return '브랜치 이름은 ‘/’로 시작하거나 끝날 수 없습니다'
  if (name.includes('//')) return '브랜치 이름에 ‘//’는 쓸 수 없습니다'
  if (name.startsWith('.')) return '브랜치 이름은 ‘.’으로 시작할 수 없습니다'
  if (name.includes('/.')) return '‘/’ 다음에 ‘.’이 올 수 없습니다'
  if (name.endsWith('.lock')) return '브랜치 이름은 ‘.lock’으로 끝날 수 없습니다'
  if (name.includes('.lock/')) return '‘.lock’ 다음에 ‘/’가 올 수 없습니다'
  if (name.endsWith('.')) return '브랜치 이름은 ‘.’으로 끝날 수 없습니다'
  return null
}

/** What a branch name does: refused by git, taken by a worktree, an existing branch, one of a remote, or new. */
export type Plan =
  | { kind: 'empty' }
  | { kind: 'bad'; why: string }
  | { kind: 'taken'; path: string }
  | { kind: 'local'; path: string }
  | { kind: 'remote'; path: string; remote: string }
  | { kind: 'new'; path: string }

/**
 * What a worktree for the branch name (trimmed) would be, in a repository
 * with the worktrees ws and the main one at main; b, its branches, is null
 * while they are not known.
 */
export function planOf(name: string, ws: Worktree[], main: string, b: Branches | null): Plan {
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

/** What to ask the server for the plan, from base when the branch is new; null when there is nothing to make. */
export function worktreeRequest(plan: Plan, name: string, base: string): NewWorktree | null {
  if (plan.kind === 'new') return { branch: name, create: true, ...(base ? { base } : {}) }
  if (plan.kind === 'local' || plan.kind === 'remote') return { branch: name, create: false }
  return null
}
