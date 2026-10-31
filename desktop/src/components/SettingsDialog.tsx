import { useEffect, useRef, useState } from 'react'
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

type Section = 'appearance' | 'writing' | 'review' | 'library' | 'search' | 'model'
const SECTIONS: { id: Section; label: string }[] = [
  { id: 'appearance', label: 'Appearance & editor' },
  { id: 'writing', label: 'Writing & citations' },
  { id: 'review', label: 'Review & history' },
  { id: 'library', label: 'Library' },
  { id: 'search', label: 'Search & embeddings' },
  { id: 'model', label: 'AI model' },
]

interface Props {
  settings: Settings
  onChange: (changes: Partial<Settings>) => void
  /** The model, or where search runs, was switched: the status bar shows the new one. */
  onModelChanged: () => void
  onClose: () => void
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

/** "BGE-M3 on this computer's GPU": a model id and where it runs, in words. */
function placeText(id: string | null, on: string | null): string {
  if (!id) return 'off'
  const name = id.includes('rerank') ? 'Baseten reranker' : id.split(':').slice(1).join(':').split('/').pop() || id
  const where = on === 'baseten' ? 'on Baseten' : on === 'cuda' ? "on this computer's GPU" : 'on this computer'
  return `${name} ${where}`
}

/** Where embeddings and reranking run: this computer, or Baseten for machines without a GPU. */
function SearchSection({ onChanged }: { onChanged: () => void }) {
  const [now, setNow] = useState<SearchSettings | null>(null)
  const [where, setWhere] = useState<SearchSettings['where']>('auto')
  const [key, setKey] = useState('')
  const [embedModel, setEmbedModel] = useState('')
  const [rerankModel, setRerankModel] = useState('')
  const [state, setState] = useState<{ busy?: boolean; error?: string; done?: string }>({})

  const load = (s: SearchSettings) => {
    setNow(s)
    setWhere(s.where)
    setEmbedModel(s.embed_model)
    setRerankModel(s.rerank_model)
  }
  useEffect(() => {
    api
      .searchSettings()
      .then(load)
      .catch((e) => setState({ error: e instanceof Error ? e.message : String(e) }))
  }, [])

  if (!now) return <p className="muted">{state.error ?? 'Loading…'}</p>

  const changed =
    where !== now.where || key.trim() !== '' || embedModel.trim() !== now.embed_model || rerankModel.trim() !== now.rerank_model
  async function save() {
    setState({ busy: true })
    try {
      const s = await api.updateSearch({
        where,
        embed_model: embedModel.trim(),
        rerank_model: rerankModel.trim(),
        ...(key.trim() ? { api_key: key.trim() } : {}),
      })
      load(s)
      setKey('')
      setState({
        done: s.restart_needed
          ? 'Saved. Restart the app to switch embeddings; your library is re-embedded once, then.'
          : `Now: embeddings ${placeText(s.embedder, s.embedder_on)}; reranking ${placeText(s.reranker, s.reranker_on)}.`,
      })
      onChanged()
    } catch (e) {
      setState({ error: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <>
      <Setting title="Now" hint="Embeddings find the passages that match a question or a sentence you cite; the reranker puts the best first.">
        <p className="setting-now">
          Embeddings: <b>{placeText(now.embedder, now.embedder_on)}</b>
          <br />
          Reranking: <b>{placeText(now.reranker, now.reranker_on)}</b>
        </p>
      </Setting>
      <Setting title="Where search runs">
        <Choice
          label="Where search runs"
          value={where}
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'local', label: 'This computer' },
            { value: 'baseten', label: 'Baseten' },
          ]}
          onChange={setWhere}
        />
        <p className="muted">
          {where === 'auto'
            ? `This computer's NVIDIA GPU when it has one; Baseten when it doesn't (and it's set up below); otherwise a smaller model on the CPU.${now.gpu ? ' This computer has a GPU, so search stays here.' : ''}`
            : where === 'local'
              ? 'Never uses Baseten. Without an NVIDIA GPU this means the smaller CPU model, which finds sources less well.'
              : 'Always on Baseten, using the models below. Reranking stays here if no reranker is deployed there.'}
        </p>
      </Setting>
      <Setting
        title="Baseten API key"
        hint={now.has_key ? `A key is saved${now.key_hint ? ` (ending in ${now.key_hint})` : ''}. Paste a new one to replace it.` : 'Paste the API key from your Baseten account.'}
      >
        <input
          className="setting-input"
          type="password"
          value={key}
          autoComplete="off"
          spellCheck={false}
          placeholder={now.has_key ? '•••• •••• •••• ' + now.key_hint : 'Paste your key'}
          aria-label="Baseten API key"
          onChange={(e) => setKey(e.target.value)}
        />
      </Setting>
      <Setting title="Embedding model on Baseten" hint="BAAI/bge-m3 deployed with Baseten's embeddings engine (BEI): paste its model ID or address. It's the model this computer's GPU runs, so moving between the two doesn't re-embed your library.">
        <input className="setting-input" value={embedModel} spellCheck={false} placeholder="e.g. abcd1234" aria-label="Baseten embedding model" onChange={(e) => setEmbedModel(e.target.value)} />
      </Setting>
      <Setting title="Reranker on Baseten (optional)" hint="A reranker deployed with BEI, such as BAAI/bge-reranker-v2-m3: its model ID or address.">
        <input className="setting-input" value={rerankModel} spellCheck={false} placeholder="e.g. efgh5678" aria-label="Baseten reranker model" onChange={(e) => setRerankModel(e.target.value)} />
      </Setting>
      <p className="setting-warn">
        On Baseten, the text of your passages, questions and cited sentences is sent there to be embedded and ranked. Your
        files and drafts stay on this computer.
      </p>
      <div className="setting-actions">
        <button className="primary" disabled={!changed || state.busy} onClick={save}>
          {state.busy ? 'Checking Baseten…' : 'Save and check'}
        </button>
        {state.done && !changed && <span className="setting-ok">{state.done}</span>}
        {state.error && <span className="error-text">{state.error}</span>}
      </div>
    </>
  )
}

/** Muse or the offline mock, the API key, and how hard Muse thinks. */
function ModelSection({ onModelChanged }: { onModelChanged: () => void }) {
  const [model, setModel] = useState<ModelSettings | null>(null)
  const [provider, setProvider] = useState<'muse' | 'mock'>('mock')
  const [effort, setEffort] = useState('low')
  const [route, setRoute] = useState<ModelSettings['route']>('meta')
  const [key, setKey] = useState('')
  const [state, setState] = useState<{ busy?: boolean; error?: string; saved?: boolean }>({})

  useEffect(() => {
    api
      .modelSettings()
      .then((m) => {
        setModel(m)
        setProvider(m.provider)
        setEffort(m.reasoning_effort)
        setRoute(m.route)
      })
      .catch((e) => setState({ error: e instanceof Error ? e.message : String(e) }))
  }, [])

  if (!model) return <p className="muted">{state.error ?? 'Loading…'}</p>

  const changed = provider !== model.provider || effort !== model.reasoning_effort || route !== model.route || key.trim() !== ''
  async function save() {
    setState({ busy: true })
    try {
      const m = await api.updateModel({
        provider,
        reasoning_effort: effort,
        route,
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
      {provider === 'muse' && (
        <Setting title="Where Muse runs" hint="Muse Spark is served by Meta's Model API and by Baseten. Baseten measured about twice as fast.">
          <Choice
            label="Where Muse runs"
            value={route}
            options={[
              { value: 'baseten-first', label: 'Baseten, then Meta' },
              { value: 'meta', label: "Meta's API" },
              { value: 'baseten', label: 'Baseten only' },
            ]}
            onChange={setRoute}
          />
          <p className="muted">
            {route === 'baseten-first'
              ? `Each request goes to ${model.baseten_model} on Baseten first, and to Meta's API if Baseten fails or is busy. A failing service is passed over for a minute.`
              : route === 'meta'
                ? `Only Meta's API (${model.model}).`
                : `Only ${model.baseten_model} on Baseten: if it's down, Muse is unavailable until it's back.`}
            {route !== 'meta' && !model.has_baseten_key && ' Add your Baseten API key in Search & embeddings first.'}
          </p>
        </Setting>
      )}
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
            Now using {model.provider === 'muse' ? `Muse via ${model.routes.map((r) => (r === 'baseten' ? 'Baseten' : "Meta's API")).join(', then ')}` : 'the offline mock'}.
          </span>
        )}
        {state.error && <span className="error-text">{state.error}</span>}
      </div>
    </>
  )
}

export function SettingsDialog({ settings: s, onChange, onModelChanged, onClose }: Props) {
  const [section, setSection] = useState<Section>('appearance')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <nav className="settings-nav" aria-label="Settings sections">
          <h2 id="settings-title">Settings</h2>
          {SECTIONS.map((x) => (
            <button key={x.id} className={section === x.id ? 'on' : ''} aria-current={section === x.id} onClick={() => setSection(x.id)}>
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
              <Setting title="Citation style" hint="Used for Word export and the References tab.">
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
                title="Passages the Assistant reads"
                hint="How many of the best-matching passages the Assistant drafts from. Fewer is faster and sticks to the closest matches; more covers more ground."
              >
                <Slider label="Passages the Assistant reads" value={s.assistant_passages} min={3} max={20} onChange={(v) => onChange({ assistant_passages: v })} />
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
                    ? 'The sources ticked in the Library, or all of them when none are ticked, as the Assistant does.'
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
                <Toggle label="Check the draft again a few seconds after you edit, while Review is open" checked={s.auto_recheck} onChange={(v) => onChange({ auto_recheck: v })} />
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

          {section === 'search' && <SearchSection onChanged={onModelChanged} />}

          {section === 'model' && <ModelSection onModelChanged={onModelChanged} />}
        </div>
      </div>
    </div>
  )
}
