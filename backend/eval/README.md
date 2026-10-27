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
- **Fusion without a reranker is worse than embeddings alone** (R@1 0.82 → 0.77): keyword hits push good paraphrase matches down. So the app never uses plain fusion. With a reranker it uses hybrid + rerank; if the reranker can't load, it falls back to embeddings only (`mode="auto"`).
- **The keyword index helps identifier-only lookups** on its own (0.88 → 1.00), but **with the reranker it adds nothing measurable here**. With only 40 passages, the reranker's 24 candidates already cover most of the library, so the gold passage is always among them. The keyword index matters in a large library, where a rare code like `S-208` can fall outside the embedding top-24; this set is too small to show that. It costs under a millisecond and is kept for that case.
- **Caveats:** 44 questions is small (one question ≈ 2 points of R@1). The passages are short and each is its own chunk, whereas real chunks are ~900 characters. The identifier group was added after the first run showed the original keyword questions always had context words around the identifier. The Jina rerankers weren't compared because their downloads were too slow here; pass `--rerankers jinaai/jina-reranker-v1-tiny-en` to include one.

`tests/test_retrieval_eval.py` re-runs this set with the cached models and fails if reranked hybrid stops beating embeddings alone, if any question type gets worse, or if the default mode starts using plain fusion.
