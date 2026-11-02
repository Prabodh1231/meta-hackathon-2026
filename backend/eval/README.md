# Retrieval evaluation

`retrieval_set.json` is a small, deliberately confusable research library: 40 passages across
8 documents (two sleep studies and a review, two coral papers, notes on RAG, a lab notebook
full of codes, meeting minutes) and 44 questions with exactly one gold passage each.

| Question type | n | What it tests |
|---|---|---|
| keyword | 12 | identifiers, numbers and names inside a normal question |
| paraphrase | 12 | little or no word overlap with the answer |
| precision | 12 | several passages share the keywords; only one answers |
| identifier | 8 | just a code or name, nothing else (added after the first run, see below) |

Run it (models download to `~/.research-companion/models` on first use):

```bash
python scripts/eval_retrieval.py --json eval/results.json
```

## Results

R@k: share of questions whose gold passage is in the top k. MRR: mean reciprocal rank (top 10).

| Configuration | R@1 | R@3 | MRR | keyword | paraphrase | precision | identifier | ms/query |
|---|---|---|---|---|---|---|---|---|
| dense: embeddings only (**before**) | 0.82 | 0.93 | 0.89 | 0.92 | 0.75 | 0.75 | 0.88 | 5 |
| keyword: BM25 only | 0.75 | 0.84 | 0.80 | 0.92 | 0.33 | 0.83 | 1.00 | 0 |
| hybrid: RRF of both, no reranker | 0.77 | 0.91 | 0.86 | 0.92 | 0.42 | 0.83 | 1.00 | 5 |
| dense + MiniLM-L-6 reranker | 0.91 | 0.98 | 0.94 | 0.92 | 0.83 | 0.92 | 1.00 | 477 |
| **hybrid + MiniLM-L-6 reranker (default)** | **0.91** | **0.98** | **0.94** | 0.92 | 0.83 | 0.92 | 1.00 | 463 |
| hybrid + MiniLM-L-12 reranker | 0.89 | 0.95 | 0.93 | 0.92 | 0.75 | 0.92 | 1.00 | 739 |

Per-type columns are R@1. Timings are on CPU, with the reranker scoring 24 candidates.

## What this shows, and what it doesn't

- **The reranker is the win.** Right passage first goes from 82% to 91%, top-3 from 93% to 98%. Paraphrase and look-alike questions gain the most, and no question type gets worse. The smaller L-6 model beats L-12 and is faster, so it's the default. Cost: about 0.45 s per search.
- **Fusion without a reranker is worse than embeddings alone** (R@1 0.82 → 0.77): keyword hits push good paraphrase matches down. On the large library below the reverse holds, so when the reranker can't load the app uses plain hybrid (`mode="auto"`). It used embeddings only until that measurement.
- **The keyword index helps identifier-only lookups** on its own (0.88 → 1.00), but **with the reranker it adds nothing measurable here**. With only 40 passages, the reranker's 24 candidates already cover most of the library, so the gold passage is always among them. The keyword index matters in a large library, where a rare code like `S-208` can fall outside the embedding top-24; this set is too small to show that. It costs under a millisecond and is kept for that case.
- **Caveats:** 44 questions is small (one question ≈ 2 points of R@1). The passages are short and each is its own chunk, whereas real chunks are ~900 characters. The identifier group was added after the first run showed the original keyword questions always had context words around the identifier. The Jina rerankers weren't compared because their downloads were too slow here; pass `--rerankers jinaai/jina-reranker-v1-tiny-en` to include one.

## At library scale

The small set can't show what the keyword index is for, so `scripts/eval_large.py` repeats the
comparison on a real-sized library: 93 PDFs, **14,099 chunks**. It has 54 of the researcher's own
papers (financial inclusion, household finance, transfer entropy and connectedness) plus 39
on-topic arXiv papers fetched by `scripts/fetch_arxiv_eval.py` as look-alike neighbours.
There are 70 questions written from sampled passages before any retrieval run:

