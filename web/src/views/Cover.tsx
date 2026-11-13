// Mori's status band over Claude Code's input box and what is below it
// (claude-input design §3, spec §3 #217, #223). The band reads the screen
// a frame at a time, as the picker panel does, and lies over the rows it
// stands for, inside the stage: the terminal keeps its size. The status
// line, the person's own, is drawn as astryx Badges and ProgressBars; the
// mode is a button that sends Shift+Tab.

import type { JSX } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { readBox, type BoxLook, type Mode } from "../lib/box";
import { DEPTH, look } from "../lib/pick";
import { readStatus } from "../lib/status";
import type { Screen } from "../lib/xterm";

export interface BoxReading {
  box: BoxLook | null;
  /** The row of the rule over the box on the screen as it shows now. */
  row: number;
  /** Claude Code fills the screen (the alternate buffer). */
  alternate: boolean;
  /** The view shows the end of the output. */
  end: boolean;
  /** The last mode read, kept while the box is away. */
  mode: Mode | null;
  /**
   * The row on the screen of the first line under a window's hint line, -1
   * for none: Claude Code keeps its status lines there (spec §3 #250).
   */
  under: number;
}

const NONE: BoxReading = {
  box: null,
  row: -1,
  alternate: false,
  end: true,
  mode: null,
  under: -1,
};

/** A box with no mode line under it: Claude Code's default mode (pickers design §9.5). */
const DEFAULT_MODE: Mode = { name: "", label: "기본", extras: [] };

/** Reads Claude Code's input box at the bottom of the screen as it changes. */
export function useBox({
  screen,
  ready,
  on,
}: {
  screen: { current: Screen | null };
  ready: unknown;
  on: boolean;
}): BoxReading {
  const [reading, setReading] = useState(NONE);
  const last = useRef("");
  const mode = useRef<Mode | null>(null);
  useEffect(() => {
    const s = screen.current;
    if (!on || !s) {
      last.current = "";
      setReading((r) => (r.box ? { ...NONE, mode: r.mode } : r));
      return;
    }
    let frame: number | null = null;
    const step = () => {
      frame = null;
      const shot = s.shot(DEPTH);
      const box = readBox(shot);
      const seen = look(shot).seen;
      // a box read with no mode line is the default mode; with no box the last one stays
      if (box) mode.current = box.mode ?? DEFAULT_MODE;
      const next: BoxReading = {
        box,
        row: box ? box.top - shot.view : -1,
        alternate: shot.kind === "alternate",
        end: s.atEnd(),
        mode: mode.current,
        under: seen && seen.below > 0 ? shot.top + shot.lines.length - seen.below - shot.view : -1,
      };
      const key = JSON.stringify(next);
      if (key === last.current) return;
      last.current = key;
      setReading(next);
    };
    const later = () => {
      if (frame === null) frame = requestAnimationFrame(step);
    };
    step();
    const off = s.onView(later);
    return () => {
      off();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [ready, on]);
  return reading;
}

/** The mode as a button: Shift+Tab moves to the next one. */
export function ModeButton({
  mode,
  onPress,
  class: cls,
  disabled,
}: {
  mode: Mode;
  onPress: () => void;
  class: string;
  disabled?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      class={cls}
      disabled={disabled}
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        if (!disabled) onPress();
      }}
    >
      모드: {mode.label}
    </button>
  );
}

/**
 * The band over the box's rows, from the rule over it to the bottom: a sheet
 * at its foot, as tall as what it shows, with the status line's parts, and
 * on a phone the mode, as the PC has it in the box's row; above the sheet the
 * band is the terminal's own blank, less than a row once the terminal has
 * taken the rows the sheet leaves (spec §3 #228): onSheet hears the sheet's
 * height with all its rows. A press elsewhere in it gives the box the focus
 * (PC).
 */
export function StatusBand({
  box,
  top,
  phone,
  mode,
  onMode,
  onFocus,
  onSheet,
}: {
  box: BoxLook;
  top: number;
  phone: boolean;
  mode: Mode | null;
  onMode: () => void;
  onFocus: () => void;
  onSheet: (px: number) => void;
}): JSX.Element {
  const parts = readStatus(box.status);
  const extras = mode?.extras ?? [];
  const self = useRef<HTMLElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  // Rows that do not fit the rows covered go whole, from the bottom: the
  // first, with the mode, stays (claude-input design §3.3).
  useLayoutEffect(() => {
    const el = self.current;
    const sh = sheet.current;
    if (!el || !sh) return;
    const rows = [
      ...sh.querySelectorAll<HTMLElement>(":scope > .term-cover-row"),
    ];
    for (const r of rows) r.hidden = false;
    onSheet(sh.offsetHeight);
    const cs = getComputedStyle(sh);
    const px = (v: string) => parseFloat(v) || 0;
    const room =
      el.clientHeight -
      px(cs.paddingTop) -
      px(cs.paddingBottom) -
      px(cs.borderTopWidth);
    const gap = px(cs.rowGap);
    let used = 0;
    rows.forEach((r, i) => {
      used += r.offsetHeight + (i ? gap : 0);
      if (i > 0 && used > room) r.hidden = true;
    });
  });
  return (
    <section
      ref={self}
      class="term-cover"
      aria-label="Claude Code 상태"
      style={{ top: `${top}px` }}
      onClick={(e) => {
        e.stopPropagation();
        if (!(e.target as HTMLElement).closest("button")) onFocus();
      }}
    >
      <div ref={sheet} class="term-cover-sheet">
        {((phone && mode) || extras.length > 0) && (
          <div class="term-cover-row">
            {phone && mode && (
              <ModeButton
                mode={mode}
                onPress={onMode}
                class="btn btn-sm term-cover-mode"
              />
            )}
            {extras.map((x) => (
              <span key={x} class="chip chip-none">
                {x}
              </span>
            ))}
          </div>
        )}
        {parts.map((p, i) =>
          p.kind === "chips" ? (
            <div key={i} class="term-cover-row">
              {p.chips.map((c, j) => (
                <span key={j} class="chip chip-none">
                  {c}
                </span>
              ))}
            </div>
          ) : p.kind === "bar" ? (
            <div key={i} class="term-cover-row term-cover-meter">
              <span class="term-cover-name">{p.name}</span>
              <span
                class="bar"
                role="progressbar"
                aria-label={p.name || "상태 막대"}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={p.percent}
              >
                <span style={{ width: `${p.percent}%` }} />
              </span>
              <span class="term-cover-pct">{p.percent}%</span>
              {p.rest && <span class="term-cover-rest">{p.rest}</span>}
            </div>
          ) : (
            <div key={i} class="term-cover-row term-cover-text">
              {p.text}
            </div>
          ),
        )}
      </div>
    </section>
  );
}
