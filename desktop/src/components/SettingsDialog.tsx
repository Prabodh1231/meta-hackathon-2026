import { useEffect, useRef, useState } from 'react'
import { useFocusTrap } from '../useFocusTrap'
import { api } from '../api'
import type { DocxStyle, ModelSettings, SearchSettings, Settings, SourceSettings, ThemePref } from '../types'

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

/** What the app uses until the backend's settings arrive (USER_SETTINGS in backend/app/library.py). */
export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  page_width: 'normal',
  text_size: 'normal',
  doc_font: 'charter',
  spellcheck: true,
  tools_at_start: 'last',
  citation_style: 'apa',
  assistant_passages: 8,
  cite_scope: 'ticked',
  duplicate_sensitivity: 50,
  auto_recheck: true,
  snapshot_minutes: 10,
  snapshots_kept: 40,
  folder_similarity: 50,
  contact_email: '',
  index_lookup: true,
}

const FONTS: { value: Settings['doc_font']; label: string; family: string }[] = [
  { value: 'charter', label: 'Charter', family: 'Charter, "Bitstream Charter", Georgia, serif' },
  { value: 'georgia', label: 'Georgia', family: 'Georgia, "Times New Roman", serif' },
  { value: 'sans', label: 'Sans serif', family: 'system-ui, "Segoe UI", sans-serif' },
]

const EFFORT_NOTES: Record<string, string> = {
  minimal: 'Fastest and cheapest; fine for summaries and tags.',
  low: 'The default: quick, and good enough for most checks.',
  medium: 'Slower; more careful drafting and verification.',
  high: 'Slower still; for hard claims.',
  xhigh: 'Slowest; the most thorough reasoning.',
}

export type Section = 'appearance' | 'writing' | 'review' | 'library' | 'search' | 'model'
const SECTIONS: { id: Section; label: string }[] = [
  { id: 'appearance', label: 'Appearance & editor' },
  { id: 'writing', label: 'Writing & citations' },
  { id: 'review', label: 'Review & history' },
  { id: 'library', label: 'Library' },
  { id: 'search', label: 'Search' },
  { id: 'model', label: 'AI model' },
]

interface Props {
  settings: Settings
  onChange: (changes: Partial<Settings>) => void
  /** The model, or where search runs, was switched: the status bar shows the new one. */
  onModelChanged: () => void
  onClose: () => void
  section?: Section // the section to open at (Appearance by default)
}

