from app.references import format_references


def test_entities_and_bogus_doi_are_cleaned():
    doc = {
        "title": "Stock market participation puzzle",
        "authors": ["N. K. Otinga"],
        "year": 2024,
        "venue": "Cogent Business &amp; Management",
        "doi": "Not Provided in Text",
        "url": "",
    }
    (entry,) = format_references([doc], "apa")
    assert "&amp;" not in entry and "Cogent Business & Management" in entry
    assert "doi.org" not in entry


def test_real_doi_is_kept_and_prefix_stripped():
    doc = {"title": "T", "authors": ["A B"], "year": 2020, "doi": "https://doi.org/10.1016/j.physa.2022.126983"}
    (entry,) = format_references([doc], "apa")
    assert entry.count("https://doi.org/10.1016/j.physa.2022.126983") == 1
