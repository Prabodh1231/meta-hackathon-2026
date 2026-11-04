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

Run it from `backend/`. It uses the configured provider for expansion and ranking (the
offline mock unless Muse is configured with `RC_PROVIDER=muse`; `--provider mock`
forces the mock), and no other model:

```bash
python -I scripts/eval_retrieval.py --json eval/results.json
```

## Results

R@k: share of questions whose gold passage is in the top k. MRR: mean reciprocal rank (top 10).

The rows that scored the earlier, non-Meta search models have been removed: those
models were taken out of the app for the Meta-only rule (every model the app calls is
now a Meta model through Meta's Model API), so their numbers no longer describe any
search the app can run. Search is now keyword search (SQLite FTS5/BM25, no model) plus
Muse expansion and ranking through the provider layer. Measured 5 Nov 2026 with
muse-spark-1.3, both search calls at "minimal" reasoning effort, ranking 20 passages of
450 characters:

| Configuration | R@1 | R@3 | MRR | keyword | paraphrase | precision | identifier | ms/query |
|---|---|---|---|---|---|---|---|---|
| keyword (BM25) | 0.75 | 0.84 | 0.80 | 0.92 | 0.33 | 0.83 | 1.00 | 0 |
| keyword + expansion | 0.82 | 0.93 | 0.88 | 0.92 | 0.75 | 0.67 | 1.00 | 3122 |
| keyword + expansion + ranking | 0.98 | 1.00 | 0.98 | 1.00 | 0.92 | 1.00 | 1.00 | 7173 |

Per-type columns are R@1. For comparison, the removed bge-small + MiniLM search scored
R@1 0.91 and R@3 0.98 on this set, at about 0.45 s per query. "low" effort gave the same
accuracy as "minimal" (R@1 0.98) at 14.2 s per query. On the real 157-paper library a
search with expansion and ranking takes about 13 s, a Cite suggestion (search plus four
support checks run side by side) about 28 s, and drafting with citations about 31 s.

## What the three configurations are

- **keyword (BM25)** is the instant filter: SQLite FTS5/BM25 for the query alone, with
  no provider call.
- **keyword + expansion** also runs BM25 for each short expansion the provider suggests
  (the words a paper would likely use) and fuses the lists by reciprocal rank fusion.
- **keyword + expansion + ranking** additionally asks the provider to score the top
  fused passages in one call; on any failure the fused keyword order is kept.

**Caveats:** 44 questions is small (one question ≈ 2 points of R@1). The passages are
short and each is its own chunk, whereas real chunks are ~900 characters. The identifier
group was added after an early run showed the original keyword questions always had
context words around the identifier. With only 40 passages this set cannot show what
the keyword index is for in a large library; that is what the large set below is for.

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

As on the small set, the earlier configurations' rows have been removed with the
non-Meta models they measured. `scripts/eval_large.py run` now scores the same three
configurations as the small script; the numbers from that run (on the local library,
which stays git-ignored) go here:

| Configuration | R@1 | R@3 | R@10 | MRR | cand@24 | identifier | keyword | paraphrase | ms/query |
|---|---|---|---|---|---|---|---|---|---|
| keyword (BM25) | — | — | — | — | — | — | — | — | — |
| keyword + expansion | — | — | — | — | — | — | — | — | — |
| keyword + expansion + ranking | — | — | — | — | — | — | — | — | — |

cand@24: share of questions whose gold is among the first 24 keyword candidates for
the query. A gold missing there can only be found if an expansion's list brings it in.
Per-type columns are R@1.

- The large set exists to show what the keyword index is for: in a library this size a
  rare code or identifier can sit far down any subject-similarity ordering, while BM25
  finds it directly. Which of expansion and ranking helps, and by how much, is what the
  run above measures.
- **Caveat on paraphrases:** a reworded question can have several valid passages in a
  library this size, but only the one it was written from counts as a hit, so paraphrase
  scores understate usefulness.

```bash
python scripts/fetch_arxiv_eval.py                          # optional look-alike papers
python scripts/eval_large.py build "path/to/papers" eval/large/arxiv
python scripts/eval_large.py sample --n 70                  # passages to write questions from
python scripts/eval_large.py run --json eval/large/results.json
```

`tests/test_retrieval_eval.py` re-runs the small set offline with the mock provider and
checks the metric helpers, the three configurations above and the printed table. The
large script shares those configurations and helpers.

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
