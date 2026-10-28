"""Download open-access arXiv papers for the large retrieval eval (eval/large/arxiv/).

Topics match the researcher's own library (financial inclusion, household finance,
transfer entropy, connectedness/spillovers) so the downloads act as realistic, confusable
neighbours rather than easy off-topic noise. Uses the public arXiv API with a 3 s pause
between requests, as arXiv asks. Writes manifest.json listing what was fetched.

Usage: python scripts/fetch_arxiv_eval.py [--per-query 8]
"""

import argparse
import json
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path

import httpx

OUT = Path(__file__).resolve().parents[1] / "eval" / "large" / "arxiv"
API = "https://export.arxiv.org/api/query"
ATOM = {"a": "http://www.w3.org/2005/Atom"}
QUERIES = [
    'all:"transfer entropy" AND (cat:q-fin.ST OR cat:q-fin.GN OR cat:econ.EM OR cat:physics.soc-ph)',
    'all:connectedness AND all:spillover AND (cat:q-fin.ST OR cat:q-fin.RM OR cat:econ.EM OR cat:q-fin.GN)',
    'all:"financial inclusion"',
    'all:"stock market participation" OR (all:household AND all:portfolio AND cat:q-fin.GN)',
    'all:"mobile money" OR all:"digital finance" OR (all:fintech AND all:inclusion)',
]
PAUSE = 3.0


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-query", type=int, default=8)
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    manifest_path = OUT / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}

    with httpx.Client(timeout=60, follow_redirects=True, headers={"User-Agent": "research-companion-eval/0.1"}) as client:
        for query in QUERIES:
            resp = client.get(API, params={"search_query": query, "max_results": args.per_query * 2, "sortBy": "relevance"})
            resp.raise_for_status()
            time.sleep(PAUSE)
            taken = 0
            for entry in ET.fromstring(resp.text).findall("a:entry", ATOM):
                if taken >= args.per_query:
                    break
                arxiv_id = entry.findtext("a:id", namespaces=ATOM).rsplit("/abs/", 1)[-1]
                key = arxiv_id.replace("/", "_")
                pdf_path = OUT / f"{key}.pdf"
                if key in manifest and pdf_path.exists():
                    taken += 1
                    continue
                pdf = client.get(f"https://arxiv.org/pdf/{arxiv_id}")
                time.sleep(PAUSE)
                if pdf.status_code != 200 or not pdf.content.startswith(b"%PDF"):
                    print(f"skip {arxiv_id}: HTTP {pdf.status_code}", file=sys.stderr)
                    continue
                pdf_path.write_bytes(pdf.content)
                manifest[key] = {
                    "id": arxiv_id,
                    "title": " ".join(entry.findtext("a:title", namespaces=ATOM).split()),
                    "query": query,
                    "bytes": len(pdf.content),
                }
                manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
                taken += 1
                print(f"{len(manifest):>3} {arxiv_id:<20} {manifest[key]['title'][:70]}", flush=True)
    total = sum(m["bytes"] for m in manifest.values()) / 1e6
    print(f"done: {len(manifest)} papers, {total:.1f} MB in {OUT}")


if __name__ == "__main__":
    main()
