"""Measure reference parsing and matching on a library database (use a copy: it is only read).

    python scripts/eval_refparse.py PATH/TO/library.db [--show-matches] [--show-misses]
"""

import argparse
import json
import re
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.refparse import Reference, find_section, match_reference, norm, parse_references, split_entries  # noqa: E402


def load(db: str):
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    docs = [
        {"id": r["id"], "title": r["title"], "authors": json.loads(r["authors"]), "year": r["year"], "doi": r["doi"], "kind": r["kind"]}
        for r in conn.execute("SELECT id, title, authors, year, doi, kind FROM documents ORDER BY id")
    ]
    text = {
        d["id"]: "\n".join(r[0] for r in conn.execute("SELECT text FROM pages WHERE doc_id = ? ORDER BY page", (d["id"],)))
        for d in docs
    }
    return docs, text


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("db")
    ap.add_argument("--show-matches", action="store_true")
    ap.add_argument("--show-misses", action="store_true")
    args = ap.parse_args()
    docs, text = load(args.db)
    by_id = {d["id"]: d for d in docs}
    pdfs = [d for d in docs if d["kind"] == "pdf"]

    # --- 1. finding and splitting
    with_section = {d["id"]: find_section(text[d["id"]]) for d in pdfs}
    found = {i: s for i, s in with_section.items() if s}
    print(f"{len(pdfs)} PDFs; reference section found in {len(found)}")
    counts, numbered_ok, numbered_total, off = {}, 0, 0, []
    refs: dict[int, list[Reference]] = {}
    for i, section in found.items():
        refs[i] = parse_references(text[i])
        counts[i] = len(refs[i])
        split = split_entries(section)  # before the filter that drops non-references
        nums = [n for n, _ in split if n]
        if len(nums) >= 3:  # numbered list: the last number is the true entry count
            numbered_total += 1
            if len(split) == max(nums) == len(nums):
                numbered_ok += 1
            else:
                off.append((by_id[i]["title"][:45], len(split), max(nums)))
    sizes = sorted(counts.values())
    print(f"entries per paper: median {sizes[len(sizes) // 2]}, min {sizes[0]}, max {sizes[-1]}; "
          f"{sum(1 for n in sizes if n < 8)} papers with fewer than 8 entries (likely mis-split)")
    print(f"numbered lists: {numbered_ok}/{numbered_total} split into exactly as many entries as their last number")
    for t, got, want in off[:6]:
        print(f"    off: {t}: got {got}, list says {want}")
    for i, n in counts.items():
        if n < 8:
            print(f"    few entries ({n}): {by_id[i]['title'][:45]!r}; section starts {found[i][:90]!r}")
    for d in pdfs:
        if d["id"] not in found:
            print(f"    no section: {d['title'][:50]!r} ({len(text[d['id']])} chars)")

    # --- 2. field extraction
    allrefs = [r for rs in refs.values() for r in rs]
    n = len(allrefs)
    print(f"\n{n} entries: year {sum(1 for r in allrefs if r.year) / n:.0%}, title {sum(1 for r in allrefs if r.title) / n:.0%}, "
          f"DOI {sum(1 for r in allrefs if r.doi) / n:.0%}, first author {sum(1 for r in allrefs if r.first_author) / n:.0%}")

    # --- 3. matching against the library
    edges, how_counts = [], {}
    for i, rs in refs.items():
        for r in rs:
            m = match_reference(r, docs, by_id[i]["year"], i)
            if m:
                edges.append((i, m, r))
                how_counts[m.how] = how_counts.get(m.how, 0) + 1
    cited = {m.doc_id for _, m, _ in edges}
    print(f"\ncitation edges inside the library: {len(edges)} ({how_counts})")
    print(f"papers that cite something in the library: {len({i for i, _, _ in edges})}; papers cited by something: {len(cited)}")
    if args.show_matches:
        for i, m, r in edges:
            print(f"  [{m.how} {m.score:.2f}] {by_id[i]['title'][:38]!r} -> {by_id[m.doc_id]['title'][:38]!r}\n        entry: {r.raw[:150]!r}")

    # --- 4. possible misses: a library title mostly present in an entry that did not match
    matched_pairs = {(i, m.doc_id) for i, m, _ in edges}
    misses = []
    for i, rs in refs.items():
        for r in rs:
            rn = norm(r.raw)
            for d in docs:
                words = norm(d["title"]).split()
                if d["id"] == i or (i, d["id"]) in matched_pairs or len(words) < 5:
                    continue
                if " ".join(words[:5]) in rn:  # the title's first five words appear in a row
                    misses.append((by_id[i]["title"][:38], d["title"][:50], r.raw[:140]))
    print(f"\nentries that contain a library paper's first five title words in a row but did not match: {len(misses)}")
    if args.show_misses:
        for a, b, raw in misses:
            print(f"  {a!r} ?-> {b!r}\n        entry: {raw!r}")


if __name__ == "__main__":
    main()
