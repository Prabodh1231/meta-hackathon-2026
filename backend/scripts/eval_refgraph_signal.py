"""How much citation structure a library has once unresolved references count too: shared
references between papers (bibliographic coupling) and works many papers cite that the library lacks.

    python scripts/eval_refgraph_signal.py PATH/TO/library.db
"""

import sys
from collections import Counter, defaultdict
from itertools import combinations
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from app.refparse import match_reference, norm, parse_references  # noqa: E402
from eval_refparse import load  # noqa: E402


def main() -> None:
    docs, text = load(sys.argv[1])
    by_id = {d["id"]: d for d in docs}
    cites: dict[int, set[str]] = defaultdict(set)  # paper -> keys of the works it cites
    label: dict[str, str] = {}
    for d in docs:
        if d["kind"] != "pdf":
            continue
        for r in parse_references(text[d["id"]]):
            m = match_reference(r, docs, d["year"], d["id"])
            if m:
                key = f"lib:{m.doc_id}"
                label[key] = by_id[m.doc_id]["title"]
            elif len(norm(r.title)) >= 15 and r.year:
                key = f"{norm(r.title)[:70]}|{r.year}"
                label[key] = f"{r.first_author} {r.year}: {r.title[:70]}"
            else:
                continue
            cites[d["id"]].add(key)

    papers = [d for d in cites if cites[d]]
    counts = Counter(k for ks in cites.values() for k in ks)
    external = {k: n for k, n in counts.items() if not k.startswith("lib:")}
    print(f"{len(papers)} papers with parsed references; {len(counts)} distinct cited works "
          f"({len(counts) - len(external)} in the library, {len(external)} not)")
    multi = {k: n for k, n in external.items() if n >= 2}
    print(f"works cited by 2+ papers that the library lacks: {len(multi)}; by 3+: {sum(1 for n in multi.values() if n >= 3)}")
    for k, n in sorted(multi.items(), key=lambda kv: -kv[1])[:6]:
        print(f"    {n} papers cite  {label[k]}")

    pairs = Counter()
    for a, b in combinations(papers, 2):
        shared = len(cites[a] & cites[b])
        if shared:
            pairs[(a, b)] = shared
    linked = {p for pair in pairs for p in pair}
    print(f"\nbibliographic coupling: {len(pairs)} paper pairs share a reference "
          f"({sum(1 for n in pairs.values() if n >= 3)} share 3+); {len(linked)} of {len(papers)} papers are linked to another")
    for (a, b), n in pairs.most_common(4):
        print(f"    {n} shared: {by_id[a]['title'][:38]!r} <-> {by_id[b]['title'][:38]!r}")
    in_lib = sum(1 for k in counts if k.startswith("lib:"))
    print(f"\nfor comparison, only {in_lib} works are both cited and in the library")


if __name__ == "__main__":
    main()
