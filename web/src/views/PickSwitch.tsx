// This device's switch for reading Claude Code's windows (pickers design
// §6.9): astryx's Switch (md), as it applies at once. Off, the windows stay
// in the terminal, the way out when the reading goes wrong.

import type { JSX } from 'preact'
import { useId } from 'preact/hooks'
import { pickOn, setPickOn } from '../lib/pickpref'

export function PickSwitch(): JSX.Element {
  const id = useId()
  return (
    <label class="st-row">
      <span class="st-row-main">
        <span id={id} class="st-row-name">
          Claude Code 창 알아보기
        </span>
        <span id={id + '-sub'} class="st-row-sub is-wrap">
          Claude Code가 띄운 고르는 창을 입력창 위에 단추로 보여 줍니다. 끄면 터미널에서 고릅니다. 이 기기에만 적용됩니다.
        </span>
      </span>
      <input
        type="checkbox"
        role="switch"
        class="st-check"
        checked={pickOn.value}
        aria-labelledby={id}
        aria-describedby={id + '-sub'}
        onChange={(e) => setPickOn(e.currentTarget.checked)}
      />
    </label>
  )
}
