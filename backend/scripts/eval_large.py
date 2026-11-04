"""Retrieval evaluation on a real-sized library (eval/large/, git-ignored).

  build   ingest PDF folders (the researcher's papers + scripts/fetch_arxiv_eval.py
          downloads) into a separate eval library; the real library is never touched
  sample  print a spread of substantive chunks to write questions from
  run     score each retrieval configuration on eval/large/questions.json

A question's gold is a passage substring; any retrieved chunk containing it (whitespace-
insensitive) counts as a hit, since overlapping chunks can both hold it. Besides R@k and
MRR, `run` reports candidate recall: how often the gold is in the keyword candidate
pool at all, which is where keyword search should matter in a big library.

Usage:
  python scripts/eval_large.py build FOLDER [FOLDER ...]
  python scripts/eval_large.py sample [--n 80] [--seed 7]
  python scripts/eval_large.py run [--json eval/large/results.json]
"""

import argparse
import json
import os
import random
import re
import sqlite3
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.library import Library  # noqa: E402
from app.providers import MockProvider  # noqa: E402
from app.settings import Settings  # noqa: E402
from eval_retrieval import CONFIGS, compute_metrics, search_args  # noqa: E402

ROOT = Path(__file__).resolve().parents[1] / "eval" / "large"
QUESTIONS = ROOT / "questions.json"
K = 10
POOL = 24  # keyword candidates counted for candidate recall


def norm(s: str) -> str:
    return " ".join(s.split())


def open_library() -> Library:
    return Library(Settings(data_dir=ROOT / "library"), provider=MockProvider())


def build(folders: list[str]) -> None:
    lib = open_library()
    for folder in folders:
        start = time.perf_counter()
        results = lib.ingest_path(folder)
        failed = [r for r in results if not r["ok"]]
        print(f"{len(results) - len(failed):>3} ingested, {len(failed)} failed  ({time.perf_counter() - start:.0f}s)  {folder}")
        for r in failed:
            print(f"      failed: {Path(r['source']).name}: {r['error']}")
    docs = lib.conn.execute("SELECT count(*) FROM documents").fetchone()[0]
    chunks = lib.conn.execute("SELECT count(*) FROM chunks").fetchone()[0]
    print(f"library: {docs} documents, {chunks} chunks")


_REFERENCE_LIKE = re.compile(r"(et al\.|\(\d{4}\)|doi|Journal of|pp\.|Vol\.)", re.I)


def sample(n: int, seed: int) -> None:
    """Up to one substantive chunk per document (two when documents run out), skipping
    reference lists, tables of numbers and front matter."""
    lib = open_library()
    rows = lib.conn.execute(
        "SELECT c.id, c.doc_id, c.page, c.text, d.title, d.source FROM chunks c JOIN documents d ON d.id = c.doc_id"
    ).fetchall()
    rng = random.Random(seed)
    by_doc: dict[int, list] = {}
    for r in rows:
        text = norm(r["text"])
        letters = sum(ch.isalpha() for ch in text)
        if len(text) < 500 or letters / len(text) < 0.7 or len(_REFERENCE_LIKE.findall(text)) > 3 or r["page"] == 1:
            continue
        by_doc.setdefault(r["doc_id"], []).append(r)
    picks = []
    for round_ in range(2):
        for doc_id in rng.sample(sorted(by_doc), len(by_doc)):
            if len(picks) < n and len(by_doc[doc_id]) > round_:
                picks.append(rng.choice(by_doc[doc_id]))
    for r in picks:
        origin = "arxiv" if "arxiv" in r["source"] else "user"
        print(f"\n### chunk {r['id']} | {origin} | p.{r['page']} | {r['title'][:80]}\n{norm(r['text'])}")


