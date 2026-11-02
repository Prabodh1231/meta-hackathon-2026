import { DEMO_STEPS, type DemoStep } from '../demo'

interface Props {
  done: DemoStep[]
  mock: boolean // on the offline mock, the check matches words, so the false claim may pass
  busy: string | null
  onConnectModel: () => void
  onReset: () => void
  onRemove: () => void
  onHide: () => void
}

/** Shown above the demo draft: the steps that show what the app does, ticking off as they're done.
 * The next step's button or marker pulses (styles.css, from the app's data-demo-next). */
export function DemoGuide({ done, mock, busy, onConnectModel, onReset, onRemove, onHide }: Props) {
  const next = DEMO_STEPS.find((s) => !done.includes(s.step))?.step
  return (
    <section className="getting-started demo-guide" aria-label="Demo">
      <header>
        <div>
          <h2>Demo: from sources to a checked draft</h2>
          <p className="muted">
            {next
              ? 'Each cite marker below is checking its sentence against the sample library. One sentence is false on purpose.'
              : 'That’s the whole path. Reset the demo to run it again, or remove the samples and add your own papers.'}
          </p>
          {mock && (
            <p className="demo-mock">
              The AI is offline, so the check only matches words and may pass the false sentence.{' '}
              <button className="link" onClick={onConnectModel}>Add a Muse key</button> to see it caught.
            </p>
          )}
        </div>
        <button className="link" onClick={onHide}>Hide</button>
      </header>
      <ol>
        {DEMO_STEPS.map((s, i) => {
          const isDone = done.includes(s.step)
          return (
            <li key={s.step} className={isDone ? 'done' : s.step === next ? 'next' : ''}>
              <span className="gs-num" aria-hidden="true">{isDone ? '✓' : i + 1}</span>
              <div>
                <b>{s.title}</b>
                {isDone && <span className="sr-only"> (done)</span>}
                <p>{s.text}</p>
              </div>
            </li>
          )
        })}
      </ol>
      <footer className="gs-actions">
        <button onClick={onReset} disabled={!!busy} title="Put the demo draft back as it was and clear the checklist">
          Reset demo
        </button>
        <button onClick={onRemove} disabled={!!busy} title="Take the sample files and this draft out, to start your own library">
          Remove samples
        </button>
        {busy && <span className="muted">{busy}</span>}
      </footer>
    </section>
  )
}
