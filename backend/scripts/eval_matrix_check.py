"""How well the matrix check (judge_against_matrix) judges sentences written from a review matrix.

A four-study matrix on mobile money, in the exact text form the app sends (answers with the quotes
behind them), and sentences of the kinds Find gaps and Write from this matrix produce: comparisons,
gaps, overstatements and contradictions, each with the verdict a careful reviewer would give.

    python scripts/eval_matrix_check.py                 # the model the app is set up for (.env / environment)
    python scripts/eval_matrix_check.py --runs 3        # each sentence three times, to see how stable it is
    python scripts/eval_matrix_check.py --compare-quote # also judge each against one study's quote, as before
    python scripts/eval_matrix_check.py --provider mock # the offline mock, to try the script itself
    python scripts/eval_matrix_check.py --save          # write eval/matrix_check_results.json

It reads RC_PROVIDER, MUSE_API_KEY / BASETEN_API_KEY and MUSE_ROUTE like the app (environment first,
then the data folder's .env). Nothing is stored in the library.
"""

import argparse
import json
import sys
import time
from collections import Counter
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.matrix import _table_text  # noqa: E402
from app.providers import make_provider  # noqa: E402
from app.settings import Settings  # noqa: E402

TOPIC = "Mobile money and household finance"


def study(doc_id, label, title, year, sample, setting, method, findings, limitations):
    cols = [("sample", "Sample", sample), ("setting", "Setting", setting), ("method", "Method", method),
            ("findings", "Findings", findings), ("limitations", "Limitations", limitations)]
    values = [{"key": k, "label": lab, "value": a, "quote": q} for k, lab, (a, q) in cols]
    values.append({"key": "@year", "label": "Year", "value": str(year), "quote": ""})
    return {"doc_id": doc_id, "label": label, "title": title, "values": values}


# Rows as Matrices._snapshot builds them: (answer, quote) per column, "" for not reported.
ROWS = [
    study(1, "Wanjiru 2019", "Mobile money and household savings in rural Kenya", 2019,
          ("412 farm households", "Our sample is 412 farm households drawn from three counties."),
          ("Rural Kenya, 2015–2018", "The survey was conducted in rural Kenya between 2015 and 2018."),
          ("Household panel regression with fixed effects", "We estimate a panel regression with household fixed effects."),
          ("Mobile money raised household savings by 12%", "Mobile money adoption increased household savings by 12 percent."),
          ("Self-reported savings; short period", "Savings are self-reported and the period covered is short.")),
    study(2, "Rao 2021", "Digital payments and small-firm growth in Indian cities", 2021,
          ("1,200 small firms", "The sample consists of 1,200 small firms."),
          ("Mumbai and Delhi, India, 2016–2020", "Firms were observed in Mumbai and Delhi from 2016 to 2020."),
          ("Difference-in-differences around the 2016 demonetisation",
           "We use a difference-in-differences design around the 2016 demonetisation."),
          ("Firms adopting digital payments grew sales 9% faster",
           "Firms that adopted digital payments grew sales 9 percent faster than non-adopters."),
          ("Urban firms only", "Our sample covers urban firms only, so results may not extend to rural areas.")),
    study(3, "Mensah 2017", "Does mobile money help households save? Evidence from Ghana", 2017,
          ("830 households", "We surveyed 830 households."),
          ("Ghana, 2012–2014", "Data were collected in Ghana between 2012 and 2014."),
          ("Cross-sectional survey with propensity score matching",
           "We match users and non-users with propensity scores in a cross-sectional survey."),
          ("No significant effect of mobile money on savings",
           "We find no statistically significant effect of mobile money use on household savings."),
          ("Cross-sectional data cannot establish causality",
           "Being cross-sectional, the data cannot establish a causal effect.")),
    study(4, "Okoro 2022", "A mobile savings account for women entrepreneurs: a field experiment in Lagos", 2022,
          ("2,400 women entrepreneurs", "We enrolled 2,400 women entrepreneurs."),
          ("Lagos, Nigeria, 2019–2021", "The experiment ran in Lagos, Nigeria, from 2019 to 2021."),
          ("Randomized controlled trial of a mobile savings account",
           "Participants were randomly assigned to receive a mobile savings account."),
          ("Savings rose 18% among treated women", "Savings rose by 18 percent among women offered the account."),
          ("", "")),
]

