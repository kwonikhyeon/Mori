// Two or three choices side by side, one pressed (B: the sidebar's
// 지금 볼 것 / 폴더 and the theme in Settings).

export interface SegItem<T extends string> {
  value: T
  label: string
  count?: number
}

export interface SegmentedProps<T extends string> {
  label: string
  items: SegItem<T>[]
  value: T
  onChange: (v: T) => void
}

export function Segmented<T extends string>({ label, items, value, onChange }: SegmentedProps<T>) {
  return (
    <div class="seg" role="group" aria-label={label}>
      {items.map((it) => (
        <button key={it.value} type="button" class="seg-btn" aria-pressed={it.value === value} onClick={() => onChange(it.value)}>
          {it.label}
          {it.count ? <span class="count-pill">{it.count}</span> : null}
        </button>
      ))}
    </div>
  )
}
