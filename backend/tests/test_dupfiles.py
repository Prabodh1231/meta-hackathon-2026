import random
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import dupfiles
from app.embeddings import HashEmbedder
from app.library import Library
from app.main import create_app
from app.providers import MockProvider
from app.settings import Settings


def prose(seed: int, words: int = 260) -> str:
    """Made-up text whose words no other seed shares, so unrelated documents overlap by nothing."""
    rng = random.Random(seed)
    vocab = ["".join(rng.choice("bcdfghklmnprstvz") + rng.choice("aeiou") for _ in range(3)) + str(seed) for _ in range(400)]
    out = []
    for i in range(words):
        out.append(rng.choice(vocab))
        if i % 12 == 11:
            out[-1] += "."
    return " ".join(out)


@pytest.fixture
def lib(tmp_path):
    return Library(Settings(data_dir=tmp_path / "data"), provider=MockProvider(), embedder=HashEmbedder())


@pytest.fixture
def client(lib):
    return TestClient(create_app(lib.settings, lib))


def ingest(client, folder: Path) -> dict[str, int]:
    results = client.post("/ingest/path", json={"path": str(folder)}).json()["results"]
    assert all(r["ok"] for r in results), results
    return {Path(r["source"]).name: r["document"]["id"] for r in results}


def groups_of(report, kind):
    return [g for g in report["groups"] if g["kind"] == kind]


def ids(group):
    return {d["id"] for d in group["docs"]}


def test_normalize_text_ignores_harmless_formatting():
    a = "Memory consoli-\ndation doesn’t   “depend” on\n\nsleep — or does it?"
    b = 'memory consolidation DOESN\'T "depend" on sleep - or does it?'
    assert dupfiles.normalize_text(a) == dupfiles.normalize_text(b)
    assert dupfiles.normalize_text("ﬁnding") == "finding"  # ligature


def test_each_kind_of_duplicate_is_labelled_separately(client, tmp_path):
    lib_dir = tmp_path / "papers"
    (lib_dir / "copies").mkdir(parents=True)
    exact = "Exact paper\n\n" + prose(1)
    (lib_dir / "exact.txt").write_text(exact, encoding="utf-8")
    (lib_dir / "copies" / "exact (1).txt").write_text(exact, encoding="utf-8")

    same = "Sleep and memory consolidation\n\n" + prose(2) + " We don't know why consolidation happens."
    (lib_dir / "same_a.txt").write_text(same, encoding="utf-8")
    reformatted = same.upper().replace("'", "’").replace("CONSOLIDATION HAPPENS", "CONSOLI-\nDATION   HAPPENS")
    (lib_dir / "same_b.txt").write_text(reformatted, encoding="utf-8")

    preprint = "Reef acclimation preprint\n\n" + prose(3)
    (lib_dir / "preprint.txt").write_text(preprint, encoding="utf-8")
    (lib_dir / "published.txt").write_text(preprint + "\n\nAdded in revision. " + prose(4, 30), encoding="utf-8")

    reused = prose(5)
    (lib_dir / "report_2019.txt").write_text("Annual report one\n\n" + reused + " " + prose(6, 40), encoding="utf-8")
    (lib_dir / "report_2020.txt").write_text("Annual report two\n\n" + reused + " " + prose(7, 40), encoding="utf-8")

    (lib_dir / "doi_a.txt").write_text("Thermal tolerance in corals\n\n" + prose(8), encoding="utf-8")
    (lib_dir / "doi_b.txt").write_text("Thermal tolerance in corals (accepted manuscript)\n\n" + prose(9), encoding="utf-8")
    (lib_dir / "unrelated.txt").write_text("Something else entirely\n\n" + prose(10), encoding="utf-8")

    doc = ingest(client, lib_dir)
    client.patch(f"/documents/{doc['report_2019.txt']}", json={"doi": "10.1000/report.2019"})
    client.patch(f"/documents/{doc['report_2020.txt']}", json={"doi": "10.1000/report.2020"})
    client.patch(f"/documents/{doc['doi_a.txt']}", json={"doi": "10.5555/coral.42"})
    client.patch(f"/documents/{doc['doi_b.txt']}", json={"doi": "https://doi.org/10.5555/CORAL.42"})

    r = client.post("/library/duplicates", json={}).json()

    [g] = groups_of(r, "exact_file")
    assert ids(g) == {doc["exact.txt"], doc["exact (1).txt"]}
    size = (lib_dir / "exact.txt").stat().st_size
    assert g["recoverable"] == size and all(d["size"] == size for d in g["docs"])
    assert {Path(d["source"]).parent.name for d in g["docs"]} == {"papers", "copies"}  # both locations shown

    [g] = groups_of(r, "same_text")
    assert ids(g) == {doc["same_a.txt"], doc["same_b.txt"]}
    assert "identical text" in g["explanation"] and "may not be the same" in g["explanation"]

    likely = {frozenset(ids(g)): g for g in groups_of(r, "likely_same")}
    assert set(likely) == {frozenset({doc["preprint.txt"], doc["published.txt"]}),
                           frozenset({doc["doi_a.txt"], doc["doi_b.txt"]})}
    assert likely[frozenset({doc["preprint.txt"], doc["published.txt"]})]["similarity"] >= 80
    assert any(x.startswith("Same DOI") for x in likely[frozenset({doc["doi_a.txt"], doc["doi_b.txt"]})]["reasons"])

    # Most of the text is shared, but different DOIs say these are different papers.
    [g] = groups_of(r, "similar")
    assert ids(g) == {doc["report_2019.txt"], doc["report_2020.txt"]}
    assert any(x.startswith("Different DOIs") for x in g["reasons"])

    flagged = set().union(*(ids(g) for g in r["groups"]))
    assert doc["unrelated.txt"] not in flagged
    assert r["counts"] == {"exact_file": 1, "same_text": 1, "likely_same": 2, "similar": 1}
    same_sizes = [(lib_dir / n).stat().st_size for n in ("same_a.txt", "same_b.txt")]
    kept = next(x for x in groups_of(r, "same_text")[0]["docs"] if x["id"] == groups_of(r, "same_text")[0]["keep"])
    assert r["recoverable"]["identical"] == size + sum(same_sizes) - kept["size"]
    assert r["recoverable"]["likely_same"] > 0


