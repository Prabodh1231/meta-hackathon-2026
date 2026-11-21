from app.citations import locate_quote

PAGE = ("the cat sat on the mat. " + "x" * 300 +
        " Results show that consolidation of memory occurs during slow wave sleep in adults")


def test_stray_match_early_on_the_page_does_not_hide_the_quote():
    # "the" at the top of the page used to stretch the match over the page, so it was rejected.
    quote = "Thee results show that consolidation of memory occurs during slow wave sleep in adults"
    start, end, ratio = locate_quote(quote, PAGE)
    assert PAGE[start:end].strip() == PAGE[PAGE.index("Results"):]
    assert ratio >= 0.85


def test_scattered_pieces_are_still_not_a_match():
    page = "consolidation " + "y" * 400 + " of memory " + "z" * 400 + " during sleep"
    assert locate_quote("consolidation of memory during sleep", page) is None


def test_word_hyphenated_across_a_line_break_matches_exactly():
    text = "Sleep aids memory consoli-\ndation during the night."
    start, end, ratio = locate_quote("memory consolidation during", text, fuzzy=False)
    assert ratio == 1.0 and text[start:end] == "memory consoli-\ndation during"


def test_ligatures_and_minus_signs_match_exactly():
    text = "An eﬃcient oﬀer with −2 dB gain."
    start, end, _ = locate_quote("efficient offer with -2 dB", text, fuzzy=False)
    assert text[start:end] == "eﬃcient oﬀer with −2 dB"
