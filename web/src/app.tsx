import { Toasts } from './components/Toasts'
import { hello, paired, phase, refusal } from './lib/boot'
import { Pair } from './views/Pair'
import { Refused } from './views/Refused'
import { Shell } from './views/Shell'

export function App() {
  const ph = phase.value
  return (
    <>
      {ph === 'pair' && <Pair hello={hello.value} onPaired={paired} />}
      {ph === 'app' && <Shell />}
      {ph === 'refused' && refusal.value && <Refused err={refusal.value} />}
      <Toasts />
    </>
  )
}
