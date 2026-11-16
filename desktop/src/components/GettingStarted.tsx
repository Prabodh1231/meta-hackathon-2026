import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icon'
import { Ribbons } from './Ribbons'

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

/** One step of getting started. `scene` picks the small drawing of the screen it happens on. */
export interface Step {
  done: boolean
  title: string
  text: string
  actions: ReactNode
  scene: 'connect' | 'sources' | 'draft' | 'cite'
}

/** Connecting the AI, then the three steps of using the app, with the button for each. The banner above
 * an empty draft and the Home page both show these, so they tick off together. */
export function gettingStartedSteps({ mock, sources, words, citations, onConnectModel, onAddSources, onTrySamples, onAsk, onOpenWord }: Omit<Props, 'onHide'>): Step[] {
  return [
    {
      done: !mock,
      scene: 'connect',
      title: mock ? 'Connect the AI' : 'AI connected',
      text: mock
        ? 'The AI is offline: a stand-in that matches words instead of reading them. Add a Muse key to have your sources really read and checked.'
        : 'Muse reads your sources and checks every citation.',
      actions: mock ? <button className="primary" onClick={onConnectModel}>Add a Muse key</button> : null,
    },
    {
      done: sources > 0,
      scene: 'sources',
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
      scene: 'draft',
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
      scene: 'cite',
      title: 'Back up each claim',
      text: 'Press Cite (Ctrl+Shift+C) in a sentence and keep writing: a cite marker turns green when a source supports it. Click the marker to confirm the source, and a citation to see its quote on the page.',
      actions: null,
    },
  ]
}

/** A small drawing of the screen a step happens on, in a window frame floating on the app's artwork.
 * Drawn, not a screenshot, so it follows the theme and never goes out of date. */
export function StepPreview({ scene, done }: { scene: Step['scene']; done?: boolean }) {
  return (
    <div className="framed" aria-hidden="true">
      <Ribbons shape="wide" className="framed-art" />
      <div className="frame">
        <div className="frame-bar">
          <i />
          <i />
          <i />
          <span />
        </div>
        <div className="frame-body">
          <i />
          <div className={`scene scene-${scene}`}>
            {scene === 'connect' && (
              <>
                <b>AI model</b>
                <span className="scene-field">{done ? '••••••••••••' : 'Your Muse key'}</span>
                <span className={done ? 'scene-live' : 'scene-live off'}>{done ? 'Muse connected' : 'Offline stand-in'}</span>
              </>
            )}
            {scene === 'sources' && (
              <>
                <b>Library</b>
                <span className="scene-row"><u /></span>
                <span className="scene-row"><u className="s" /></span>
                <span className="scene-row"><u /></span>
              </>
            )}
            {scene === 'draft' && (
              <>
                <b>Your draft</b>
                <u />
                <u />
                <span className="scene-muse"><u /><u className="s" /></span>
              </>
            )}
            {scene === 'cite' && (
              <>
                <b>Your draft</b>
                <u />
                <span><u className="s" /> <span className="cite cite-verified legend-chip">Supported</span></span>
                <span><u className="s" /> <span className="cite cite-weak legend-chip">Partly supported</span></span>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** A small outlined icon, a bold phrase, and the sentence it runs into. */
export function Blurb({ icon, lead, inline, children }: { icon: IconName; lead: string; inline?: boolean; children: ReactNode }) {
  return (
    <p className={`blurb${inline ? ' inline' : ''}`}>
      <span className="blurb-icon" aria-hidden="true">
        <Icon name={icon} size={16} />
      </span>
      <span>
        <b>{lead}</b> {children}
      </span>
    </p>
  )
}

/** Shown above an empty draft or with an empty library: what the app is for in three lines, then
 * connecting the AI and the three steps of using it. Steps tick themselves off as they're done. */
export function GettingStarted(props: Props) {
  const steps = gettingStartedSteps(props)
  return (
    <section className="getting-started" aria-label="Getting started">
      <header>
        <div>
          <h2>Getting started</h2>
          <p className="muted">Write only what your sources say: from your sources to a cited draft.</p>
        </div>
        <button className="link" onClick={props.onHide}>Hide</button>
      </header>
      <div className="blurbs">
        <Blurb icon="write" lead="Cite as you write.">Muse finds the passage while you keep typing.</Blurb>
        <Blurb icon="check" lead="See the proof.">Every citation opens the exact quote on its page.</Blurb>
        <Blurb icon="lock" lead="Stays on your computer.">Your papers and drafts are kept in a folder here.</Blurb>
      </div>
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
