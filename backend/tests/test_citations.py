import pytest

from app.citations import locate_quote, quote_conflict, source_words
from app.library import Library
from app.providers import MockProvider
from app.settings import Settings

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


# A near match that changes what the source says is not the source's text, however few
# letters differ: the coverage ratio alone scored a dropped "not" as a perfect match.
TRIAL = ("In the trial, the drug did not reduce mortality in older patients, although it shortened "
         "stays by 30% (p < 0.05).12 The effect was insignificant overall.")


@pytest.mark.parametrize("quote, changes, source_says", [
    ("the drug reduced mortality in older patients", "a negation", "the drug did not reduce mortality in older patients"),
    ("the drug did reduce mortality in older patients", "a negation", "the drug did not reduce mortality in older patients"),
    ("reduce mortality in older patients", "a negation", "not reduce mortality in older patients"),
    ("it shortened stays by 40% (p < 0.05)", "a number", "it shortened stays by 30% (p < 0.05)"),
    ("The effect was significant overall", "a word's prefix", "The effect was insignificant overall"),
    ("significant overall", "a word's prefix", "insignificant overall"),
])
def test_a_quote_that_changes_the_meaning_is_not_found(quote, changes, source_says):
    assert locate_quote(quote, TRIAL) is None
    what, start, end = quote_conflict(quote, TRIAL)
    assert what == changes and source_words(TRIAL, start, end) == source_says


def test_a_negation_added_to_the_quote_is_a_change():
    text = "Mobile money increased household savings by 12 percent."
    assert locate_quote("Mobile money did not increase household savings by 12 percent", text) is None
    assert quote_conflict("Mobile money did not increase household savings by 12 percent", text)[0] == "a negation"


@pytest.mark.parametrize("source, quote", [
    ("Die Behandlung hat die Sterblichkeit bei älteren Patienten nicht gesenkt.",
     "Die Behandlung hat die Sterblichkeit bei älteren Patienten gesenkt"),
    ("Le traitement n'a pas réduit la mortalité chez les patients âgés.",
     "Le traitement a réduit la mortalité chez les patients âgés"),
    ("El tratamiento no redujo la mortalidad en los pacientes mayores.",
     "El tratamiento redujo la mortalidad en los pacientes mayores"),
    ("O tratamento não reduziu a mortalidade nos pacientes idosos.",
     "O tratamento reduziu a mortalidade nos pacientes idosos"),
    ("Лечение не снизило смертность у пожилых пациентов.",
     "Лечение снизило смертность у пожилых пациентов"),
    ("研究表明睡眠不影响记忆的巩固过程。", "研究表明睡眠影响记忆的巩固过程"),
    ("この治療は高齢患者の死亡率を下げなかった。", "この治療は高齢患者の死亡率を下げた"),
])
def test_a_negation_left_out_is_caught_in_other_languages(source, quote):
    assert locate_quote(quote, source) is None
    assert quote_conflict(quote, source)[0] == "a negation"


@pytest.mark.parametrize("source, quote, source_says", [
    ("Die Behandlung hat nicht die Sterblichkeit gesenkt.", "die Sterblichkeit gesenkt", "nicht die Sterblichkeit gesenkt"),
    ("Le traitement ne réduit pas la mortalité.", "la mortalité", "pas la mortalité"),
    ("研究表明睡眠不影响记忆的巩固过程。", "影响记忆的巩固过程", "不影响记忆的巩固过程"),
    # Japanese negates at the end of the verb: a quote that stops just before it leaves it out.
    ("この治療は高齢患者の死亡率を下げなかった。", "高齢患者の死亡率を下げ", "高齢患者の死亡率を下げなかった"),
])
def test_a_quote_that_stops_next_to_a_negation_is_caught_in_other_languages(source, quote, source_says):
    what, start, end = quote_conflict(quote, source)
    assert what == "a negation" and source[start:end] == source_says


def test_chinese_and_japanese_quotes_match_exactly_inside_a_run_of_text():
    # No spaces between words: a quote may start and end at any character, not widened to the run.
    chinese = "实验组的记忆效果非常显著，并且持续了三个月以上。"
    start, end, ratio = locate_quote("记忆效果非常显著", chinese)
    assert chinese[start:end] == "记忆效果非常显著" and ratio == 1.0
    # "非常" (very) has 非 in it but isn't a negation: leaving it out isn't reported as one.
    assert quote_conflict("实验组的记忆效果显著，并且持续了三个月以上", chinese) is None


def test_honest_near_matches_in_other_languages_still_match():
    german = "Die Behandlung hat die Sterblichkeit bei älteren Patienten nicht gesenkt."
    assert locate_quote("Die Behandlung hat die Sterblichkiet bei älteren Patienten nicht gesenkt", german)
    french = "Le traitement n'a pas réduit la mortalité chez les patients âgés."
    assert quote_conflict("le traitement n’a pas réduit la mortalité", french) is None


def test_honest_near_matches_still_match():
    # A footnote marker the quote leaves out, an OCR slip, case and spacing are no change of meaning.
    start, end, _ = locate_quote("it shortened stays by 30% (p < 0.05). The effect", TRIAL)
    assert TRIAL[start:end] == "it shortened stays by 30% (p < 0.05).12 The effect"
    assert locate_quote("the drug did not reduce mortalty in older patients", TRIAL)
    assert locate_quote("THE DRUG DID NOT  reduce mortality", TRIAL)
    assert quote_conflict("the drug did not reduce mortality", TRIAL) is None
    # "didn't" and "did not" are the same negation.
    assert locate_quote("the drug didn't reduce mortality in older patients", TRIAL.replace("did not", "didn't"))


def test_a_quote_inside_a_longer_word_is_widened_to_the_word():
    text = "Results held for memory consolidations across nights."
    start, end, _ = locate_quote("memory consolidation across nights", text)
    assert text[start:end] == "memory consolidations across nights"


def test_source_words_join_line_hyphens_and_spaces():
    text = "Sleep aids memory consoli-\ndation\n during  the night."
    start, end, _ = locate_quote("memory consolidation during", text)
    assert source_words(text, start, end) == "memory consolidation during"


def test_a_citation_shows_the_pages_words_and_says_what_a_changed_quote_changes(tmp_path):
    lib = Library(Settings(data_dir=tmp_path / "data"), provider=MockProvider())
    f = tmp_path / "trial.md"
    f.write_text("# A drug trial\n\n" + TRIAL, encoding="utf-8")
    lib.ingest_path(str(f))
    chunk = lib.search("drug mortality older patients", k=1, mode="keyword")[0]["id"]

    slipped = lib.verify_citation("The drug did not lower mortality.", chunk,
                                  "the drug did not reduce mortalty in older patients", judge=False)
    assert slipped["start"] is not None
    assert slipped["quote"] == "the drug did not reduce mortality in older patients"  # the page's spelling

    flipped = lib.verify_citation("The drug lowered mortality.", chunk,
                                  "the drug reduced mortality in older patients", judge=False)
    assert flipped["status"] == "quote_not_found" and flipped["start"] is None
    assert "the drug did not reduce mortality in older patients" in flipped["reason"]
    assert "negation" in flipped["reason"]


def test_a_range_broken_across_a_line_is_one_range_not_one_number():
    # Seen in a real library: "2004-\n12" used to read as "200412", a number the quote lacked.
    text = "in 86 countries over the time period 2004-\n12. Banks differ"
    start, end, ratio = locate_quote("in 86 countries over the time period 2004-12", text)
    assert ratio == 1.0 and source_words(text, start, end) == "in 86 countries over the time period 2004-12"
