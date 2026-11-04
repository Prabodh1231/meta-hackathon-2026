import type { JSONContent } from '@tiptap/core'

/** The demo: the sample library, a short draft written from it, and the checklist shown above that
 * draft. What the checklist has ticked off is kept in this browser, like the other UI preferences. */

export const DEMO_TITLE = 'Sleep, memory and reefs (demo)'

/** The checklist, in order. Each step ticks itself off when the writer does it in the demo draft. */
export type DemoStep = 'confirm' | 'quote' | 'assistant' | 'review' | 'export'
export const DEMO_STEPS: { step: DemoStep; title: string; text: string }[] = [
  {
    step: 'confirm',
    title: 'Confirm a source',
    text: 'Click a green cite marker, then Use this source in Check. The marker becomes a citation.',
  },
  {
    step: 'quote',
    title: 'See the quote on its page',
    text: 'Click the citation in the draft: its page opens beside the draft with the quote highlighted.',
  },
  {
    step: 'assistant',
    title: 'Draft with Muse',
    text: 'In Compose, with Cite my sources on, ask Muse for a paragraph (say, on coral bleaching) and insert it. Every sentence cites a quote.',
  },
  {
    step: 'review',
    title: 'Check for duplication',
    text: 'Open Check: it underlines sentences that copy a source, and says which ones are cited.',
  },
  {
    step: 'export',
    title: 'Export to Word',
    text: 'Export saves a Word file with in-text citations and a reference list.',
  },
]

export interface DemoState {
  draftId: number
  done: DemoStep[]
  hidden: boolean // the checklist was hidden; opening the demo draft from Ctrl K shows it again
}

const KEY = 'rc.demo'

export function loadDemo(): DemoState | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    return v && Number.isInteger(v.draftId) ? { draftId: v.draftId, done: v.done ?? [], hidden: !!v.hidden } : null
  } catch {
    return null
  }
}

export function saveDemo(d: DemoState | null) {
  try {
    if (d) localStorage.setItem(KEY, JSON.stringify(d))
    else localStorage.removeItem(KEY)
  } catch {
    /* storage unavailable */
  }
}

/** Whether `source` is a file in the samples folder (Windows paths compare without case). */
export function inSamples(source: string, samplesDir: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return !!samplesDir && norm(source).startsWith(norm(samplesDir) + '/')
}

// The draft: sentences from the sample papers, each with a cite marker still searching, so they're
// searched and checked as soon as the draft opens. The third is false on purpose: Chen 2021 found
// that reactivation during REM sleep did nothing, so the check should mark it unsupported.
const CLAIMS = {
  tmr: 'Replaying learning-associated sounds during slow-wave sleep improved recall of word pairs by 18% relative to a control night.',
  spindles: 'Sleep spindle density in the seconds after each cue predicted whether the cued item was remembered the next morning.',
  rem: 'Reactivation delivered during REM sleep improved recall just as much.',
  reefs: 'Reefs that had experienced moderate heat stress in 2016 showed 31% lower bleaching mortality in 2017.',
}

/** A fresh copy of the demo draft. Marker ids are new each time, so a reset searches again. */
export function demoDoc(): JSONContent {
  const stamp = Date.now().toString(36)
  const mark = (key: keyof typeof CLAIMS): JSONContent[] => [
    { type: 'text', text: `${CLAIMS[key]} ` },
    { type: 'citeMark', attrs: { cid: `demo-${key}-${stamp}`, claim: CLAIMS[key], state: 'searching', results: [] } },
    { type: 'text', text: ' ' },
  ]
  const p = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content })
  const h = (level: number, text: string): JSONContent => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] })
  return {
    type: 'doc',
    content: [
      h(1, DEMO_TITLE),
      h(2, 'Sleep and memory'),
      p(...mark('tmr'), ...mark('spindles'), ...mark('rem')),
      h(2, 'Coral reefs'),
      p(
        ...mark('reefs'),
        { type: 'text', text: 'Whether that buffer holds as heatwaves become more frequent is the open question for this chapter.' },
      ),
    ],
  }
}