# (sentence, expected, also acceptable, the study whose findings quote a single-quote check would use)
CASES = [
    # Supported: comparisons and gaps the table backs.
    ("Studies in Kenya and Nigeria report higher savings after mobile money adoption (Wanjiru, 2019; Okoro, 2022).",
     "supported", set(), 1),
    ("Evidence on savings is mixed: Wanjiru and Okoro find increases, while Mensah finds no significant effect.",
     "supported", set(), 1),
    ("Only one of the four studies is a randomized controlled trial.", "supported", set(), 4),
    ("None of the studies examines rural India.", "supported", set(), 2),
    ("All four studies are set in Africa or South Asia; none covers Latin America.", "supported", set(), 1),
    ("The largest sample is Okoro's 2,400 women entrepreneurs.", "supported", set(), 4),
    ("Both studies published after 2020 report positive effects, though one covers only urban firms.",
     "supported", set(), 2),
    # Overstated: true for some studies, stated for all, or one number wrong.
    ("All four studies find that mobile money increases savings.", "partial", {"unsupported"}, 1),
    ("Mobile money raised savings by 12% in Kenya and by 25% in Nigeria.", "partial", {"unsupported"}, 1),
    ("The studies consistently name self-reported data as a limitation.", "partial", {"unsupported"}, 1),
    # Unsupported: contradicted or not in the table.
    ("Mensah (2017) finds that mobile money doubled household savings in Ghana.", "unsupported", set(), 3),
    ("The studies agree that digital finance has no effect on firm sales.", "unsupported", set(), 2),
    ("Several of the studies examine mobile money's effect on health spending.", "unsupported", set(), 1),
    ("None of the studies uses a randomized controlled trial.", "unsupported", set(), 4),
    ("Rao (2021) studied rural Kenyan farmers.", "unsupported", set(), 2),
]


def findings_quote(doc_id: int) -> str:
    row = next(r for r in ROWS if r["doc_id"] == doc_id)
    return next(v["quote"] for v in row["values"] if v["key"] == "findings")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--provider", help="mock or muse (default: as the app is set up)")
    ap.add_argument("--runs", type=int, default=1, help="times to judge each sentence")
    ap.add_argument("--compare-quote", action="store_true", help="also judge each sentence against one study's quote")
    ap.add_argument("--save", action="store_true", help="write eval/matrix_check_results.json")
    args = ap.parse_args()

    settings = Settings.from_env()
    if args.provider:
        settings = replace(settings, provider=args.provider)
    try:
        provider = make_provider(settings)
    except ValueError as e:
        sys.exit(f"{e}. Set RC_PROVIDER=muse and MUSE_API_KEY (or BASETEN_API_KEY) in the environment or in "
                 f"{settings.data_dir / '.env'}, or try the script with --provider mock.")
    table = _table_text(ROWS, quotes=True)
    print(f"Provider: {settings.provider}{' (' + settings.route + ')' if settings.provider == 'muse' else ''}")
    print(f"Matrix: {len(ROWS)} studies, {len(table)} characters; {len(CASES)} sentences × {args.runs} run(s)\n")

    results, exact, acceptable, flips, seconds = [], 0, 0, 0, []
    for sentence, expected, also, quote_doc in CASES:
        verdicts, reasons = [], []
        for _ in range(args.runs):
            t = time.time()
            out = provider.judge_against_matrix(sentence, TOPIC, table)
            seconds.append(time.time() - t)
            verdicts.append(out["verdict"])
            reasons.append(str(out.get("reason", "")).strip())
        got = Counter(verdicts).most_common(1)[0][0]
        exact += got == expected
        acceptable += got == expected or got in also
        flips += len(set(verdicts)) > 1
        row = {"sentence": sentence, "expected": expected, "acceptable": sorted({expected, *also}),
               "verdicts": verdicts, "reason": reasons[0]}
        if args.compare_quote:
            row["one_quote"] = provider.judge_support(sentence, findings_quote(quote_doc))["verdict"]
        results.append(row)
        mark = "ok " if got == expected else ("~  " if got in also else "XX ")
        extra = f"  [one quote: {row['one_quote']}]" if args.compare_quote else ""
        print(f"{mark}{expected:>11} → {'/'.join(verdicts):<11}{extra}  {sentence}")
        print(f"{'':>17}{reasons[0][:160]}")

    n = len(CASES)
    print(f"\nExact: {exact}/{n}   Acceptable: {acceptable}/{n}"
          + (f"   Unstable across runs: {flips}/{n}" if args.runs > 1 else "")
          + f"   Median time: {sorted(seconds)[len(seconds) // 2]:.1f} s")
    if args.compare_quote:
        right = sum(r["one_quote"] == r["expected"] or r["one_quote"] in r["acceptable"] for r in results)
        supported = [r for r in results if r["expected"] == "supported"]
        print(f"One-quote check, for comparison: acceptable {right}/{n}; "
              f"supported sentences it called supported: {sum(r['one_quote'] == 'supported' for r in supported)}/{len(supported)}")
    if args.save:
        out = Path(__file__).resolve().parents[1] / "eval" / "matrix_check_results.json"
        out.write_text(json.dumps({"provider": settings.provider, "runs": args.runs, "exact": exact,
                                   "acceptable": acceptable, "cases": results}, indent=2), encoding="utf-8")
        print(f"Saved {out}")


if __name__ == "__main__":
    main()
