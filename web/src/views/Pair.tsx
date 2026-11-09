// Pairing this browser (spec §3 #130): the code from `mori pair` or from
// another device's Settings, and the name the other devices will see.
import type { JSX } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { api } from '../lib/api'
import { codeFromHash, deviceName, formatCode, normalizeCode } from '../lib/pairing'
import { errorText } from '../lib/toast'
import type { Hello } from '../lib/types'
import './pair.css'

export interface PairProps {
  hello: Hello | null
  onPaired: () => void
}

export function Pair({ hello, onPaired }: PairProps) {
  const [code, setCode] = useState(() => codeFromHash(location.hash))
  const [name, setName] = useState(() => deviceName(navigator.userAgent, navigator.maxTouchPoints ?? 0))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const codeRef = useRef<HTMLInputElement>(null)
  const complete = normalizeCode(code).length === 8

  useEffect(() => {
    if (!complete) codeRef.current?.focus()
  }, [])

  const submit = async (e: JSX.TargetedSubmitEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!complete || busy) return
    setBusy(true)
    setErr('')
    try {
      await api.pair(formatCode(code), name.trim())
    } catch (x) {
      setErr(errorText(x))
      setBusy(false)
      return
    }
    onPaired()
  }

  return (
    <div class="pair">
      <form class="pair-card" onSubmit={submit} noValidate>
        <p class="pair-brand">Mori</p>
        <div class="pair-intro">
          <h1>이 기기 페어링</h1>
          {hello?.host && (
            <p class="pair-host">
              <b>{hello.host}</b>에 연결합니다
            </p>
          )}
        </div>
        <p class="pair-hint">
          서버 컴퓨터에서 <code>mori pair</code>를 실행하거나, 이미 연결된 기기의 설정 → 새 기기 페어링에서 코드를 받으세요.
        </p>
        <div class="field">
          <label class="field-label" for="pair-code">
            페어링 코드
          </label>
          <input
            ref={codeRef}
            id="pair-code"
            class="input pair-code"
            value={code}
            onInput={(e) => setCode(formatCode(e.currentTarget.value))}
            placeholder="XXXX-XXXX"
            maxLength={9}
            inputMode="text"
            autocomplete="one-time-code"
            autoCapitalize="characters"
            autoCorrect="off"
            spellcheck={false}
            aria-invalid={err ? true : undefined}
          />
        </div>
        <div class="field">
          <label class="field-label" for="pair-name">
            이 기기 이름
          </label>
          <input
            id="pair-name"
            class="input"
            value={name}
            onInput={(e) => setName(e.currentTarget.value)}
            maxLength={64}
            autocomplete="off"
            aria-describedby="pair-name-hint"
          />
          <span id="pair-name-hint" class="field-hint">
            다른 기기의 설정에서 이 이름으로 보입니다.
          </span>
        </div>
        {err && (
          <p class="form-error" role="alert">
            {err}
          </p>
        )}
        <button type="submit" class="btn btn-primary btn-block pair-go" disabled={!complete || busy}>
          {busy ? '페어링 중…' : '페어링'}
        </button>
      </form>
    </div>
  )
}
