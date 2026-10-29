"""Compare local reference-field parsing with Muse reading the same entries (uses the Muse API).

    python scripts/muse_refparse_trial.py PATH/TO/library.db "Title prefix 1" "Title prefix 2" ...

The entries are split locally; Muse only reads the fields of each entry, so the output stays small.
"""

import json
import sqlite3
import sys
import time
from difflib import SequenceMatcher
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.providers import make_provider  # noqa: E402
from app.refparse import find_section, norm, parse_references  # noqa: E402
from app.settings import Settings  # noqa: E402

SYSTEM = (
    "Each numbered line is one entry from a paper's reference list, extracted from a PDF, so it may "
    "contain line-break artifacts, a running page header, or two entries glued together. For each "
    "entry give: its number n; the first author's surname; the publication year as an integer, or "
    "null; the title of the cited work exactly as printed, without the journal or publisher (an empty "
    "string if the entry is not a bibliographic reference); and the DOI if printed, else an empty string."
)
SCHEMA = {
    "type": "object",
    "properties": {
        "entries": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "n": {"type": "integer"},
                    "surname": {"type": "string"},
                    "year": {"type": ["integer", "null"]},
                    "title": {"type": "string"},
                    "doi": {"type": "string"},
                },
                "required": ["n", "surname", "year", "title", "doi"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["entries"],
    "additionalProperties": False,
}
BATCH = 40


def main() -> None:
    db, prefixes = sys.argv[1], sys.argv[2:]
    conn = sqlite3.connect(db)
    provider = make_provider(Settings.from_env())
    print("provider:", provider.name)
    dump = []
    total = {"entries": 0, "title_same": 0, "year_same": 0, "doi_local": 0, "doi_muse": 0, "empty_muse": 0,
             "calls": 0, "secs": 0.0, "in_chars": 0, "out_chars": 0}
    for prefix in prefixes:
        row = conn.execute("SELECT id, title FROM documents WHERE title LIKE ? AND kind = 'pdf'", (prefix + "%",)).fetchone()
        if not row:
            print("no such document:", prefix)
            continue
        text = "\n".join(p[0] for p in conn.execute("SELECT text FROM pages WHERE doc_id = ? ORDER BY page", (row[0],)))
        refs = parse_references(text)
        diffs = []
        empties = []
        for start in range(0, len(refs), BATCH):
            batch = refs[start : start + BATCH]
            user = "\n".join(f"{i + 1}. {r.raw[:600]}" for i, r in enumerate(batch))
            t = time.time()
            out = provider._json(SYSTEM, user, SCHEMA, max_tokens=4000)
            total["secs"] += time.time() - t
            total["calls"] += 1
            total["in_chars"] += len(SYSTEM) + len(user)
            total["out_chars"] += len(json.dumps(out))
            by_n = {e["n"]: e for e in out.get("entries", [])}
            for i, r in enumerate(batch):
                e = by_n.get(i + 1)
                total["entries"] += 1
                if not e:
                    continue
                total["empty_muse"] += not e["title"]
                dump.append({"paper": row[1][:40], "raw": r.raw, "local": {"title": r.title, "year": r.year, "doi": r.doi}, "muse": e})
                total["doi_local"] += bool(r.doi)
                total["doi_muse"] += bool(e["doi"])
                total["year_same"] += (r.year == e["year"])
                a, b = norm(r.title), norm(e["title"])
                # agree if equal enough, or one is the other plus trailing journal text
                same = bool(a) and bool(b) and (SequenceMatcher(None, a, b).ratio() >= 0.9 or a.startswith(b) or b.startswith(a))
                total["title_same"] += same
                if not e["title"] and len(empties) < 6:
                    empties.append(r.raw[:140])
                if not same and len(diffs) < 4:
                    diffs.append((r.raw[:110], r.title[:70], e["title"][:70]))
        print(f"\n{row[1][:60]}: {len(refs)} entries")
        for raw, local, muse in diffs:
            print(f"   entry : {raw!r}\n   local : {local!r}\n   muse  : {muse!r}")
    if len(sys.argv) and (out := __import__("os").environ.get("TRIAL_DUMP")):
        Path(out).write_text(json.dumps(dump, ensure_ascii=False, indent=1), encoding="utf-8")
    n = total["entries"]
    print(f"\n{n} entries, {total['calls']} Muse calls, {total['secs']:.0f}s total ({total['secs'] / max(total['calls'], 1):.1f}s per call)")
    print(f"approx tokens (chars/4): in {total['in_chars'] // 4}, out {total['out_chars'] // 4} "
          f"=> {total['in_chars'] // 4 // max(n, 1)} in + {total['out_chars'] // 4 // max(n, 1)} out per entry")
    print(f"title agrees with local parser: {total['title_same'] / n:.0%}; year agrees: {total['year_same'] / n:.0%}; "
          f"DOI found: local {total['doi_local']}, Muse {total['doi_muse']}; entries Muse called non-references: {total['empty_muse']}")


if __name__ == "__main__":
    main()
