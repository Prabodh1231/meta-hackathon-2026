/* Shared mock data and pieces for the Write-mode concepts (06–08): the same draft, the same
   citations and one vocabulary, so the concepts differ only in how they present them. */
(function () {
  // One word per state, used by chips, lists, legends and the status bar alike.
  const WORD = {
    ok: 'Supported',
    part: 'Partly supported',
    no: 'Not supported',
    nosrc: 'No source found',
    finding: 'Finding a source…',
  }
  const NEEDS = (s) => s === 'part' || s === 'no' || s === 'nosrc'

  const C = {
    c1: { s: 'ok', src: 'Chen & Martinez 2021', p: 342, claim: 'Sleep spindles appear to gate the reactivation of hippocampal memory traces during slow-wave sleep.', quote: 'Spindle bursts preceded 78% of hippocampal reactivation events, suggesting that spindles open a window for replay.', why: 'The quote is on the page and says what the sentence says.' },
    c2: { s: 'ok', src: 'Chen & Martinez 2021', p: 341, claim: 'Playing a sound linked to a memory during this stage strengthens it.', quote: 'Auditory cues presented during slow-wave sleep improved next-day recall of the cued items by 11%.', why: 'The quote is on the page and says what the sentence says.' },
    c3: { s: 'part', src: 'Chen & Martinez 2021', p: 342, claim: 'If spindles gate reactivation, targeted memory reactivation may be less effective with age.', quote: 'Spindle bursts preceded 78% of hippocampal reactivation events, suggesting that spindles open a window for replay.', why: 'The page backs the first half (spindles gate reactivation) but says nothing about age.' },
    c4: { s: 'no', src: 'Chen & Martinez 2021', p: 343, claim: 'Chen and Martinez report that cueing works only in slow-wave sleep and fails in REM sleep.', quote: 'Cues were presented only during slow-wave sleep; REM sleep was not examined.', why: 'The study never tested REM sleep, so it cannot show that cueing fails there.' },
    c5: { s: 'finding', src: '', p: 0, claim: 'Spindle density falls steadily from middle age onward.', quote: '', why: 'Searching your 157 sources. Keep writing.' },
    c9: { s: 'nosrc', src: '', p: 0, claim: 'Older adults benefit as much from daytime naps as from overnight sleep.', quote: '', why: 'Nothing in your library says this. Add a source, reword the sentence, or remove the citation.' },
    c6: { s: 'ok', src: 'Ruiz et al. 2017', p: 4, claim: 'The strongest evidence links spindle–ripple coupling to overnight gains in recall of word pairs and facts.', quote: 'Coupling strength predicted overnight retention of word pairs (r = .52) but not of the motor sequence.', why: 'The quote is on the page and says what the sentence says.' },
    c7: { s: 'ok', src: 'Park & Osei 2023', p: 27, claim: 'Effects on motor skills are smaller and less consistent.', quote: 'Pooled effects for procedural tasks were small (g = 0.18) and varied widely between labs.', why: 'The quote is on the page and says what the sentence says.' },
    c8: { s: 'ok', src: 'Lindqvist 2019', p: 2, claim: 'Spindles are thought to provide a temporal window for dialogue between the hippocampus and the neocortex.', quote: 'Spindles are thought to provide a temporal window for dialogue between the hippocampus and neocortex.', why: 'Supported, but the sentence is almost word for word the source (see Duplication).' },
  }
  const ORDER = ['c1', 'c2', 'c3', 'c4', 'c5', 'c9', 'c6', 'c7', 'c8']
  ORDER.forEach((k, i) => (C[k].n = i + 1))

  const counts = () => {
    const n = { ok: 0, part: 0, no: 0, nosrc: 0, finding: 0 }
    ORDER.forEach((k) => n[C[k].s]++)
    n.needs = n.part + n.no + n.nosrc
    n.total = ORDER.length
    return n
  }

  const chip = (k) => {
    const c = C[k]
    const lbl = c.src ? `${c.src}, p. ${c.p}` : ''
    const w = c.s === 'ok' ? '' : `<span class="w">${c.src ? ' · ' : ''}${WORD[c.s].toLowerCase()}</span>`
    return `<button class="cite" data-k="${k}" data-s="${c.s}" data-n="${c.n}" aria-label="Citation ${c.n}: ${lbl || 'no source yet'}. ${WORD[c.s]}"><span class="lbl">${lbl}</span>${w}</button>`
  }
  const legendChip = (s) => `<span class="cite" data-s="${s}">${WORD[s]}</span>`
  const legend = () => `<div class="legend" aria-label="What the citation marks mean">${['ok', 'part', 'no', 'nosrc', 'finding'].map(legendChip).join('')}</div>`

  const draft = ({ heading = true, dupMarks = false, cursorPara = 1 } = {}) => `
    ${heading ? '<h2>2. Sleep spindles and memory</h2>' : ''}
    <p data-para="1">Sleep spindles appear to gate the reactivation of hippocampal memory traces during slow-wave sleep.${chip('c1')} Playing a sound linked to a memory during this stage, known as targeted memory reactivation, strengthens it.${chip('c2')} If spindles gate reactivation, targeted memory reactivation may be less effective with age.${chip('c3')}${cursorPara === 1 ? '<span class="caret"></span>' : ''}</p>
    <p data-para="2">Chen and Martinez report that cueing works only in slow-wave sleep and fails in REM sleep.${chip('c4')} Spindle density falls steadily from middle age onward${chip('c5')}, and older adults benefit as much from daytime naps as from overnight sleep.${chip('c9')}</p>
    <p data-para="3" class="muse">Across your sources, the strongest evidence links spindle–ripple coupling to overnight gains in recall of word pairs and facts,${chip('c6')} while effects on motor skills are smaller and less consistent.${chip('c7')}</p>
    <p data-para="4"><span class="${dupMarks ? 'near' : ''}" data-dup="d2">Spindles are thought to provide a temporal window for dialogue between the hippocampus and the neocortex.</span>${chip('c8')} <span class="${dupMarks ? 'dup' : ''}" data-dup="d1">Playing a sound linked to a memory during this stage strengthens it.</span> Whether the same holds for naps is less clear.</p>`

  const header = ({ center = '', extra = '' } = {}) => `
    <header class="bar">
      <div class="logo">rc</div>
      <div class="docid">
        <div class="name" title="Double-click to rename">Spindles and memory, chapter 2 <span class="pen">✎</span></div>
        <div class="sub">Saved · ${extra || 'v8'}</div>
      </div>
      <button class="drafts-btn" title="Switch draft, new draft, import a Word file">Drafts · 7 ▾</button>
      ${center || '<div class="search">⌕ <span style="flex:1">Search sources, drafts and actions</span><kbd>Ctrl K</kbd></div>'}
      <div class="right">
        <button class="ghost">⤓ Export</button>
        <button class="ghost sq" title="Focus mode">⛶</button>
        <button class="ghost sq" title="Settings">⚙</button>
      </div>
    </header>`

  const rail = () => `
    <nav class="rail" aria-label="Modes">
      <button class="on"><span class="ico">✎</span>Write</button>
      <button><span class="ico">▥</span>Library</button>
      <button><span class="ico">⋔</span>Network</button>
      <button><span class="ico">▦</span>Matrix</button>
    </nav>`

  const toolbar = (aiButtons) => `
    <div class="toolbar" role="toolbar" aria-label="Text formatting">
      <button class="style">Normal text <span>▾</span></button><span class="sep"></span>
      <button><b>B</b></button><button><i>I</i></button><button><u>U</u></button><span class="sep"></span>
      <button>≔</button><button>⒈</button><button>❝</button><span class="sep"></span>
      <button>↶</button><button>↷</button><span class="sep"></span><button>Aa</button>
      ${aiButtons}
    </div>`

  // Citation popover: the same card in every concept.
  function bindChips(root = document) {
    let pop = document.getElementById('citepop')
    if (!pop) {
      pop = document.createElement('div')
      pop.id = 'citepop'; pop.className = 'citepop'; pop.hidden = true
      pop.setAttribute('role', 'dialog')
      document.body.appendChild(pop)
      document.addEventListener('click', (e) => { if (!e.target.closest('.cite, .citepop')) pop.hidden = true })
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') pop.hidden = true })
    }
    root.addEventListener('click', (e) => {
      const b = e.target.closest('.cite[data-k]')
      if (!b) return
      const c = C[b.dataset.k]
      const acts = NEEDS(c.s)
        ? `<button class="btn go">Find another source</button><button class="btn">Reword with Muse</button><button class="btn warn">Remove citation</button>`
        : c.s === 'finding' ? `<button class="btn">Pick a source myself</button><button class="btn warn">Remove</button>`
        : `<button class="btn go">Open page ${c.p}</button><button class="btn">Check again</button>`
      pop.innerHTML = `
        <div class="h"><span class="cite" data-s="${c.s}">${WORD[c.s]}</span><b>${c.src ? c.src + ', p. ' + c.p : 'No source yet'}</b><button class="x" aria-label="Close">×</button></div>
        <div class="muted small" style="margin-top:8px">Your sentence</div>
        <div style="font:14px/1.5 var(--doc-font)">${c.claim}</div>
        ${c.quote ? `<div class="muted small" style="margin-top:8px">What page ${c.p} says</div><blockquote>${c.quote}</blockquote>` : ''}
        <div class="why">${c.why}</div>
        <div class="acts">${acts}</div>`
      const r = b.getBoundingClientRect()
      pop.hidden = false
      const top = r.bottom + 8 + pop.offsetHeight > innerHeight ? r.top - pop.offsetHeight - 8 : r.bottom + 8
      pop.style.top = Math.max(8, top) + 'px'
      pop.style.left = Math.min(innerWidth - 396, Math.max(8, r.left - 40)) + 'px'
      pop.querySelector('.x').onclick = () => (pop.hidden = true)
      e.stopPropagation()
    })
  }

  // Banner "flow" buttons: each runs a function that sets the mock into that state.
  function flows(map) {
    const bar = document.querySelector('.concept .steps')
    Object.keys(map).forEach((name, i) => {
      const b = document.createElement('button')
      b.textContent = name
      b.onclick = () => { bar.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', 'false')); b.setAttribute('aria-pressed', 'true'); map[name]() }
      bar.appendChild(b)
      if (i === 0) setTimeout(() => b.click())
    })
  }

  window.RC = { C, ORDER, WORD, NEEDS, counts, chip, legend, draft, header, rail, toolbar, bindChips, flows }
})()