| Question type | n | What it tests |
|---|---|---|
| identifier | 24 | a figure, code, package or author-year leads the question |
| keyword | 22 | a normal question using the passage's own terms |
| paraphrase | 24 | the answer's ideas in other words |

A hit is any chunk containing the gold sentence. Overlapping chunks and four papers that sit in
two folders mean some golds have more than one valid chunk. The papers, library and questions stay
local (`eval/large/` is git-ignored). Only these aggregates are recorded here.

| Configuration | R@1 | R@3 | R@10 | MRR | cand@24 | identifier | keyword | paraphrase | ms/query |
|---|---|---|---|---|---|---|---|---|---|
| dense: embeddings only (**before**) | 0.27 | 0.46 | 0.63 | 0.39 | 0.71 | 0.33 | 0.32 | 0.17 | 9 |
| keyword: BM25 only | 0.51 | 0.64 | 0.71 | 0.59 | 0.79 | 0.88 | 0.59 | 0.08 | 22 |
| hybrid: RRF of both, no reranker | 0.37 | 0.56 | 0.69 | 0.48 | 0.84 | 0.46 | 0.41 | 0.25 | 34 |
| dense + MiniLM-L-6 reranker | 0.50 | 0.64 | 0.69 | 0.57 | 0.71 | 0.67 | 0.68 | 0.17 | 1065 |
| **hybrid + MiniLM-L-6 reranker (default)** | **0.56** | **0.70** | **0.77** | **0.63** | **0.84** | 0.83 | 0.68 | 0.17 | 1093 |

cand@24: share of questions whose gold is among the 24 candidates handed to the reranker. A gold
missing there can never be ranked first. Per-type columns are R@1.

- **Embeddings alone don't hold up at scale.** The right passage comes first 27% of the time
  (82% on the 40-passage set) and is missing from the top 10 for 37% of questions. Among
  14,000 chunks on the same few topics, many passages sound alike.
- **This is where the keyword index earns its place.** It lifts the reranker's candidate recall
  from 71% to 84%. Identifier questions go from 0.67 to 0.83 at R@1 and from 0.79 to 1.00 at R@10.
  The default (hybrid + rerank) is the best configuration overall, at **2.1× the R@1 of the old
  embeddings-only search** (0.27 → 0.56).
- **Plain fusion beats embeddings alone here** (0.37 vs 0.27 R@1, 0.84 vs 0.71 cand@24), the
  reverse of the small set. So when the reranker can't load, `mode="auto"` now falls back to
  plain hybrid instead of embeddings only.
- **Paraphrases are the weak spot.** Only half reach the top 10 in any configuration, and the
  reranker doesn't move them. Part of this is the scoring: a reworded question about, say, fintech
  lowering costs has several valid passages in a library this size, but only the one it was
  written from counts. Part is the small embedding model. A larger embedder or a query
  rewritten by Muse before search are the next things to measure.
- **The reranker costs about 1.1 s per search** on full-length chunks (vs 0.46 s on the short
  passages of the small set). Embeddings and BM25 together take about 35 ms.

```bash
python scripts/fetch_arxiv_eval.py                          # optional look-alike papers
python scripts/eval_large.py build "path/to/papers" eval/large/arxiv
python scripts/eval_large.py sample --n 70                  # passages to write questions from
python scripts/eval_large.py run --json eval/large/results.json
```

### bge-small or BGE-M3?

The table above uses bge-small (`fastembed`, the CPU model). On a machine with an NVIDIA GPU the app
loads BGE-M3 instead: a 2 GB download and about 12 s to load at every start. `run --embedder bge-m3`
scores the same library and questions with it (2026-11-02; re-embedding the 14,099 chunks took 152 s on the GPU):

