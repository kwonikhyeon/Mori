import { Toasts } from './components/Toasts'
import { hello, paired, phase } from './lib/boot'
import { Pair } from './views/Pair'
import { Shell } from './views/Shell'

export function App() {
  const ph = phase.value
  return (
    <>
      {ph === 'pair' && <Pair hello={hello.value} onPaired={paired} />}
      {ph === 'app' && <Shell />}
      <Toasts />
    </>
  )
}
