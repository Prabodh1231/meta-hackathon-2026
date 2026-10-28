/* Shared mock data + the docs-style writing surface used by all five prototypes.
   Each prototype skins it through CSS tokens; the layout shell is its own. */
(function () {
  const docs = [
    { id: 1, kind: 'pdf', title: 'Attention Is All You Need', authors: 'Vaswani et al.', year: 2017, venue: 'NeurIPS', pages: 15, topic: 1, short: 'Vaswani 2017' },
    { id: 2, kind: 'pdf', title: 'BERT: Pre-training of Deep Bidirectional Transformers', authors: 'Devlin et al.', year: 2019, venue: 'NAACL', pages: 16, topic: 1, short: 'Devlin 2019' },
    { id: 3, kind: 'pdf', title: 'Retrieval-Augmented Generation for Knowledge-Intensive NLP', authors: 'Lewis et al.', year: 2020, venue: 'NeurIPS', pages: 19, topic: 2, short: 'Lewis 2020' },
    { id: 4, kind: 'pdf', title: 'Lost in the Middle: How Language Models Use Long Contexts', authors: 'Liu et al.', year: 2023, venue: 'TACL', pages: 17, topic: 2, short: 'Liu 2023' },
    { id: 5, kind: 'text', title: 'reading-notes-week3.md', authors: 'You', year: 2026, venue: 'Notes', pages: 2, topic: 2, short: 'Notes wk3' },
    { id: 6, kind: 'web', title: 'The Illustrated Transformer', authors: 'J. Alammar', year: 2018, venue: 'jalammar.github.io', pages: 1, topic: 1, short: 'Alammar 2018' },
    { id: 7, kind: 'image', title: 'whiteboard-retrieval-loop.jpg', authors: 'You', year: 2026, venue: 'Scan, OCR', pages: 1, topic: 2, short: 'Whiteboard' },
  ];
  const topics = [
    { id: 1, label: 'Transformer architectures', tags: ['attention', 'encoder', 'translation'] },
    { id: 2, label: 'Retrieval & long context', tags: ['RAG', 'position bias', 'evaluation'] },
  ];
  const cites = {
    c1: { doc: 1, page: 1, label: '1', status: 'verified', quote: 'We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely.', reason: 'Quote found verbatim and supports the claim.' },
    c2: { doc: 3, page: 1, label: '1', status: 'verified', quote: 'combine pre-trained parametric and non-parametric memory for language generation', reason: 'Quote found verbatim and supports the claim.' },
    c3: { doc: 4, page: 2, label: '2', status: 'verified', quote: 'performance is often highest when relevant information occurs at the beginning or end of the input context', reason: 'Quote found verbatim and supports the claim.' },
    c4: { doc: 5, page: 1, label: '1', status: 'weak', quote: 'my guess: retrieval shrinks the context but the order of the retrieved chunks probably still matters', reason: 'Partly supports it. Your note is a hypothesis, not a finding.' },
    c5: { doc: 2, page: 4, label: '4', status: 'unsupported', quote: 'a deep bidirectional model is strictly more powerful than either a left-to-right model', reason: 'The quote is real but says nothing about position bias in long inputs.' },
    c6: { doc: 0, page: 0, label: '', status: 'pending', quote: '', reason: 'Not checked yet.' },
  };
  const pages = {
    '1:1': 'Abstract. The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder. The best performing models also connect the encoder and decoder through an attention mechanism. {{We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely.}} Experiments on two machine translation tasks show these models to be superior in quality while being more parallelizable and requiring significantly less time to train.',
    '3:1': 'Abstract. Large pre-trained language models have been shown to store factual knowledge in their parameters, and achieve state-of-the-art results when fine-tuned on downstream NLP tasks. We explore a general-purpose fine-tuning recipe for retrieval-augmented generation (RAG), models which {{combine pre-trained parametric and non-parametric memory for language generation}}. We introduce RAG models where the parametric memory is a pre-trained seq2seq model and the non-parametric memory is a dense vector index of Wikipedia.',
    '4:2': '1 Introduction. Language models have become an important and flexible building block in a variety of user-facing language technologies. These models often use prompts that include long inputs. We analyze how well they can use input contexts, and find that {{performance is often highest when relevant information occurs at the beginning or end of the input context}}, and significantly degrades when models must access relevant information in the middle of long contexts.',
    '2:4': '3.1 Pre-training BERT. Task #1: Masked LM. Intuitively, it is reasonable to believe that {{a deep bidirectional model is strictly more powerful than either a left-to-right model}} or the shallow concatenation of a left-to-right and a right-to-left model. Unfortunately, standard conditional language models can only be trained left-to-right or right-to-left.',
    '5:1': 'Week 3: RAG vs long context. Tried 20-passage prompts on the pilot set. Answers got worse when the gold passage landed mid-list. Not rigorous yet; {{my guess: retrieval shrinks the context but the order of the retrieved chunks probably still matters}}. TODO: rerun with shuffled order, 3 seeds.',
  };
  const comments = [
    { id: 'k1', anchor: 'c5', text: 'Devlin p.4 argues bidirectional models are stronger. It says nothing about position bias in long inputs. Remove the claim, or cite Liu et al. instead.', actions: [['Swap to Liu 2023', 'swap'], ['Dismiss', 'dismiss']] },
    { id: 'k2', anchor: 'c4', text: 'Your own note is a hypothesis. Phrase it as preliminary, or find an empirical source.', actions: [['Find sources', 'search'], ['Dismiss', 'dismiss']] },
    { id: 'k3', anchor: 'c6', text: 'Best match in your library for this sentence:', quote: 'Liu 2023, p.2 · match 0.81', actions: [['Insert citation', 'insert'], ['Dismiss', 'dismiss']] },
  ];

  const esc = (s) => String(s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  const docById = (id) => docs.find((d) => d.id === id);
  const chipText = (c) => (c.doc ? docById(c.doc).short + ' · p.' + c.label : 'cite…');
  const chipHTML = (k) => {
    const c = cites[k];
    return `<span class="chip" contenteditable="false" data-c="${k}" data-status="${c.status}"><i></i>${esc(chipText(c))}</span>`;
  };

  const bodyHTML = `
<h1 class="d-title">Does retrieval fix long-context failure?</h1>
<p class="d-by"><span>You</span> · Draft 3 · 412 words · saved just now</p>
<h2>Background</h2>
<p>The Transformer dispenses with recurrence and convolutions entirely [[c1]]. Retrieval-augmented generation pairs a parametric model with a non-parametric memory [[c2]], so the model reads a short, relevant slice instead of the whole corpus.</p>
<p>Long inputs are used unevenly: accuracy is highest when the evidence sits at the start or end of the prompt [[c3]]. Retrieval narrows the context but may not remove that effect [[c4]]. Encoder models such as BERT avoid the problem through bidirectional attention [[c5]].</p>
<h2>Argument</h2>
<p>If order still matters after retrieval, then reranking is not a polish step but part of the answer [[c6]]</p>
<blockquote>Open question: does the effect shrink when the retrieved set is under five passages?</blockquote>`;

  const chev = '<svg width="9" height="9" viewBox="0 0 10 10"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';

  function mountDoc(el, opts = {}) {
    el.classList.add('rc-doc');
    el.innerHTML = `
<div class="d-bar">
  <div class="d-tools">
    <button class="t-sel" type="button">Body ${chev}</button>
    <span class="sep"></span>
    <button data-cmd="bold"><b>B</b></button><button data-cmd="italic"><i>I</i></button><button data-cmd="underline"><u>U</u></button>
    <span class="sep"></span>
    <button data-cmd="insertUnorderedList" title="List"><svg width="14" height="14" viewBox="0 0 14 14"><path d="M5 3.5h7M5 7h7M5 10.5h7" stroke="currentColor" stroke-width="1.4"/><circle cx="2" cy="3.5" r="1" fill="currentColor"/><circle cx="2" cy="7" r="1" fill="currentColor"/><circle cx="2" cy="10.5" r="1" fill="currentColor"/></svg></button>
    <button data-cmd="formatBlock" data-arg="blockquote" title="Quote">&#10077;</button>
    <span class="sep"></span>
    <button class="t-cite" type="button">Cite…</button>
  </div>
  <div class="d-meta">
    <span class="vsum"></span>
    <button class="t-verify" type="button">Verify all</button>
    <button class="t-style" type="button">APA 7 ${chev}</button>
  </div>
</div>
<div class="d-scroll"><div class="d-stage">
  <article class="d-paper" contenteditable="true" spellcheck="false">${bodyHTML.replace(/\[\[(c\d)\]\]/g, (_, k) => chipHTML(k))}</article>
  <div class="d-margin"></div>
</div></div>
<div class="d-sel" hidden>
  <button data-cmd="bold"><b>B</b></button><button data-cmd="italic"><i>I</i></button>
  <span class="sep"></span><button class="s-cite">Find citation</button><button class="s-ask">Ask Muse</button><button class="s-com">Comment</button>
</div>
<div class="d-pop" hidden></div>
<div class="d-toast" hidden></div>`;

    const $ = (s) => el.querySelector(s);
    const paper = $('.d-paper'), margin = $('.d-margin'), pop = $('.d-pop'), sel = $('.d-sel'), toast = $('.d-toast');
    const cmts = comments.map((c) => ({ ...c }));

    const say = (t) => {
      toast.textContent = t; toast.hidden = false;
      clearTimeout(say.t); say.t = setTimeout(() => (toast.hidden = true), 1800);
    };

    function summary() {
      const n = { verified: 0, weak: 0, unsupported: 0, pending: 0 };
      paper.querySelectorAll('.chip').forEach((c) => { if (n[c.dataset.status] !== undefined) n[c.dataset.status]++; });
      $('.vsum').innerHTML = Object.entries(n).filter(([, v]) => v)
        .map(([k, v]) => `<span class="vs" data-status="${k}"><i></i>${v} ${k}</span>`).join('');
    }

    function layout() {
      const st = $('.d-stage').getBoundingClientRect();
      let floor = 0;
      margin.querySelectorAll('.cm').forEach((cm) => {
        const a = paper.querySelector(`[data-c="${cm.dataset.for}"]`);
        const top = a ? a.getBoundingClientRect().top - st.top - 8 : floor;
        const y = Math.max(top, floor);
        cm.style.top = y + 'px';
        floor = y + cm.offsetHeight + 10;
      });
    }
    function renderComments() {
      margin.innerHTML = cmts.map((c) => `
<div class="cm" data-for="${c.anchor}" data-id="${c.id}">
  <div class="cm-h"><span class="av">M</span><b>Muse</b><span class="cm-t">now</span></div>
  <p>${esc(c.text)}</p>${c.quote ? `<div class="cm-q">${esc(c.quote)}</div>` : ''}
  <div class="cm-a">${c.actions.map(([l, a]) => `<button data-act="${a}">${esc(l)}</button>`).join('')}</div>
</div>`).join('');
      layout();
    }
    new ResizeObserver(layout).observe(paper);

    margin.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const c = cmts.find((x) => x.id === b.closest('.cm').dataset.id);
      const chip = paper.querySelector(`[data-c="${c.anchor}"]`);
      if (b.dataset.act === 'swap' || b.dataset.act === 'insert') {
        Object.assign(cites[c.anchor], cites.c3, { status: 'verified' });
        chip.dataset.status = 'verified';
        chip.innerHTML = `<i></i>${esc(chipText(cites[c.anchor]))}`;
        say('Citation updated and verified');
      }
      if (b.dataset.act === 'search') { say('Searching 3,412 passages…'); return; }
      cmts.splice(cmts.indexOf(c), 1);
      renderComments(); summary();
    });

    el.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (chip && cites[chip.dataset.c].doc && opts.onOpenSource) opts.onOpenSource({ ...cites[chip.dataset.c], key: chip.dataset.c });
      const t = e.target.closest('[data-cmd]');
      if (t) { document.execCommand(t.dataset.cmd, false, t.dataset.arg || null); paper.focus(); }
    });
    paper.addEventListener('mouseover', (e) => {
      const chip = e.target.closest('.chip'); if (!chip) return;
      const c = cites[chip.dataset.c];
      pop.innerHTML = c.doc
        ? `<div class="p-h"><i data-status="${c.status}"></i>${esc(docById(c.doc).title)}<span>p.${c.label}</span></div><blockquote>“${esc(c.quote)}”</blockquote><div class="p-r">${esc(c.reason)}</div><div class="p-k">Click to open the source</div>`
        : `<div class="p-r">${esc(c.reason)}</div>`;
      const r = chip.getBoundingClientRect(), b = el.getBoundingClientRect();
      pop.hidden = false;
      pop.style.left = Math.max(8, Math.min(r.left - b.left, b.width - 350)) + 'px';
      pop.style.top = r.bottom - b.top + 8 + 'px';
    });
    paper.addEventListener('mouseout', (e) => { if (e.target.closest('.chip')) pop.hidden = true; });

    document.addEventListener('selectionchange', () => {
      const s = getSelection();
      if (!s.rangeCount || s.isCollapsed || !paper.contains(s.anchorNode)) { sel.hidden = true; return; }
      const r = s.getRangeAt(0).getBoundingClientRect(), b = el.getBoundingClientRect();
      sel.hidden = false;
      sel.style.left = Math.max(8, r.left - b.left + r.width / 2 - sel.offsetWidth / 2) + 'px';
      sel.style.top = r.top - b.top - sel.offsetHeight - 8 + 'px';
    });
    sel.addEventListener('mousedown', (e) => e.preventDefault());
    $('.s-cite').onclick = () => say('Looking for passages that support this sentence…');
    $('.s-ask').onclick = () => say('Muse is reading your selection…');
    $('.s-com').onclick = () => say('Comment added');
    $('.t-cite').onclick = () => say('Pick a passage from your library to cite');
    $('.t-verify').onclick = () => {
      const pend = [...paper.querySelectorAll('.chip[data-status="pending"]')];
      say(pend.length ? 'Checking claims against sources…' : 'Everything has been checked');
      pend.forEach((c) => { c.dataset.status = 'checking'; });
      setTimeout(() => pend.forEach((c) => { c.dataset.status = 'weak'; summary(); }), 1100);
    };

    renderComments(); summary(); setTimeout(layout, 80);
    const want = new URLSearchParams(location.search).get('open');
    if (want && cites[want] && opts.onOpenSource) setTimeout(() => opts.onOpenSource({ ...cites[want], key: want }), 120);
    window.addEventListener('resize', layout);
    return { say };
  }

  function mountSource(el, opts = {}) {
    el.classList.add('rc-src');
    function show(c) {
      const d = docById(c.doc); const raw = pages[c.doc + ':' + c.page] || '';
      const html = esc(raw).replace(/\{\{(.+?)\}\}/, (_, q) => `<mark data-status="${c.status}">${q}</mark>`);
      el.innerHTML = `
<div class="s-head"><div><b>${esc(d.title)}</b><span>${esc(d.authors)} · ${d.year} · ${esc(d.venue)}</span></div><button class="s-x" title="Close">&times;</button></div>
<div class="s-nav"><button disabled>&lsaquo;</button><span>Page ${c.page} of ${d.pages} · printed ${c.label}</span><button disabled>&rsaquo;</button><em data-status="${c.status}">${esc(c.status)}</em></div>
<div class="s-sheet"><div class="s-ln w2"></div><p>${html}</p><div class="s-ln w1"></div><div class="s-ln w2"></div><div class="s-ln"></div><div class="s-ln w3"></div></div>
<div class="s-why"><b>Why this status</b>${esc(c.reason)}</div>`;
      el.querySelector('.s-x').onclick = () => { el.innerHTML = ''; if (opts.onClose) opts.onClose(); };
      if (opts.onShow) opts.onShow(c, el.querySelector('mark'));
    }
    return { show };
  }

  const kindLabel = { pdf: 'PDF', text: 'MD', web: 'WEB', image: 'SCAN' };
  window.RC = { docs, topics, cites, docById, kindLabel, mountDoc, mountSource, esc };
})();