def test_a_paper_in_several_folders_is_not_a_duplicate(client, tmp_path):
    d = tmp_path / "one"
    d.mkdir()
    (d / "paper.txt").write_text("Digital finance and inclusion\n\n" + prose(11), encoding="utf-8")
    [doc_id] = ingest(client, d).values()
    for name in ("Digital finance", "Inclusion"):
        client.post("/folders", json={"name": name, "similarity": 100})
    client.post(f"/documents/{doc_id}/folders", json={"name": "Digital finance"})
    client.post(f"/documents/{doc_id}/folders", json={"name": "Inclusion"})
    assert len(client.get(f"/documents/{doc_id}").json()["folders"]) == 2
    r = client.post("/library/duplicates", json={}).json()
    assert r["groups"] == [] and r["recoverable"] == {"identical": 0, "likely_same": 0}


def test_keep_suggestion_prefers_the_cited_copy_and_scan_never_deletes(client, tmp_path):
    d = tmp_path / "pair"
    d.mkdir()
    text = "A paper\n\n" + prose(12)
    (d / "first.txt").write_text(text, encoding="utf-8")
    (d / "second.txt").write_text(text, encoding="utf-8")
    doc = ingest(client, d)

    [g] = client.post("/library/duplicates", json={}).json()["groups"]
    assert g["keep"] == min(doc.values()) and g["keep_reason"] == "it was imported first"

    [g] = client.post("/library/duplicates", json={"cited": [max(doc.values())]}).json()["groups"]
    assert g["keep"] == max(doc.values()) and g["keep_reason"] == "your draft cites it"
    assert (d / "first.txt").exists() and (d / "second.txt").exists()
    assert len(client.get("/documents").json()) == 2


def test_missing_files_and_cached_hashes(client, lib, tmp_path):
    d = tmp_path / "gone"
    d.mkdir()
    text = "Vanishing paper\n\n" + prose(13)
    (d / "a.txt").write_text(text, encoding="utf-8")
    (d / "b.txt").write_text(text, encoding="utf-8")
    ingest(client, d)
    client.post("/library/duplicates", json={})
    assert lib.conn.execute("SELECT COUNT(*) FROM file_hashes").fetchone()[0] == 2

    (d / "b.txt").unlink()
    r = client.post("/library/duplicates", json={}).json()
    assert r["missing"] == 1 and not groups_of(r, "exact_file")
    [g] = groups_of(r, "same_text")  # the text is still in the library
    missing = next(x for x in g["docs"] if not x["exists"])
    assert missing["size"] is None and g["keep"] != missing["id"] and g["keep_reason"] == "the other file is missing"
    assert g["recoverable"] == 0