function Choice<T extends string>({ label, value, options, onChange }: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={value === o.value} className={value === o.value ? 'active' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** A number on a slider. Saved once the slider settles, not at every step it passes. */
function Slider({ label, value, min, max, step = 1, unit = '', onChange }: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  onChange: (v: number) => void
}) {
  const [local, setLocal] = useState(value)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => setLocal(value), [value])
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return (
    <label className="sim setting-slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={local}
        aria-label={label}
        onChange={(e) => {
          const v = Number(e.target.value)
          setLocal(v)
          window.clearTimeout(timer.current)
          timer.current = window.setTimeout(() => v !== value && onChange(v), 400)
        }}
      />
      <b>
        {local}
        {unit}
      </b>
    </label>
  )
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

function Setting({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="setting">
      <h3>{title}</h3>
      {hint && <p className="muted">{hint}</p>}
      {children}
    </section>
  )
}

/** The email for the open-access indexes: saved on Enter or when the field is left. */
function EmailField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const save = () => text.trim() !== value && onChange(text.trim())
  return (
    <input
      className="setting-input"
      type="email"
      value={text}
      placeholder="you@university.edu"
      aria-label="Contact email"
      onChange={(e) => setText(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === 'Enter' && save()}
    />
  )
}

/** The CORE key: with one, university repositories are searched for free copies too. */
function CoreKeySetting() {
  const [now, setNow] = useState<SourceSettings | null>(null)
  const [key, setKey] = useState('')
  const [state, setState] = useState<{ busy?: boolean; error?: string; done?: string }>({})
  useEffect(() => {
    api
      .sourceSettings()
      .then(setNow)
      .catch((e) => setState({ error: e instanceof Error ? e.message : String(e) }))
  }, [])

  async function save(value: string) {
    setState({ busy: true })
    try {
      setNow(await api.updateSources(value))
      setKey('')
      setState({ done: value ? 'Saved. CORE is searched when a free copy is wanted.' : 'Removed. CORE is no longer searched.' })
    } catch (e) {
      setState({ error: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <Setting
      title="CORE API key (optional)"
      hint={
        now?.has_core_key
          ? `A key is saved${now.core_key_hint ? ` (ending in ${now.core_key_hint})` : ''}. Paste a new one to replace it.`
          : "CORE gathers full texts from thousands of university repositories, including papers OpenAlex and Semantic Scholar don't link. It's searched only with your own key, free from core.ac.uk/services/api."
      }
    >
      <input
        className="setting-input"
        type="password"
        value={key}
        autoComplete="off"
        spellCheck={false}
        placeholder={now?.has_core_key ? '•••• •••• •••• ' + now.core_key_hint : 'Paste your key'}
        aria-label="CORE API key"
        onChange={(e) => setKey(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && key.trim() && save(key.trim())}
      />
      <div className="setting-actions">
        <button className="primary" disabled={!key.trim() || state.busy} onClick={() => save(key.trim())}>
          {state.busy ? 'Checking with CORE…' : 'Save and check'}
        </button>
        {now?.has_core_key && !key && (
          <button className="link danger-link" disabled={state.busy} onClick={() => save('')}>
            Remove key
          </button>
        )}
        {state.done && !key && <span className="setting-ok">{state.done}</span>}
        {state.error && <span className="error-text">{state.error}</span>}
      </div>
    </Setting>
  )
}

/** How the library is searched: keyword search here, ranking by the provider. */
function SearchSection() {
  const [now, setNow] = useState<SearchSettings | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .searchSettings()
      .then(setNow)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  if (!now) return <p className="muted">{error ?? 'Loading…'}</p>

  const ranking =
    now.ranking === 'muse'
      ? `Muse${now.model ? ` (${now.model})` : ''} via Meta's Model API`
      : now.ranking === 'mock'
        ? 'the offline mock (word overlap, on this computer)'
        : now.ranking

  return (
    <Setting title="Now" hint="Keyword search finds the passages that match a question or a sentence you cite; the provider then puts the best first.">
      <p className="setting-now">
        Search: <b>keyword (BM25) on this computer</b>
        <br />
        Ranking: <b>{ranking}</b>
      </p>
      <p className="muted">
        No search model is downloaded or run. With Muse, your query and the best-matching passages
        (trimmed) are sent to Meta's Model API to be ranked; the keyword search itself never leaves this computer.
      </p>
    </Setting>
  )
}

/** Muse or the offline mock, the API key, and how hard Muse thinks. */
function ModelSection({ onModelChanged }: { onModelChanged: () => void }) {
  const [model, setModel] = useState<ModelSettings | null>(null)
  const [provider, setProvider] = useState<'muse' | 'mock'>('mock')
  const [effort, setEffort] = useState('low')
  const [key, setKey] = useState('')
  const [state, setState] = useState<{ busy?: boolean; error?: string; saved?: boolean }>({})

  useEffect(() => {
    api
      .modelSettings()
      .then((m) => {
        setModel(m)
        setProvider(m.provider)
        setEffort(m.reasoning_effort)
      })
      .catch((e) => setState({ error: e instanceof Error ? e.message : String(e) }))
  }, [])

  if (!model) return <p className="muted">{state.error ?? 'Loading…'}</p>

  const changed = provider !== model.provider || effort !== model.reasoning_effort || key.trim() !== ''
  async function save() {
    setState({ busy: true })
    try {
      const m = await api.updateModel({
        provider,
        reasoning_effort: effort,
        ...(key.trim() ? { api_key: key.trim() } : {}),
      })
      setModel(m)
      setKey('')
      setState({ saved: true })
      onModelChanged()
    } catch (e) {
      setState({ error: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <>
      <Setting title="Model" hint="Muse writes summaries and tags, drafts with citations, and checks each quote. The offline mock needs no key and runs on this computer, with rough results.">
        <Choice
          label="Model"
          value={provider}
          options={[
            { value: 'muse', label: 'Muse' },
            { value: 'mock', label: 'Offline mock' },
          ]}
          onChange={setProvider}
        />
      </Setting>
      <Setting
        title="Meta Model API key"
        hint={model.has_key ? `A key is saved${model.key_hint ? ` (ending in ${model.key_hint})` : ''}. Paste a new one to replace it.` : 'Paste the key from your Meta Model API account.'}
      >
        <input
          className="setting-input"
          type="password"
          value={key}
          autoComplete="off"
          spellCheck={false}
          placeholder={model.has_key ? '•••• •••• •••• ' + model.key_hint : 'Paste your key'}
          aria-label="Meta Model API key"
          onChange={(e) => setKey(e.target.value)}
        />
        <p className="muted">It's kept in the .env file in your data folder, on this computer only, and never shown again.</p>
      </Setting>
      <Setting title="Reasoning effort" hint={`How much ${model.model} thinks before answering.`}>
        <select className="setting-input" value={effort} onChange={(e) => setEffort(e.target.value)} aria-label="Reasoning effort">
          {model.efforts.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
        <p className="muted">{EFFORT_NOTES[effort] ?? ''}</p>
      </Setting>
      {model.env_locked.length > 0 && (
        <p className="setting-warn">
          {model.env_locked.join(', ')} {model.env_locked.length === 1 ? 'is' : 'are'} also set in your system environment, which wins
          the next time the app starts. Remove {model.env_locked.length === 1 ? 'it' : 'them'} there to keep these choices.
        </p>
      )}
      <div className="setting-actions">
        <button className="primary" disabled={!changed || state.busy} onClick={save}>
          {state.busy ? 'Saving…' : 'Save and switch'}
        </button>
        {state.saved && !changed && (
          <span className="setting-ok">
            Now using {model.provider === 'muse' ? `Muse (${model.model}) via Meta's Model API` : 'the offline mock'}.
          </span>
        )}
        {state.error && <span className="error-text">{state.error}</span>}
      </div>
    </>
  )
}

export function SettingsDialog({ settings: s, onChange, onModelChanged, onClose, section: initialSection = 'appearance' }: Props) {
  const [section, setSection] = useState<Section>(initialSection)
  const dialog = useRef<HTMLDivElement>(null)
  useFocusTrap(dialog)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} className="modal settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <nav className="settings-nav" aria-label="Settings sections">
          <h2 id="settings-title">Settings</h2>
          {SECTIONS.map((x) => (
            <button key={x.id} className={section === x.id ? 'on' : ''} aria-current={section === x.id ? 'page' : undefined} onClick={() => setSection(x.id)}>
              {x.label}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          <header className="modal-head">
            <h2>{SECTIONS.find((x) => x.id === section)!.label}</h2>
            <button className="icon" onClick={onClose} aria-label="Close settings">
              ×
            </button>
          </header>

          {section === 'appearance' && (
            <>
              <Setting title="Theme">
                <Choice label="Theme" value={s.theme} options={THEMES} onChange={(v) => onChange({ theme: v })} />
              </Setting>
              <Setting title="Page width" hint="How wide the draft's page is.">
                <Choice
                  label="Page width"
                  value={s.page_width}
                  options={[
                    { value: 'narrow', label: 'Narrow' },
                    { value: 'normal', label: 'Normal' },
                    { value: 'wide', label: 'Wide' },
                  ]}
                  onChange={(v) => onChange({ page_width: v })}
                />
              </Setting>
              <Setting title="Text size" hint="The draft's text on screen. Export keeps the sizes set in the toolbar.">
                <Choice
                  label="Text size"
                  value={s.text_size}
                  options={[
                    { value: 'small', label: 'Small' },
                    { value: 'normal', label: 'Normal' },
                    { value: 'large', label: 'Large' },
                  ]}
                  onChange={(v) => onChange({ text_size: v })}
                />
              </Setting>
              <Setting title="Draft font" hint="The page's font on screen. Text you set a font on in the toolbar keeps it.">
                <div className="choices" role="radiogroup" aria-label="Draft font">
                  {FONTS.map((f) => (
                    <label key={f.value} className={s.doc_font === f.value ? 'choice font-choice active' : 'choice font-choice'}>
                      <input type="radio" name="doc-font" checked={s.doc_font === f.value} onChange={() => onChange({ doc_font: f.value })} />
                      <span className="choice-label">{f.label}</span>
                      <span className="choice-example" style={{ fontFamily: f.family }}>
                        Spindles gate memory reactivation.
                      </span>
                    </label>
                  ))}
                </div>
              </Setting>
              <Setting title="Spelling">
                <Toggle label="Underline misspelled words in the draft" checked={s.spellcheck} onChange={(v) => onChange({ spellcheck: v })} />
              </Setting>
              <Setting title="Writing tools at start" hint="Whether the panel beside the draft is open when the app starts. Ctrl+\ opens and closes it.">
                <Choice
                  label="Writing tools at start"
                  value={s.tools_at_start}
                  options={[
                    { value: 'last', label: 'As I left them' },
                    { value: 'open', label: 'Open' },
                    { value: 'closed', label: 'Closed' },
                  ]}
                  onChange={(v) => onChange({ tools_at_start: v })}
                />
              </Setting>
            </>
          )}

          {section === 'writing' && (
            <>
              <Setting title="Citation style" hint="Used for Word export and the reference list in Sources.">
                <div className="choices" role="radiogroup" aria-label="Citation style">
                  {CITATION_STYLES.map((c) => (
                    <label key={c.value} className={s.citation_style === c.value ? 'choice active' : 'choice'}>
                      <input type="radio" name="citation-style" checked={s.citation_style === c.value} onChange={() => onChange({ citation_style: c.value })} />
                      <span className="choice-label">{c.label}</span>
                      <span className="choice-example">{c.example}</span>
                    </label>
                  ))}
                </div>
              </Setting>
              <Setting
                title="Passages Muse drafts from"
                hint="How many of the best-matching passages Muse drafts from (Compose, Cite my sources). Fewer is faster and sticks to the closest matches; more covers more ground."
              >
                <Slider label="Passages Muse drafts from" value={s.assistant_passages} min={3} max={20} onChange={(v) => onChange({ assistant_passages: v })} />
              </Setting>
              <Setting title="Cite markers search" hint="Where a cite marker looks for a source for its sentence.">
                <Choice
                  label="Cite markers search"
                  value={s.cite_scope}
                  options={[
                    { value: 'ticked', label: 'Ticked sources' },
                    { value: 'library', label: 'Whole library' },
                  ]}
                  onChange={(v) => onChange({ cite_scope: v })}
                />
                <p className="muted">
                  {s.cite_scope === 'ticked'
                    ? 'The sources ticked in the Library, or all of them when none are ticked, as drafting from sources does.'
                    : 'Always every source, whatever is ticked in the Library.'}
                </p>
              </Setting>
            </>
          )}

          {section === 'review' && (
            <>
              <Setting
                title="Duplication sensitivity"
                hint="A sentence is flagged when at least this share of its wording is found in a source. Lower catches more paraphrase; higher flags only near-copies."
              >
                <Slider label="Duplication sensitivity" value={s.duplicate_sensitivity} min={30} max={90} step={5} unit="%" onChange={(v) => onChange({ duplicate_sensitivity: v })} />
              </Setting>
              <Setting title="Re-check automatically">
                <Toggle label="Check the draft for duplication again after your edits settle (sooner while Check is open)" checked={s.auto_recheck} onChange={(v) => onChange({ auto_recheck: v })} />
              </Setting>
              <Setting title="Automatic snapshots" hint="While you write, a snapshot of the draft is kept at most this often (and before a large edit).">
                <Slider label="Minutes between snapshots" value={s.snapshot_minutes} min={2} max={60} unit=" min" onChange={(v) => onChange({ snapshot_minutes: v })} />
              </Setting>
              <Setting title="Snapshots to keep" hint="The oldest automatic snapshots are dropped past this many. Versions you save and name are always kept.">
                <Slider label="Snapshots to keep" value={s.snapshots_kept} min={10} max={200} step={10} onChange={(v) => onChange({ snapshots_kept: v })} />
              </Setting>
            </>
          )}

          {section === 'library' && (
            <>
              <Setting title="New folders start at" hint="How closely a paper must match a new subject folder to be filed in it. You can change each folder's threshold later.">
                <Slider label="New folders start at" value={s.folder_similarity} min={0} max={100} step={5} unit="%" onChange={(v) => onChange({ folder_similarity: v })} />
              </Setting>
              <Setting
                title="Contact email (optional)"
                hint="Sent to OpenAlex, Semantic Scholar and Crossref when finding free copies of cited papers, so they can write to you instead of slowing down heavy use."
              >
                <EmailField value={s.contact_email} onChange={(v) => onChange({ contact_email: v })} />
              </Setting>
              <Setting
                title="Look papers up in scholarly indexes"
                hint="After an import, each paper's DOI or title is sent to OpenAlex and Crossref for the publisher's details (journal, volume, issue, pages), the authors' abstract, its reference list and how often it is cited. Nothing else about your files is sent. What you correct yourself is never changed."
              >
                <Toggle label="Look new papers up after they're added" checked={s.index_lookup} onChange={(v) => onChange({ index_lookup: v })} />
              </Setting>
              <CoreKeySetting />
            </>
          )}

          {section === 'search' && <SearchSection />}

          {section === 'model' && <ModelSection onModelChanged={onModelChanged} />}
        </div>
        <footer className="settings-saved" role="status">
          <span aria-hidden="true">✓</span>
          <span>
            <b>Settings save as you change them</b> — except AI model, which saves with “Save and switch”.
          </span>
        </footer>
      </div>
    </div>
  )
}
