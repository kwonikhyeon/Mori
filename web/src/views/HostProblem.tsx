// What a host linked to the hub shows in place of its screens once it no
// longer has the hub's link (spec §3 #170, decision 163): a new code from
// that host links it again.
import { Icon } from '../components/Icon'
import { hub, nameOf, useHost } from '../lib/scope'
import { hosts } from '../lib/store'
import { openHostSheet } from './HostSwitch'
import { relinkHost } from './SettingsHosts'
import './hostswitch.css'

/** An unlinked host: why, and the way back. A PC picks another host from its header. */
export function HostProblem({ variant }: { variant: 'pc' | 'phone' }) {
  const h = useHost()
  const url = hosts.value.find((x) => x.id === h.id)?.url ?? ''
  return (
    <section class={`empty hp hp-${variant}`}>
      <span class="empty-icon">
        <Icon name="warning" size={26} />
      </span>
      <h2 class="empty-title">{nameOf(h)} 연결이 끊겼습니다</h2>
      <p class="empty-text">그 호스트가 이 허브의 연결을 해제했거나 아직 잇지 않았습니다. 그 호스트에서 mori pair로 새 코드를 받아 다시 연결하세요.</p>
      <div class="hp-acts">
        <button
          type="button"
          class="btn btn-primary"
          onClick={() => {
            relinkHost.value = url
            hub.go({ name: 'settings' })
          }}
        >
          새 코드로 다시 연결
        </button>
        {variant === 'phone' && (
          <button type="button" class="btn" onClick={(e) => openHostSheet(e.currentTarget)}>
            다른 호스트 보기
          </button>
        )}
      </div>
    </section>
  )
}
