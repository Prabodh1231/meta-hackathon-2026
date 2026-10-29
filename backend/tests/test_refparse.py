from app.refparse import find_section, match_reference, parse_entry, parse_references, split_entries

DOCS = [
    {"id": 1, "title": "Financial literacy and stock market participation", "authors": ["Maarten Van Rooij"], "year": 2011, "doi": "10.1016/j.jfineco.2011.03.006"},
    {"id": 2, "title": "Trusting the Stock Market", "authors": ["Luigi Guiso"], "year": 2008, "doi": ""},
    {"id": 3, "title": "Reading notes", "authors": [], "year": None, "doi": ""},
]


def section(body: str) -> str:
    return "Some paper text.\n" * 40 + "\nReferences\n" + body


def test_the_section_starts_at_the_last_references_heading_and_stops_at_an_appendix():
    text = "References are discussed above.\n" * 5 + "\n7. References\n" + "Smith, J. (2020). A title here. Journal, 1(1), 1-2.\n" * 8 + "\nAppendix A\nTable 1"
    found = find_section(text)
    assert found.startswith("Smith, J. (2020)") and "Appendix" not in found
    assert find_section("no list here at all") == ""
    assert find_section("V. REFERENCES\n" + "Smith, J. (2020). A title here. Journal, 1(1), 1-2.\n" * 8) != ""


def test_numbered_lists_split_on_their_markers_and_ignore_page_ranges():
    body = (
        "[1] Chen, A. 2018. Coordination event detection. ACM Trans. Knowl. Discov. 12(3), 1-30.\n"
        "[2] Doe, B. and Roe, C. 2019. A second paper on\ncausal inference. J. Stat. 4, 100-\n120.\n"
        "[3] Poe, E. 2020. Third. Proc. VLDB 13, 5-6.\n"
    )
    entries = split_entries(body)
    assert [n for n, _ in entries] == [1, 2, 3]
    assert "causal inference" in entries[1][1] and "100-120" in entries[1][1]


def test_author_year_lists_split_at_each_author_and_survive_unicode_hyphens():
    body = (
        "Gomes, F. J., Kotlikoff, L. J., & Viceira, L. M. (2008). Optimal life-cycle investing with flexible\n"
        "labor supply. American Economic Review, 98(2), 297-303.\n"
        "Viceira, L. M. (2001). Optimal portfolio choice. The Journal of Finance, 56(2), 433-470.\n"
        "Vissing‐Jørgensen, A. (2002). Limited asset market participation. Journal of Political Economy, 110(4), 825-853.\n"
    )
    assert len(split_entries(find_section(section(body)) or body)) == 3


def test_initials_first_and_given_name_first_entries_split():
    body = (
        "A. Akerman, I. Gaarder, and M. Mogstad. The skill complementarity of broadband\ninternet. Quarterly Journal of Economics, 130(4):1781-1824, 2015.\n"
        "A. Vissing-Jørgensen. Limited asset market participation. Journal of Political Economy, 110(4):825-853, 2002.\n"
        "Vissing-Jorgensen Annette, 2003. Perspectives on behavioral finance. NBER Macro Annual 18, 139-194.\n"
    )
    assert len(split_entries(body)) == 3


def test_fields_are_read_in_each_common_style():
    apa = parse_entry("Chai, J., & Maurer, R. (2012). Experience, loss aversion, narrow framing: Can we explain the evidence? Journal of X, 3(1), 1-9. https://doi.org/10.1000/xyz123.")
    assert (apa.year, apa.first_author, apa.doi) == (2012, "Chai", "10.1000/xyz123")
    assert apa.title.startswith("Experience, loss aversion") and apa.title.endswith("evidence?")
    acm = parse_entry("Leo Breiman. 2001. Random Forests. Machine Learning 45 (2001), 5-32.")
    assert (acm.year, acm.title) == (2001, "Random Forests")  # the first year, not the volume's
    end = parse_entry("V. Bogan. Stock Market Participation and the Internet. Journal of Finance, 43(1):191-211, 2008.")
    assert end.title == "Stock Market Participation and the Internet"
    chicago = parse_entry("Mankiw, Gregory, and Stephen Zeldes, “The Consumption of Stockholders and Nonstockholders,” Journal of Financial Economics 29 (1991), 97-112.")
    assert chicago.title == "The Consumption of Stockholders and Nonstockholders"


def test_a_quote_from_a_glued_on_entry_is_not_taken_as_the_title():
    glued = parse_entry("Vissing-Jorgensen, Annette, 2002. Limited asset market participation. Journal of Political Economy 110, 825-853. Smith, J., 2003. On ‘irrationality' in markets. Journal of X 1, 1-2.")
    assert glued.title == "Limited asset market participation"


def test_tables_after_the_list_are_not_references():
    body = (
        "Smith, J. (2020). A real reference with a title. Journal of X, 1(1), 1-2.\n"
        "Doe, B. (2019). Another real reference here. Journal of Y, 2(2), 3-4.\n"
        "Poe, E. (2018). A third real reference entry. Journal of Z, 3(3), 5-6.\n"
        "Panel A shows estimates of the IV model (3)-(4) as well as the reduced form model (1).\n"
        "A. Equity Market Participation -.15 -.1 -.05 0 .05 .1 .15 2001 2002 2003 2004 2005 2006\n"
    )
    assert len(parse_references(section(body))) == 3


def test_matching_by_doi_then_by_a_title_that_stands_alone():
    by_doi = parse_entry("Van Rooij, M. (2011). Something retitled entirely. J. Fin. Econ. https://doi.org/10.1016/J.JFINECO.2011.03.006")
    assert (m := match_reference(by_doi, DOCS)) and (m.doc_id, m.how) == (1, "doi")
    cited = parse_entry("Guiso, L., Sapienza, P., Zingales, L., 2008. Trusting the stock market. The Journal of Finance 63, 2557-2600.")
    m = match_reference(cited, DOCS)
    assert m and m.doc_id == 2 and m.how == "title+author"


def test_longer_titles_that_merely_contain_a_library_title_do_not_match():
    for raw in (
        "Kanagaretnam, K., Lee, J., 2022. Trusting the stock market: Further evidence from IPOs around the world. Journal of Banking & Finance 1, 1-2.",
        "Bucher-Koenen, T., et al. (2012). Fearless woman: Financial literacy and stock market participation. Technical report.",
        "Sivaramakrishnan, S. (2017). Attitudinal factors, financial literacy, and stock market participation. International Journal 5, 1-2.",
    ):
        assert match_reference(parse_entry(raw), DOCS) is None


def test_a_paper_cannot_cite_one_published_after_it_and_short_titles_never_match():
    cited = parse_entry("Guiso, L., 2008. Trusting the stock market. The Journal of Finance 63, 2557-2600.")
    assert match_reference(cited, DOCS, citing_year=2005) is None
    assert match_reference(cited, DOCS, citing_year=2009).doc_id == 2
    assert match_reference(parse_entry("Anon (2020). Reading notes. Journal 1, 1-2."), DOCS) is None
