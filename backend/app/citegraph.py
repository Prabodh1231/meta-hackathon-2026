"""The citation network: who cites whom in the library, which papers share references, and
which works many papers cite that the library lacks. Edges come from the papers' own reference
lists (see refparse), never from embeddings."""

from collections import Counter, defaultdict
from itertools import combinations

from .refparse import Reference, match_reference, norm

MIN_GHOST_CITERS = 2  # a work the library lacks becomes a node once this many papers cite it
MIN_GHOST_TITLE = 15  # shorter parsed titles are usually fragments, not works


def _clean(text: str) -> str:
    """PDF text can carry lone surrogates and C1 control characters; neither belongs in a title shown to the user."""
    text = text.encode("utf-8", "ignore").decode("utf-8")
    return "".join(ch for ch in text if ch >= " " and not "" <= ch <= "").strip()


def ghost_key(ref: Reference) -> str | None:
    """A stable identity for a cited work that is not in the library, or None when the entry
    is too thin to tell works apart."""
    title = norm(ref.title)
    if len(title) < MIN_GHOST_TITLE or not ref.year:
        return None
    return f"{title[:70]}|{ref.year}"


def build_graph(docs: list[dict], refs_by_doc: dict[int, list[Reference]]) -> dict:
    """docs: dicts with id/title/authors/year/doi. Returns nodes, citation edges, coupling edges
    and the missing-works list. Matching is recomputed here, so a corrected title or a newly
    added paper changes the edges without re-reading any PDF."""
    by_id = {d["id"]: d for d in docs}
    cites: dict[int, dict[str, str]] = defaultdict(dict)  # citing doc -> {work key: how it matched}
    ghosts: dict[str, dict] = {}
    for doc_id, refs in refs_by_doc.items():
        doc = by_id.get(doc_id)
        if not doc:
            continue
        for ref in refs:
            m = match_reference(ref, docs, doc.get("year"), doc_id)
            if m:
                cites[doc_id].setdefault(f"doc:{m.doc_id}", m.how)
                continue
            key = ghost_key(ref)
            if key:
                ghosts.setdefault(f"ghost:{key}", {"title": _clean(ref.title), "first_author": _clean(ref.first_author), "year": ref.year})
                cites[doc_id].setdefault(f"ghost:{key}", "unresolved")

    citers = Counter(k for works in cites.values() for k in works if k.startswith("ghost:"))
    shown = {k for k, n in citers.items() if n >= MIN_GHOST_CITERS}

    cited_by_count: Counter = Counter()
    cites_count: Counter = Counter()  # edges drawn from each paper, not every entry it lists
    edges = []
    for doc_id, works in cites.items():
        for key, how in works.items():
            if key.startswith("ghost:") and key not in shown:
                continue
            edges.append({"source": f"doc:{doc_id}", "target": key, "kind": "cites", "how": how})
            cited_by_count[key] += 1
            cites_count[doc_id] += 1

    # Bibliographic coupling: two papers that cite the same works are about the same thing, even
    # when neither cites the other. Counts every shared work, library or not.
    coupling = []
    for a, b in combinations(sorted(cites), 2):
        shared = len(cites[a].keys() & cites[b].keys())
        if shared:
            coupling.append({"source": f"doc:{a}", "target": f"doc:{b}", "kind": "coupled", "weight": shared})

    nodes = [
        {
            "id": f"doc:{d['id']}", "kind": "paper", "doc_id": d["id"], "title": d["title"],
            "authors": d.get("authors") or [], "year": d.get("year"),
            "cites": cites_count[d["id"]], "cited_by": cited_by_count[f"doc:{d['id']}"],
            "parsed": d["id"] in refs_by_doc and bool(refs_by_doc[d["id"]]),
        }
        for d in docs
    ]
    missing = []
    for key in shown:
        g = ghosts[key]
        node = {"id": key, "kind": "missing", "title": g["title"], "authors": [g["first_author"]] if g["first_author"] else [],
                "year": g["year"], "cites": 0, "cited_by": citers[key]}
        nodes.append(node)
        missing.append(node)
    missing.sort(key=lambda n: (-n["cited_by"], n["title"]))

    linked = {e["source"] for e in edges + coupling} | {e["target"] for e in edges + coupling}
    return {
        "nodes": nodes, "citations": edges, "coupling": coupling, "missing": missing,
        "isolated": [n["doc_id"] for n in nodes if n["kind"] == "paper" and n["id"] not in linked],
    }
