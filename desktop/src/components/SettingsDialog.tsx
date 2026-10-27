import { useEffect } from 'react'
import type { DocxStyle, Settings, ThemePref } from '../types'

const THEMES: { value: ThemePref; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

export const CITATION_STYLES: { value: DocxStyle; label: string; example: string }[] = [
  { value: 'apa', label: 'APA 7', example: '(Chen & Martinez, 2021, p. 342)' },
  { value: 'mla', label: 'MLA 9', example: '(Chen and Martinez 342)' },
  { value: 'ieee', label: 'IEEE', example: '[1, p. 342]' },
]

interface Props {
  settings: Settings
  onChange: (changes: Partial<Settings>) => void
  onClose: () => void
}

export function SettingsDialog({ settings, onChange, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="modal-head">
          <h2 id="settings-title">Settings</h2>
          <button className="icon" onClick={onClose} aria-label="Close settings">
            ×
          </button>
        </header>

        <section className="setting">
          <h3>Theme</h3>
          <div className="segmented" role="radiogroup" aria-label="Theme">
            {THEMES.map((t) => (
              <button
                key={t.value}
                role="radio"
                aria-checked={settings.theme === t.value}
                className={settings.theme === t.value ? 'active' : ''}
                onClick={() => onChange({ theme: t.value })}
              >
                {t.label}
              </button>
            ))}
          </div>
        </section>

        <section className="setting">
          <h3>Citation style</h3>
          <p className="muted">Used for Word export and the References tab.</p>
          <div className="choices" role="radiogroup" aria-label="Citation style">
            {CITATION_STYLES.map((s) => (
              <label key={s.value} className={settings.citation_style === s.value ? 'choice active' : 'choice'}>
                <input
                  type="radio"
                  name="citation-style"
                  checked={settings.citation_style === s.value}
                  onChange={() => onChange({ citation_style: s.value })}
                />
                <span className="choice-label">{s.label}</span>
                <span className="choice-example">{s.example}</span>
              </label>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
