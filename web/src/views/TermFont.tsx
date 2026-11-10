// The terminal's letter size (spec §3 #185): a row of sizes in 설정 and,
// on a phone, in a sheet from the terminal's menu, where the screen behind
// it changes as a size is picked.
import { useId } from 'preact/hooks'
import { Segmented } from '../components/Segmented'
import { Sheet, SheetHead } from '../components/Sheet'
import { DEFAULT_FONT, FONT_SIZES, fontFor, setTermFont, type Layout } from '../lib/termfont'
import './termfont.css'

const SIZES = FONT_SIZES.map((v) => ({ value: String(v), label: String(v) }))

export const FONT_HINT = '바꾸면 터미널의 칸 수가 이 화면에 맞게 바뀝니다. 같은 세션을 보는 다른 화면에도 바뀐 칸 수로 보입니다.'

export function TermFontField({ layout }: { layout: Layout }) {
  return (
    <div class="field term-font">
      <span class="field-label" aria-hidden="true">
        터미널 글자 크기
      </span>
      <Segmented label="터미널 글자 크기" items={SIZES} value={String(fontFor(layout))} onChange={(v) => setTermFont(layout, Number(v))} />
    </div>
  )
}

export function TermFontSheet({ open, layout, onClose }: { open: boolean; layout: Layout; onClose: () => void }) {
  const id = useId()
  return (
    <Sheet open={open} labelledBy={id} onClose={onClose} class="term-font-sheet">
      <SheetHead id={id} title="글자 크기" onClose={onClose} />
      <div class="sheet-body term-font-body">
        <TermFontField layout={layout} />
        <p class="field-hint">
          기본은 {DEFAULT_FONT[layout]}입니다. {FONT_HINT}
        </p>
      </div>
    </Sheet>
  )
}
