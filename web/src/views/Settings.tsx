// 설정 (spec §3 #113, the B-Pair board): one column of cards on a phone and
// a PC alike. This device's notifications and theme, the devices that may
// use this host, and what the host keeps for all of them.
import { useId } from 'preact/hooks'
import { Segmented } from '../components/Segmented'
import { hello, hostLabel } from '../lib/boot'
import { versionText } from '../lib/format'
import { core, host } from '../lib/store'
import { setTheme, theme, THEME_LABEL, type ThemePref } from '../lib/theme'
import { DeviceCards } from './SettingsDevices'
import { FoldersCard, HostsCard, PresetsCard } from './SettingsEdit'
import { PushCards } from './SettingsPush'
import './settings.css'

const THEMES: ThemePref[] = ['system', 'light', 'dark']

export interface SettingsProps {
  variant: 'pc' | 'phone'
}

export function Settings({ variant }: SettingsProps) {
  const col = (
    <div class="st-col">
      <PushCards />
      <DeviceCards variant={variant} />
      <ThemeCard />
      <FoldersCard />
      <HostsCard />
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
          <b>{hostLabel.value || '이 호스트'}</b> · 이 호스트의 알림과 기기
        </span>
      </header>
      <div class="st-scroll">{col}</div>
    </div>
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

/** What the core is to this host, in a word or two. */
function coreText(): string {
  const c = core.value
  if (c.connected) return ['연결됨', c.version && versionText(c.version)].filter(Boolean).join(' · ')
  return c.error?.includes('hc not found') ? '설치되지 않음' : '연결 안 됨'
}

function AboutCard() {
  const id = useId()
  const v = host.value?.version ?? hello.value?.version
  return (
    <section class="st-card" aria-labelledby={id}>
      <h2 id={id} class="st-h2">
        정보
      </h2>
      <dl class="st-facts">
        <div>
          <dt>호스트</dt>
          <dd>{hostLabel.value || '알 수 없음'}</dd>
        </div>
        <div>
          <dt>Mori</dt>
          <dd>{v ? versionText(v) : '알 수 없음'}</dd>
        </div>
        <div>
          <dt>herdr-core</dt>
          <dd>{coreText()}</dd>
        </div>
      </dl>
    </section>
  )
}
