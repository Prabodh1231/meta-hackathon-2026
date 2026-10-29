interface Props {
  sources: number
  words: number
  citations: number
  onAddSources: () => void
  onAsk: () => void
  onOpenWord: () => void
  onHide: () => void
}

/** Shown above an empty draft or with an empty library: the three steps of using the app, with
 * the button for each. Steps tick themselves off as they're done. */
export function GettingStarted({ sources, words, citations, onAddSources, onAsk, onOpenWord, onHide }: Props) {
  const steps = [
    {
      done: sources > 0,
      title: 'Add your sources',
      text: sources > 0
        ? `${sources} source${sources === 1 ? '' : 's'} in your library.`
        : 'Papers, notes, slides, scans or web pages. They stay on this computer.',
      actions: <button className={sources ? '' : 'primary'} onClick={onAddSources}>{sources ? 'Open library' : 'Add sources'}</button>,
    },
    {
      done: words > 0,
      title: 'Start your draft',
      text: 'Type on the page, let the Assistant draft from your sources with cited quotes, or bring in a Word file you already have (or drop it on the window).',
      actions: (
        <>
          <button className={sources && !words ? 'primary' : ''} onClick={onAsk}>Ask the Assistant</button>
          <button onClick={onOpenWord}>Import a Word file</button>
        </>
      ),
    },
    {
      done: citations > 0,
      title: 'Back up each claim',
      text: 'Put the cursor in a sentence and press Cite (Ctrl+Shift+C) to find the passage that supports it. Click a citation to see the quote on its page.',
      actions: null,
    },
  ]
  return (
    <section className="getting-started" aria-label="Getting started">
      <header>
        <div>
          <h2>Getting started</h2>
          <p className="muted">Three steps from your sources to a cited draft.</p>
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
