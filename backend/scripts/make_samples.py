"""Generate a small, deliberately messy demo corpus in ../samples (two research themes,
mixed formats). Usage: python scripts/make_samples.py"""

from pathlib import Path

import docx
import fitz
from pptx import Presentation

OUT = Path(__file__).resolve().parents[2] / "samples"

PAPERS = {
    "chen2021_sleep_tmr.pdf": [
        """Targeted Memory Reactivation During Slow-Wave Sleep
Alice Chen, Bob Martinez
Journal of Sleep Research, 2021. doi: 10.5555/jsr.2021.0147

Abstract. We tested whether replaying learning-associated sounds during slow-wave sleep strengthens declarative memory.
In 120 adults, targeted memory reactivation during slow-wave sleep improved recall of word pairs by 18% relative to a control night.
The benefit was largest for items that were weakly learned before sleep.""",
        """Results. Sleep spindle density in the two seconds after each cue predicted whether the cued item was remembered the next morning.
Reactivation delivered during REM sleep produced no measurable benefit.
These findings suggest that spindles gate the reactivation of hippocampal memory traces during slow-wave sleep.""",
    ],
    "okafor2019_reef_acclimation.pdf": [
        """Thermal History Shapes Coral Bleaching Responses
Dana Okafor, Priya Raman
Marine Ecology Progress Series, 2019. doi: 10.5555/meps.2019.0062

Abstract. Marine heatwaves in 2016 and 2017 caused mass coral bleaching across the Great Barrier Reef.
Reefs that had experienced moderate heat stress in 2016 showed 31% lower bleaching mortality in 2017.
This pattern suggests thermal acclimation can partly buffer corals against repeated heatwaves.""",
        """Discussion. Acclimation benefits disappeared when heat stress exceeded eight degree heating weeks.
Ocean warming projections imply that severe bleaching events will occur annually on most reefs by 2050, outpacing acclimation.""",
    ],
}

NOTES_MD = """# Reading notes: sleep & memory

- Chen 2021 says TMR only works in slow-wave sleep, not REM.
- Spindles seem to be the gate: density after the cue predicts recall.
- Question for chapter 2: does spindle density decline with age, and does TMR still work in older adults?

Sleep spindles are bursts of 11-16 Hz oscillatory activity during non-REM sleep.
"""

FIELD_TXT = """Fieldwork log, Heron Island, March 2024

Coral bleaching was visible on shallow reef flats after the marine heatwave.
Temperature loggers recorded ocean warming of two degrees above the seasonal mean for three weeks.
Branching Acropora colonies bleached first; massive Porites colonies were mostly unaffected.
"""


def pdf(path: Path, pages: list[str]) -> None:
    doc = fitz.open()
    for text in pages:
        doc.new_page().insert_textbox(fitz.Rect(56, 56, 540, 790), text, fontsize=10.5)
    doc.save(path)


def main() -> None:
    OUT.mkdir(exist_ok=True)
    for name, pages in PAPERS.items():
        pdf(OUT / name, pages)
    (OUT / "sleep_reading_notes.md").write_text(NOTES_MD, encoding="utf-8")
    (OUT / "heron_island_fieldwork.txt").write_text(FIELD_TXT, encoding="utf-8")

    d = docx.Document()
    d.core_properties.title = "Draft outline: ageing and sleep-dependent memory"
    d.core_properties.author = "Researcher"
    d.add_heading("Draft outline: ageing and sleep-dependent memory", 1)
    d.add_paragraph("Older adults show reduced slow-wave sleep and fewer sleep spindles than young adults.")
    d.add_paragraph("If spindles gate memory reactivation, targeted memory reactivation may be less effective with age.")
    d.save(OUT / "chapter2_outline.docx")

    prs = Presentation()
    for title, body in [
        ("Lab meeting: reef resilience", "Okafor 2019 acclimation result; Heron Island observations"),
        ("Open questions", "Does acclimation persist beyond eight degree heating weeks? Which taxa bleach first?"),
    ]:
        slide = prs.slides.add_slide(prs.slide_layouts[1])
        slide.shapes.title.text = title
        slide.placeholders[1].text = body
    prs.save(OUT / "lab_meeting_reefs.pptx")
    print(f"Wrote samples to {OUT}")


if __name__ == "__main__":
    main()
