from app.paper_meta import extract, extract_jel, extract_keywords, jel_area


def test_inline_keywords_split_on_semicolons():
    text = "Abstract. We study things.\nKeywords: financial inclusion; mobile money; Sub-Saharan Africa\n\n1. Introduction"
    assert extract_keywords(text) == ["financial inclusion", "mobile money", "sub-saharan africa"]


def test_comma_separated_keywords_and_key_words_spelling():
    assert extract_keywords("Key words: stock market, household finance, participation.") == [
        "stock market", "household finance", "participation",
    ]


def test_wrapped_keyword_lines_are_joined_and_stop_at_the_next_section():
    text = (
        "Keywords: digital finance; central bank digital\ncurrency; cross-bor-\nder payments\n"
        "JEL Classification: E42, G28\nIntroduction\nMore text; with semicolons"
    )
    assert extract_keywords(text) == ["digital finance", "central bank digital currency", "cross-border payments"]


def test_index_terms_with_a_dash():
    assert extract_keywords("Index Terms—blockchain, smart contracts, consensus") == [
        "blockchain", "smart contracts", "consensus",
    ]


def test_keywords_and_jel_on_one_line():
    text = "Keywords: fintech; regulation JEL: G18, G28"
    assert extract_keywords(text) == ["fintech", "regulation"]
    assert extract_jel(text) == ["G18", "G28"]


def test_no_keywords_is_empty_not_a_guess():
    assert extract_keywords("Abstract. Keywords matter in search. This paper has no list.") == []
    assert extract("Just a page of text.") == ([], [])


def test_jel_code_formats():
    assert extract_jel("JEL classification: G21, O16, G23") == ["G21", "O16", "G23"]
    assert extract_jel("JEL Codes: C58; E44 and G12") == ["C58", "E44", "G12"]
    assert extract_jel("JEL: D14\nG51") == ["D14", "G51"]
    assert extract_jel("JEL codes G21 G28 O16") == ["G21", "G28", "O16"]


def test_jel_needs_the_label_and_a_real_area():
    assert extract_jel("Table 3 reports C58 and G21 for firms.") == []
    assert extract_jel("JEL classification: X99, G21") == ["G21"]
    assert extract_jel("JEL: G21 G21 G21") == ["G21"]


def test_jel_area_names_the_top_level_field():
    assert jel_area("G21") == "Financial Economics"
    assert jel_area("O16").startswith("Economic Development")
    assert jel_area("X1") == ""


def test_one_keyword_per_line_elsevier_layout():
    text = "Keywords:\nBitcoin \nConfidence\nCryptocurrencies\nA B S T R A C T\nAlthough previous studies, however, show"
    assert extract_keywords(text) == ["bitcoin", "confidence", "cryptocurrencies"]
    assert extract_keywords("Keywords:\nStock market participation\nEducation\na b s t r a c t\nWe study") == [
        "stock market participation", "education",
    ]


def test_acm_style_headings():
    text = "Additional Key Words and Phrases: Call Detail Records, Mobile Money, M-Pesa\nACM Reference format:\nSimone"
    assert extract_keywords(text) == ["call detail records", "mobile money", "m-pesa"]
    assert extract_keywords("ACM Classification Keywords\nH.5.2 User Interfaces\nAuthor Keywords\nMobile money; user adoption\nINTRODUCTION") == [
        "mobile money", "user adoption",
    ]


def test_ligatures_are_normalised():
    assert extract_keywords("Keywords: asymmetric e\ufb00ects; \ufb01nancial inclusion") == [
        "asymmetric effects", "financial inclusion",
    ]
    assert extract_jel("JEL classi\ufb01cation : C18; C58; F31") == ["C18", "C58", "F31"]


def test_jel_codes_one_per_line_and_nber_style():
    assert extract_jel("JEL classification:\nD91\nG11\nD83\nKeywords:\nPortfolio choice") == ["D91", "G11", "D83"]
    assert extract_jel("JEL No. E2, G1\nABSTRACT") == ["E2", "G1"]
