// 설정 (spec §3 #113, the B-Pair board): one column of cards on a phone and
// a PC alike. On the hub: this device's notifications and theme, the devices
// that may use it, the hosts linked to it, and what it keeps for all of them.
// On a linked host (#168): what that host keeps, and this device's theme.
import { useId } from 'preact/hooks'
import { Segmented } from '../components/Segmented'
import { hello } from '../lib/boot'
import { versionText } from '../lib/format'
import { useHost } from '../lib/scope'
import { setTheme, theme, THEME_LABEL, type ThemePref } from '../lib/theme'
import type { CoreStatus } from '../lib/types'
import { newBuild, reloadPage } from '../lib/update'
import { DeviceCards } from './SettingsDevices'
import { nameOf } from './HostSwitch'
import { FoldersCard, PresetsCard } from './SettingsEdit'
import { HostNoticesCard, HostsCard, LinkHostCard, settingsSub } from './SettingsHosts'
import { PushCards } from './SettingsPush'
import './settings.css'

const THEMES: ThemePref[] = ['system', 'light', 'dark']

export interface SettingsProps {
  variant: 'pc' | 'phone'
}

export function Settings({ variant }: SettingsProps) {
  const h = useHost()
  const isHub = h.id === ''
  const fresh = newBuild.value
  const col = (
    <div class="st-col">
      {fresh && <UpdateCard version={fresh} />}
      {isHub ? (
        <>
          <PushCards />
          <DeviceCards variant={variant} />
        </>
      ) : (
        <HostNoticesCard />
      )}
      <ThemeCard />
      <FoldersCard />
      {isHub && (
        <>
          <HostsCard />
          <LinkHostCard />
        </>
      )}
      <PresetsCard />
      <AboutCard />
    </div>
  )
  // On a phone the tab's own header and scroll hold it.
  if (variant === 'phone') return col
  return (
    <div class="st st-pc">
      <header class="st-head">
        <h1>설정</h1>
        <span class="st-sub">
          <b>{nameOf(h)}</b> · {settingsSub(h)}
        </span>
      </header>
      <div class="st-scroll">{col}</div>
    </div>
  )
}

/** The hub runs a newer build than this page (spec §3 #182). */
function UpdateCard({ version }: { version: string }) {
  const id = useId()
  return (
    <section class="st-card" aria-labelledby={id}>
      <div class="st-card-head">
        <h2 id={id} class="st-h2">
          새 버전
        </h2>
        <button type="button" class="btn btn-primary btn-sm" onClick={reloadPage}>
          새로고침
        </button>
      </div>
      <p class="st-hint">
        허브가 {versionText(version)} 버전으로 바뀌었습니다. 쓰던 글은 새로 고쳐도 남습니다.
      </p>
    </section>
  )
}

function ThemeCard() {
  const id = useId()
  return (
    <section class="st-card" aria-labelledby={id}>
      <h2 id={id} class="st-h2">
        화면
      </h2>
      <div class="st-field st-theme">
        <span class="field-label" aria-hidden="true">
          테마
        </span>
        <Segmented label="테마" items={THEMES.map((v) => ({ value: v, label: THEME_LABEL[v] }))} value={theme.value} onChange={setTheme} />
      </div>
      <p class="st-hint">이 기기에만 적용됩니다. 터미널은 늘 어둡게 보입니다.</p>
    </section>
  )
}

/** What the core is to its host, in a word or two. */
function coreText(c: CoreStatus): string {
  if (c.connected) return ['연결됨', c.version && versionText(c.version)].filter(Boolean).join(' · ')
  return c.error?.includes('hc not found') ? '설치되지 않음' : '연결 안 됨'
}

function AboutCard() {
  const id = useId()
  const h = useHost()
  // Before the overview, the hub's hello says its version; a linked host's is not known yet.
  const v = h.host.value?.version ?? (h.id === '' ? hello.value?.version : undefined)
  return (
    <section class="st-card" aria-labelledby={id}>
      <h2 id={id} class="st-h2">
        정보
      </h2>
      <dl class="st-facts">
        <div>
          <dt>호스트</dt>
          <dd>{h.name.value || '알 수 없음'}</dd>
        </div>
        <div>
          <dt>Mori</dt>
          <dd>{v ? versionText(v) : '알 수 없음'}</dd>
        </div>
        <div>
          <dt>herdr-core</dt>
          <dd>{coreText(h.core.value)}</dd>
        </div>
      </dl>
    </section>
  )
}
