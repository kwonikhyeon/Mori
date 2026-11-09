import type { ChipInfo } from '../lib/format'
import { Icon } from './Icon'

/** The state of a terminal as a pill; big is the phone's alert cards. */
export function Chip({ info, big = false }: { info: ChipInfo; big?: boolean }) {
  return (
    <span class={`chip chip-${info.kind}` + (big ? ' chip-big' : '')}>
      {info.kind === 'error' && <Icon name="warning" size={12} stroke={2.2} />}
      {info.label}
    </span>
  )
}
