/** Percentage displays shared by the History and Review panels. `tone` picks the colour:
 * "change" is neutral accent, "risk" turns amber then red as the share grows. */
export type Tone = 'change' | 'risk' | 'ok'

export function toneOf(pct: number, tone: Tone): string {
  if (tone === 'ok') return 'var(--ok)'
  if (tone === 'change') return 'var(--accent)'
  return pct >= 25 ? 'var(--bad)' : pct >= 10 ? 'var(--warn)' : 'var(--ok)'
}

/** A donut with the percentage in the middle. */
export function Ring({ pct, tone = 'change', size = 76, caption }: { pct: number; tone?: Tone; size?: number; caption?: string }) {
  const r = 15.5
  const c = 2 * Math.PI * r
  const clamped = Math.max(0, Math.min(100, pct))
  return (
    <div className="ring" style={{ width: size, height: size }} role="img" aria-label={`${pct}%${caption ? ` ${caption}` : ''}`}>
      <svg viewBox="0 0 36 36" width={size} height={size} aria-hidden="true">
        <circle cx="18" cy="18" r={r} className="ring-track" />
        <circle
          cx="18" cy="18" r={r}
          className="ring-value"
          stroke={toneOf(pct, tone)}
          strokeDasharray={`${(clamped / 100) * c} ${c}`}
        />
      </svg>
      <div className="ring-label">
        <b>{pct}%</b>
        {caption && <span>{caption}</span>}
      </div>
    </div>
  )
}

/** A thin horizontal bar with the percentage beside it. */
export function Meter({ pct, tone = 'change', label, title }: { pct: number; tone?: Tone; label?: string; title?: string }) {
  const clamped = Math.max(0, Math.min(100, pct))
  return (
    <div className="meter" title={title}>
      {label && <span className="meter-label">{label}</span>}
      <span className="meter-track">
        <span className="meter-fill" style={{ width: `${clamped}%`, background: toneOf(pct, tone) }} />
      </span>
      <span className="meter-pct">{pct}%</span>
    </div>
  )
}

export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  label: string
}) {
  return (
    <div className="segmented small" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={value === o.value} className={value === o.value ? 'active' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** "3 min ago" from the backend's UTC "YYYY-MM-DD HH:MM:SS" (or a millisecond timestamp). */
export function ago(when: string | number): string {
  const t = typeof when === 'number' ? when : Date.parse(when.replace(' ', 'T') + 'Z')
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
