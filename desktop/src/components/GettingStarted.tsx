interface Props {
  mock: boolean // running on the offline mock, not Muse
  sources: number
  words: number
  citations: number
  onConnectModel: () => void
  onAddSources: () => void
  onTrySamples?: () => void // the desktop app only: it copies the sample files
  onAsk: () => void
  onOpenWord: () => void
  onHide: () => void
}

/** Shown above an empty draft or with an empty library: connecting the AI, then the three steps of
 * using the app, with the button for each. Steps tick themselves off as they're done. */
export function GettingStarted({ mock, sources, words, citations, onConnectModel, onAddSources, onTrySamples, onAsk, onOpenWord, onHide }: Props) {
  const steps = [
    {
      done: !mock,
      title: mock ? 'Connect the AI' : 'AI connected',
      text: mock
        ? 'The AI is offline: a stand-in that matches words instead of reading them. Add a Muse key to have your sources really read and checked.'
        : 'Muse reads your sources and checks every citation.',
      actions: mock ? <button className="primary" onClick={onConnectModel}>Add a Muse key</button> : null,
    },
    {
      done: sources > 0,
      title: 'Add your sources',
      text: sources > 0
        ? `${sources} source${sources === 1 ? '' : 's'} in your library.`
        : 'Papers, notes, slides, scans or web pages. They stay on this computer.',
      actions: (
        <>
          <button className={sources || mock ? '' : 'primary'} onClick={onAddSources}>{sources ? 'Open library' : 'Add sources'}</button>
          {onTrySamples && <button onClick={onTrySamples} title="Six sample files on sleep and coral reefs, and a draft that shows what the app does">Try the sample library</button>}
        </>
      ),
    },
    {
      done: words > 0,
      title: 'Start your draft',
      text: 'Type on the page, let Muse draft from your sources with cited quotes (Compose), or bring in a Word file you already have (or drop it on the window).',
      actions: (
        <>
          <button className={sources && !words ? 'primary' : ''} onClick={onAsk}>Draft with Muse</button>
          <button onClick={onOpenWord}>Import a Word file</button>
        </>
      ),
    },
    {
      done: citations > 0,
      title: 'Back up each claim',
      text: 'Press Cite (Ctrl+Shift+C) in a sentence and keep writing: a cite marker turns green when a source supports it. Click the marker to confirm the source, and a citation to see its quote on the page.',
      actions: null,
    },
  ]
  return (
    <section className="getting-started" aria-label="Getting started">
      <header>
        <div>
          <h2>Getting started</h2>
          <p className="muted">Write only what your sources say: from your sources to a cited draft.</p>
        </div>
        <button className="link" onClick={onHide}>Hide</button>
      </header>
      <ol>
        {steps.map((s, i) => (
          <li key={s.title} className={s.done ? 'done' : ''}>
            <span className="gs-num" aria-hidden="true">{s.done ? '✓' : i + 1}</span>
            <div>
              <b>{s.title}</b>
              {s.done && <span className="sr-only"> (done)</span>}
              <p>{s.text}</p>
              {s.actions && <div className="gs-actions">{s.actions}</div>}
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}