| Configuration | Embedder | R@1 | R@3 | R@10 | MRR | cand@24 | identifier | keyword | paraphrase |
|---|---|---|---|---|---|---|---|---|---|
| dense: embeddings only | bge-small | 0.27 | 0.46 | 0.63 | 0.39 | 0.71 | 0.33 | 0.32 | 0.17 |
| dense: embeddings only | BGE-M3 | 0.36 | 0.51 | 0.69 | 0.46 | 0.87 | 0.46 | 0.45 | 0.17 |
| **hybrid + reranker (default)** | bge-small | 0.56 | 0.70 | 0.77 | 0.63 | 0.84 | 0.83 | 0.68 | 0.17 |
| **hybrid + reranker (default)** | BGE-M3 | 0.56 | 0.71 | 0.81 | 0.64 | 0.86 | 0.83 | 0.68 | 0.17 |

- **On its own, BGE-M3 is clearly better**: right passage first 27% → 36% of the time, and the
  gold reaches the reranker's 24 candidates for 87% of questions instead of 71%.
- **In the search the app actually runs, the difference almost disappears.** Keyword search and
  the reranker already make up for the weaker embedder. The passage ranked first is the same for
  all 70 questions. BGE-M3 brings three more golds into the top 10 (two keyword questions, one
  paraphrase); R@3 and MRR move by one question or less.
- **Paraphrases aren't held back by the embedder.** Both put 17% first and about half in the top 10,
  so the next thing to try there is the reranker or a query rewritten by Muse, not a bigger embedder.
- Caveats: 70 questions (one question ≈ 1.4 points), all in English; BGE-M3 is also multilingual,
  which this set doesn't test.

On this result the app dropped BGE-M3 (on the GPU and on Baseten) and ships only bge-small.
`run --embedder bge-m3` still works for comparisons, with `sentence-transformers` installed by hand
(`scripts/st_embedder.py`).

`tests/test_retrieval_eval.py` re-runs the small set with the cached models and fails if reranked hybrid stops beating embeddings alone, if any question type gets worse, or if the default mode starts using plain fusion.

# Matrix check evaluation

`scripts/eval_matrix_check.py` measures the check behind blue citations: whether a sentence
written from a review matrix is backed by the matrix (`judge_against_matrix`). It sends Muse a
four-study matrix on mobile money, in the exact text form the app sends (answers with their
quotes), and 15 sentences with the verdict a careful reviewer would give:

- 7 supported comparisons and gaps (for example "None of the studies examines rural India");
- 3 overstatements, where partial is expected and unsupported is also accepted;
- 5 contradicted or invented claims.

```bash
python scripts/eval_matrix_check.py --runs 3 --compare-quote --save
```

`--compare-quote` also judges each sentence against one study's quote, the way these citations
were checked before, to show the difference. The script needs the Muse provider set up as for
the app; `--provider mock` only tries the script, since the mock matches words rather than
judging meaning.

## Results

Muse through the Baseten route, each sentence judged 3 times (`eval/matrix_check_results.json`):

| Check | Exact | Acceptable | supported → supported | Unstable across runs | Median time |
|---|---|---|---|---|---|
| **Against the matrix (blue citations)** | **13/15** | **15/15** | **7/7** | 0/15 | 1.6 s |
| Against one study's quote (before) | — | 8/15 | 0/7 | — | — |

- **Every supported comparison and gap was called supported**, including ones no single passage
  can back ("None of the studies examines rural India", "The largest sample is Okoro's"). Checked
  against one quote, not one of the 7 was. That's why these citations are checked against the matrix.
- **Every contradicted or invented claim was called unsupported**, and each reason names the row and
  value that contradicts it.
- **The two that weren't exact are overstatements** ("All four studies find…", "The studies
  consistently name…"), which Muse called unsupported rather than partial, all three times. Its
  reasons say most of the studies don't back them, which is a fair reading of a claim about all of
  them, so the prompt was left as it is.
- **Caveats:** 15 sentences on one invented matrix, with expected verdicts written alongside the
  script. It shows the check can judge comparisons and gaps, not how often it errs on real reviews.