def evaluate(lib: Library, questions: list[dict], mode, chunk_text: dict[int, str],
             rerank: bool | None = None) -> dict:
    """Score one of eval_retrieval's three configurations (keyword / expanded / ranked)."""
    lib_mode, do_rerank = search_args(mode, rerank)
    ranks, pool_hits, times, by_type = [], [], [], {}
    for q in questions:
        gold = norm(q["answer"])
        start = time.perf_counter()
        hits = lib.search(q["q"], k=K, mode=lib_mode, rerank=do_rerank)
        times.append(time.perf_counter() - start)
        rank = next((i + 1 for i, h in enumerate(hits) if gold in norm(h["text"])), None)
        ranks.append(rank)
        by_type.setdefault(q["type"], []).append(rank)
        # Candidate recall: is the gold in the keyword pool for this query?
        pool = [cid for cid, _ in lib._keyword(q["q"], POOL, None)]
        pool_hits.append(any(gold in chunk_text[c] for c in pool))

    def metrics(rs: list) -> dict:
        return {**compute_metrics(rs), "R@10": sum(r is not None for r in rs) / len(rs) if rs else 0.0}

    return {
        "mode": mode["key"] if isinstance(mode, dict) else mode,
        "search_mode": lib_mode,
        "rerank": do_rerank,
        "overall": metrics(ranks),
        "by_type": {t: metrics(rs) for t, rs in by_type.items()},
        "candidate_recall@24": sum(pool_hits) / len(pool_hits),
        "ms_per_query": 1000 * statistics.mean(times),
        "missed_at_1": [q["q"] for q, r in zip(questions, ranks) if r != 1],
    }


def run(out: Path | None) -> None:
    lib = open_library()
    questions = json.loads(QUESTIONS.read_text(encoding="utf-8"))["questions"]
    chunk_text = {r["id"]: norm(r["text"]) for r in lib.conn.execute("SELECT id, text FROM chunks")}
    for q in questions:  # every gold must exist; report how many chunks hold it
        holders = sum(norm(q["answer"]) in t for t in chunk_text.values())
        assert holders >= 1, f"gold not found in library: {q['answer']!r}"
        q["_holders"] = holders
    multi = sum(q["_holders"] > 1 for q in questions)
    docs = lib.conn.execute("SELECT count(*) FROM documents").fetchone()[0]

    results = {}
    for config in CONFIGS:
        lib.search("warm up", k=K, mode=config["mode"], rerank=config["rerank"])
        results[config["label"]] = evaluate(lib, questions, config, chunk_text)

    types = sorted({q["type"] for q in questions})
    print(f"\nsearch: keyword (BM25), plus {lib.provider.name} expansion and ranking in the last two configurations")
    print(f"\n{len(questions)} questions ({', '.join(f'{sum(q['type'] == t for q in questions)} {t}' for t in types)}); "
          f"library: {docs} documents, {len(chunk_text)} chunks; {multi} golds occur in more than one chunk\n")
    header = (f"{'configuration':<28}{'R@1':>6}{'R@3':>6}{'R@10':>6}{'MRR':>6}{'cand@24':>9}  "
              + "".join(f"{t + ' R@1':>16}" for t in types) + f"{'ms/q':>7}")
    print(header + "\n" + "-" * len(header))
    for label, r in results.items():
        o = r["overall"]
        print(f"{label:<28}{o['R@1']:>6.2f}{o['R@3']:>6.2f}{o['R@10']:>6.2f}{o['MRR']:>6.2f}{r['candidate_recall@24']:>9.2f}  "
              + "".join(f"{r['by_type'][t]['R@1']:>16.2f}" for t in types) + f"{r['ms_per_query']:>7.0f}")
    print("\ncand@24 = gold among the first 24 keyword candidates for the query")
    if out:
        out.write_text(json.dumps(results, indent=2), encoding="utf-8")
        print(f"full results written to {out}")


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("folders", nargs="+")
    s = sub.add_parser("sample")
    s.add_argument("--n", type=int, default=80)
    s.add_argument("--seed", type=int, default=7)
    r = sub.add_parser("run")
    r.add_argument("--json", type=Path)
    args = ap.parse_args()
    if args.cmd == "build":
        build(args.folders)
    elif args.cmd == "sample":
        sample(args.n, args.seed)
    else:
        run(args.json)


if __name__ == "__main__":
    main()
