import { useMemo } from 'react'
import type { Doc } from '../types'
import { type Axis, type TimeField, type TimeWindow, histogram, posLabel } from '../timeline'

interface Props {
  docs: Doc[]
  axis: Axis
  window: TimeWindow
  onChange: (w: TimeWindow) => void
  /** Switch between dates added and dates published; the window resets to every date. */
  onField: (field: TimeField) => void
  onClose: () => void
  shown: number // sources the library shows with every filter applied
  ghosts: number // removed since the "as of" date, shown greyed
  undated: number // no date for this field, so hidden while the timeline is on
  toLookUp: number // papers OpenAlex hasn't been asked about yet
  lookupNote: string
  busy: boolean
  onLookUp: () => void
}

/** The library's date slider: a bar per month (or year) of how many sources fall there, with
 * handles to narrow the library to a range, or one handle to see it as it was on a past date. */
export function Timeline({ docs, axis, window: w, onChange, onField, onClose, shown, ghosts, undated, toLookUp, lookupNote, busy, onLookUp }: Props) {
  const { exact, spread } = useMemo(() => histogram(axis, w.field, docs), [axis, w.field, docs])
  const n = axis.end - axis.start + 1
  const top = Math.max(1, ...exact.map((c, i) => c + spread[i]))
  const asof = w.mode === 'asof'
  const full = !asof && w.lo <= axis.start && w.hi >= axis.end
  const picked = (i: number) => (asof ? i <= w.hi : i >= w.lo && i <= w.hi)
  const unit = axis.unit === 'year' ? 'year' : 'month'

  const summary = asof
    ? `Your library at the end of ${posLabel(axis, w.hi)}`
    : w.lo === w.hi
      ? posLabel(axis, w.lo)
      : `${posLabel(axis, w.lo)} – ${posLabel(axis, w.hi)}`
  const counts = `${shown} source${shown === 1 ? '' : 's'}${ghosts ? `, ${ghosts} removed since` : ''}`

  // The bars line up under the slider's thumbs: thumb centres run from 7px to the width less
  // 7px, and the chart is widened by half a bar each side so bar centres fall on them.
  const chartStyle = n > 1
    ? { left: `calc(7px - (100% - 14px) / ${2 * (n - 1)})`, width: `calc((100% - 14px) * ${n / (n - 1)})` }
    : { left: 0, width: '100%' }

  return (
    <section className="tl" aria-label="Timeline">
      <div className="tl-top">
        <div className="segmented tl-seg" role="group" aria-label="Date">
          <button className={w.field === 'added' ? 'active' : ''} onClick={() => onField('added')} title="When you got each file">
            Added
          </button>
          <button className={w.field === 'published' ? 'active' : ''} onClick={() => onField('published')} title="When each paper was published">
            Published
          </button>
        </div>
        {w.field === 'added' && (
          <div className="segmented tl-seg" role="group" aria-label="Show">
            <button className={!asof ? 'active' : ''} onClick={() => onChange({ ...w, mode: 'range' })} title="Sources added between two dates">
              Range
            </button>
            <button
              className={asof ? 'active' : ''}
              onClick={() => onChange({ ...w, mode: 'asof' })}
              title="Your library as it was on a date, with sources removed since shown greyed"
            >
              As of
            </button>
          </div>
        )}
        <span className="tl-summary">
          <b>{summary}</b>
          <span className="muted"> · {counts}</span>
        </span>
        <span className="spacer" />
        {!full && (
          <button className="link" onClick={() => onChange({ ...w, mode: 'range', lo: axis.start, hi: axis.end })}>
            All dates
          </button>
        )}
      </div>
      <button className="icon tl-close" onClick={onClose} aria-label="Close timeline" title="Close the timeline">×</button>

      <div className="tl-chart">
        <svg className="tl-bars" style={chartStyle} viewBox={`-0.5 0 ${n} 100`} preserveAspectRatio="none" aria-hidden="true">
          {exact.map((c, i) => {
            const pos = axis.start + i
            const e = (c / top) * 100
            const s = (spread[i] / top) * 100
            const tip = `${posLabel(axis, pos)}: ${c ? `${c} source${c === 1 ? '' : 's'}` : 'none'}${spread[i] ? `, and some of the ${Math.round(spread[i] * 12) || 1} known only by year` : ''}`
            return (
              <g
                key={pos}
                className={`tl-bin${picked(pos) ? ' on' : ''}`}
                onClick={() => onChange(asof ? { ...w, hi: pos } : { ...w, lo: pos, hi: pos })}
              >
                <title>{tip}</title>
                <rect className="tl-hit" x={i - 0.5} y={0} width={1} height={100} />
                {c > 0 && <rect className="tl-exact" x={i - 0.38} y={100 - e} width={0.76} height={e} />}
                {s > 0 && <rect className="tl-spread" x={i - 0.38} y={100 - e - s} width={0.76} height={s} />}
              </g>
            )
          })}
        </svg>
        <div className="tl-track" aria-hidden="true">
          <div
            className="tl-track-on"
            style={{
              left: `${n > 1 ? (((asof ? axis.start : w.lo) - axis.start) / (n - 1)) * 100 : 0}%`,
              right: `${n > 1 ? ((axis.end - w.hi) / (n - 1)) * 100 : 0}%`,
            }}
          />
        </div>
        {!asof && (
          <input
            className="tl-range"
            type="range"
            min={axis.start}
            max={axis.end}
            value={w.lo}
            // Both thumbs at the far end: the start one on top, or it couldn't be dragged back.
            style={w.lo >= axis.end ? { zIndex: 1 } : undefined}
            aria-label={`From ${unit}`}
            aria-valuetext={posLabel(axis, w.lo)}
            onChange={(e) => onChange({ ...w, lo: Math.min(Number(e.target.value), w.hi) })}
          />
        )}
        <input
          className="tl-range"
          type="range"
          min={axis.start}
          max={axis.end}
          value={w.hi}
          aria-label={asof ? 'As of' : `To ${unit}`}
          aria-valuetext={posLabel(axis, w.hi)}
          onChange={(e) => onChange({ ...w, hi: Math.max(Number(e.target.value), asof ? axis.start : w.lo) })}
        />
      </div>
      <div className="tl-ends muted" aria-hidden="true">
        <span>{posLabel(axis, axis.start)}</span>
        <span>{posLabel(axis, axis.end)}</span>
      </div>

      <p className="tl-note muted">
        {w.field === 'added'
          ? asof
            ? 'Sources you had by the end of that month. Ones removed since are listed greyed at the bottom: open one to restore it.'
            : "By when you got each file: its date on this computer, or when you added it here if that's earlier. Click a bar to jump to that month."
          : (spread.some(Boolean) ? 'Lighter bars are papers known only by year. ' : '') +
            (undated ? `${undated} source${undated === 1 ? ' has' : 's have'} no year and ${undated === 1 ? 'is' : 'are'} hidden. ` : '')}
        {w.field === 'published' && toLookUp > 0 && (
          <button className="link" onClick={onLookUp} disabled={busy} title="Asks OpenAlex, by DOI or by title and year">
            Look up exact dates for {toLookUp} paper{toLookUp === 1 ? '' : 's'}
          </button>
        )}
        {w.field === 'published' && lookupNote && <span> {lookupNote}</span>}
      </p>
    </section>
  )
}
