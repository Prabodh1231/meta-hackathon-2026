"""Research proposals written from a review's gaps, for one study that addresses them.

The writer picks gaps (kept findings) from one or more review matrices, has Muse suggest the
variables such a study would use and gives each a role, says what they rule out and what they
have to work with, and gets a proposal as a new draft. Two kinds of content are kept apart:

- Background, the gap and how earlier studies measured each variable describe the reviewed
  studies. They cite them, as citations checked against the matrices (blue in the draft), since
  they compare studies or say what none of them did, which no single quote can back.
- Everything from the research questions on is proposed for the new study and cites no one.

Writing takes three model calls: Muse plans one study (title, core question, at most three
research questions, the gaps it leaves out), then reviews each research question against that core
question in a separate call, keeping, revising or removing it, and only then writes the rest of
the proposal around the questions that remain. After writing, the proposal is checked against what
the writer ruled out, and what breaks a rule is reported so it can be written again. Each claim
about the reviewed studies is checked against the rows of the studies it cites; an earlier measure
the matrices don't state is dropped rather than left in red. The proposal is kept as a matrix finding (kind
"proposal") holding the rows of all its matrices, so its citations can be checked again later.
"""

import re
from concurrent.futures import ThreadPoolExecutor

from .matrix import MAX_TABLE, _snapshot, union_snapshot
from .providers import activity

ROLES = ("independent", "dependent", "mediator", "moderator", "control")
ROLE_LABELS = {"independent": "Independent", "dependent": "Dependent", "mediator": "Mediator",
               "moderator": "Moderator", "control": "Control"}
CHECKS_AT_ONCE = 4
# "RQ1: …", "H2. …", "Research question 3 – …": the draft numbers its lists itself.
_LABEL = re.compile(r"^\s*(?:RQ|Q|H|Hypothesis|Research question)\s*\d+[a-z]?\s*[:.)\-–—]\s*", re.I)
NOTE = ("Background, the gap and how the reviewed studies measured each variable cite your review "
        "matrices and are checked against them. Everything from the research questions on is "
        "proposed for this study, so it cites no one.")


def _study_text(rows: list[dict], keys: dict[int, str], quotes: bool = True) -> str:
    """One line per study, named as the model is to cite it: '[Alonso et al. 2021] "Title": Column: answer ["quote"] | …'."""
    def val(v: dict) -> str:
        text = v["value"] or ("unknown" if v["key"].split(":")[-1].startswith("@") else "not reported")
        return f'{text} ["{v["quote"][:400]}"]' if quotes and v["quote"] else text
    return "\n".join(f'[{keys[r["doc_id"]]}] "{r["title"][:90]}": '
                     + " | ".join(f"{v['label']}: {val(v)}" for v in r["values"]) for r in rows)


def _keys(rows: list[dict]) -> dict[int, str]:
    """Each study's name for citing: its label ("Alonso et al. 2021"), made unique when two share one.
    Names, not ids like "S6": a model cites a study by the name it writes, and an id it misremembers
    silently pins a claim on the wrong study."""
    out, seen = {}, {}
    for r in rows:
        base = (r["label"] or r["title"][:40] or "Study").replace("[", "(").replace("]", ")")
        seen[base] = seen.get(base, 0) + 1
        out[r["doc_id"]] = base if seen[base] == 1 else f"{base} ({seen[base]})"
    return out


def _walk(node: dict):
    yield node
    for child in node.get("content") or []:
        yield from _walk(child)


class Proposals:
    def __init__(self, lib, matrices):
        self.lib = lib
        self.matrices = matrices

    # ---------- what the proposal draws on ----------

    def _sources(self, matrix_ids: list[int], finding_ids: list[int]) -> tuple[list[dict], list[dict], list[dict]]:
        """The matrices (a chosen gap brings its own), the chosen gaps, and the papers' rows."""
        mids = list(dict.fromkeys(matrix_ids))
        gaps = []
        for fid in dict.fromkeys(finding_ids):
            f = self.matrices.finding(fid)
            gaps.append(f)
            if f["matrix_id"] is not None and f["matrix_id"] not in mids:
                mids.append(f["matrix_id"])
        if not mids:
            raise ValueError("Choose at least one review matrix")
        ms = [self.matrices.get(i) for i in mids]
        for m in ms:
            if m["pending"]:
                raise ValueError(f"Wait for “{m['name']}” to finish reading its papers")
        rows = union_snapshot([(m["id"], m["name"], _snapshot(m)) for m in ms])
        if not rows:
            raise ValueError("The chosen matrices have no papers yet")
        return ms, gaps, rows

    @staticmethod
    def _tables(rows: list[dict]) -> tuple[str, dict[str, dict]]:
        """The matrices as text for the model, and each study's row by its name (lower case)."""
        keys = _keys(rows)
        text = _study_text(rows, keys)
        if len(text) > MAX_TABLE:  # a large review: the answers, without the quotes behind them
            text = _study_text(rows, keys, quotes=False)
        return text, {keys[r["doc_id"]].lower(): r for r in rows}

    @staticmethod
    def _gap_text(gaps: list[dict]) -> str:
        return "\n".join(f"- {g['title']}. {g['text']} (from “{g['matrix_name']}”)" for g in gaps)

    @staticmethod
    def _study_refs(refs: list[str], by_key: dict[str, dict]) -> list[dict]:
        """The rows the model's study names name, each once; names it made up are dropped."""
        out = []
        for ref in refs:
            row = by_key.get(str(ref).strip("[] ").lower())
            if row and row not in out:
                out.append(row)
        return out

    @staticmethod
    def _clean(text: str) -> str:
        """Text without bracket references. A trailing one ("…in 2020 [S6][Alonso et al. 2021].") goes:
        the citations follow the text. One that is part of the sentence ("[Alonso et al. 2021] find…")
        loses only its brackets, or the sentence would lose its subject."""
        text = re.sub(r"\s*\[S\d+\]", "", text)
        text = re.sub(r"(?:\s*\[[^\[\]]{1,80}\])+(?=\s*(?:[.;,:)]|$))", "", text)
        text = re.sub(r"\[([^\[\]]{1,80})\]", r"\1", text)
        return re.sub(r"\s+([.,;:])", r"\1", re.sub(r"\s{2,}", " ", text)).strip()

    # ---------- suggesting variables ----------

    def variables(self, matrix_ids: list[int], finding_ids: list[int], focus: str = "") -> list[dict]:
        """Variables a study addressing the gaps would use, each with a suggested role and how the
        reviewed studies measured it: [{name, role, why, measures: [{doc_id, label, how}]}]."""
        _, gaps, rows = self._sources(matrix_ids, finding_ids)
        if not gaps and not focus.strip():
            raise ValueError("Choose a gap, or say what the study should be about")
        tables, by_key = self._tables(rows)
        out = []
        for v in self.lib.provider.propose_variables(tables, self._gap_text(gaps), focus.strip()):
            name = str(v.get("name", "")).strip()
            if not name:
                continue
            measures = []
            for m in v.get("measures") or []:
                row = by_key.get(str(m.get("study", "")).strip("[] ").lower())
                how = str(m.get("how", "")).strip()
                if row and how:
                    measures.append({"doc_id": row["doc_id"], "label": row["label"], "how": how})
            out.append({"name": name, "role": v.get("role") if v.get("role") in ROLES else "independent",
                        "why": str(v.get("why", "")).strip(), "measures": measures})
        return out[:12]

    # ---------- writing ----------

    def write(self, matrix_ids: list[int], finding_ids: list[int], variables: list[dict], focus: str = "",
              exclusions: str = "", resources: str = "", avoid: list[dict] | None = None) -> dict:
        """The proposal as editor content for a new draft, with what breaks the writer's exclusions."""
        ms, gaps, rows = self._sources(matrix_ids, finding_ids)
        if not gaps and not focus.strip():
            raise ValueError("Choose a gap, or say what the study should be about")
        tables, by_key = self._tables(rows)
        chosen = [v for v in variables if str(v.get("name", "")).strip() and v.get("role") in ROLES]
        var_text = self._var_text(chosen)
        avoid_text = "\n".join(f"- {a.get('rule', '')}: {a.get('why', '')}" for a in avoid or [])
        gap_text, focus = self._gap_text(gaps), focus.strip()
        brief = (gap_text, exclusions.strip(), resources.strip(), avoid_text)

        # The dialog shows each step as it starts (GET /model/activity), since writing takes minutes.
        # 1. Plan one study. 2. Review its questions against its core question, separately.
        activity.note("stage", "Step 1 of 5: planning one study from the gaps.")
        plan = self._plan(self.lib.provider.plan_proposal(tables, gap_text, focus, var_text, exclusions.strip(),
                                                          resources.strip(), avoid_text), chosen)
        activity.note("stage", "Step 2 of 5: reviewing the research questions against the core question.")
        review = self.lib.provider.review_questions(self._plan_text(plan))
        plan, question_review = self._apply_review(plan, review)
        # 3. Write the rest around the questions that remain.
        activity.note("stage", "Step 3 of 5: writing the proposal.")
        raw = self.lib.provider.write_proposal(tables, self._plan_text(plan), *brief)
        p = self._normalize(raw, by_key, plan)

        violations = []
        activity.note("stage", "Step 4 of 5: checking it against what you ruled out and against the matrices.")
        if exclusions.strip():
            violations = [{"rule": str(v.get("rule", "")).strip(), "section": str(v.get("section", "")).strip(),
                           "why": str(v.get("why", "")).strip()}
                          for v in self.lib.provider.check_exclusions(exclusions.strip(), self._proposed_text(p))]

        names = ", ".join(m["name"] for m in ms)
        with self.lib.lock, self.lib.conn:
            fid = self.matrices._save_finding(ms[0]["id"], names, "proposal", p["title"],
                                              "\n".join(p["research_questions"]), [], [], rows,
                                              matrix_ids=[m["id"] for m in ms])
        checks = self._check(fid, p)
        activity.note("stage", "Step 5 of 5: rewriting paragraphs the matrices don't back.")
        repaired = self._repair(fid, p, checks, rows)
        removed = self._drop_unstated_measures(p, checks)
        doc = self._doc(fid, p, checks)
        statuses = [n["attrs"]["status"] for n in _walk(doc) if n.get("type") == "citation"]
        return {"finding": fid, "title": p["title"], "doc": doc, "research_questions": p["research_questions"],
                "hypotheses": p["hypotheses"], "violations": violations, "matrices": names,
                "left_out": p["left_out"], "flagged": self._flagged(p, checks), "question_review": question_review,
                "removed": removed, "repaired": repaired, "core_question": p["core_question"],
                "citations": {"verified": statuses.count("verified"),
                              "flagged": sum(s != "verified" for s in statuses)}}

    def _flagged(self, p: dict, checks: dict[str, dict]) -> list[dict]:
        """Claims about the reviewed studies the matrices don't back, with why, in the draft's order."""
        claims = [("Background", c["text"], c["rows"]) for c in p["background"]]
        claims += [("The gap", c["text"], c["rows"]) for c in p["gap"]]
        claims += [("Variables", self._measure_claim(v, e), [e["row"]]) for v in p["variables"] for e in v["earlier"]]
        out = []
        for section, claim, rows in claims:
            check = checks.get(claim)
            if rows and check and check["status"] != "verified":
                out.append({"section": section, "claim": claim, "status": check["status"], "reason": check["reason"],
                            "studies": [r["label"] for r in rows]})
        return out

    @staticmethod
    def _var_text(variables: list[dict]) -> str:
        return "\n".join(f"- {v['name'].strip()} ({v['role']})"
                         + (f"; measured as: {v['measure'].strip()}" if str(v.get("measure") or "").strip() else "")
                         for v in variables)

    @staticmethod
    def _items(values) -> list[str]:
        return [t for t in (_LABEL.sub("", str(x)).strip() for x in values or []) if t]

    def _plan(self, raw: dict, chosen: list[dict]) -> dict:
        """The planned study: the writer's own measures stay with the variables the plan keeps."""
        measures = {v["name"].strip().lower(): str(v.get("measure") or "").strip() for v in chosen}
        variables = [{"name": str(v.get("name", "")).strip(), "role": v.get("role"),
                      "measure": measures.get(str(v.get("name", "")).strip().lower(), "")}
                     for v in raw.get("variables") or [] if str(v.get("name", "")).strip() and v.get("role") in ROLES]
        core = str(raw.get("core_question") or "").strip()
        return {
            "title": str(raw.get("title") or "").strip() or "Research proposal",
            "core_question": core,
            "research_questions": self._items(raw.get("research_questions")) or ([core] if core else []),
            "hypotheses": self._items(raw.get("hypotheses")),
            "variables": variables or [{**v, "measure": str(v.get("measure") or "").strip()} for v in chosen],
            "left_out": [{"gap": str(g.get("gap", "")).strip(), "why": str(g.get("why", "")).strip()}
                         for g in raw.get("left_out") or [] if str(g.get("gap", "")).strip()],
        }

    def _plan_text(self, plan: dict) -> str:
        return (f"Title: {plan['title']}\n\nCore question: {plan['core_question']}\n\n"
                "Research questions:\n" + "\n".join(f"- {q}" for q in plan["research_questions"]) + "\n\n"
                + ("Hypotheses:\n" + "\n".join(f"- {h}" for h in plan["hypotheses"]) + "\n\n" if plan["hypotheses"] else "")
                + "Variables:\n" + self._var_text(plan["variables"]))

    def _apply_review(self, plan: dict, review: dict) -> tuple[dict, list[dict]]:
        """The questions the review keeps or revises (at most 3, at least the core question), its
        hypotheses, and what it changed, for the writer to see."""
        kept, changes = [], []
        for q in review.get("questions") or []:
            verdict = q.get("verdict") if q.get("verdict") in ("keep", "revise", "remove") else "keep"
            original = _LABEL.sub("", str(q.get("original", ""))).strip()
            text = _LABEL.sub("", str(q.get("text", ""))).strip() or original
            if verdict != "remove" and text:
                kept.append(text)
            if verdict != "keep":
                changes.append({"original": original, "verdict": verdict, "text": text if verdict == "revise" else "",
                                "why": str(q.get("why", "")).strip()})
        title = str(review.get("title") or "").strip() or plan["title"]
        core = str(review.get("core_question") or "").strip() or plan["core_question"]
        if (title, core) != (plan["title"], plan["core_question"]):
            changes.insert(0, {"original": plan["core_question"], "verdict": "core", "text": core,
                               "title_before": plan["title"], "title": title,
                               "why": str(review.get("core_changed_why") or "").strip()})
            plan = {**plan, "title": title, "core_question": core}
        if not review.get("questions"):  # no question review came back: the plan's questions stand
            return plan, changes
        kept = list(dict.fromkeys(kept))[:3] or ([plan["core_question"]] if plan["core_question"] else plan["research_questions"][:1])
        hypotheses = self._items(review.get("hypotheses")) if any(c["verdict"] != "core" for c in changes) else plan["hypotheses"]
        return {**plan, "research_questions": kept, "hypotheses": hypotheses[:len(kept)]}, changes

    def _normalize(self, raw: dict, by_key: dict[str, dict], plan: dict) -> dict:
        def paras(key):
            return self._items(raw.get(key))

        def cited(key):
            out = []
            for c in raw.get(key) or []:
                text = self._clean(str(c.get("text", "")))
                if text:
                    out.append({"text": text, "rows": self._study_refs(c.get("studies") or [], by_key)})
            return out
        variables = []
        for v in raw.get("variables") or []:
            earlier = []
            for e in v.get("earlier") or []:
                row = by_key.get(str(e.get("study", "")).strip("[] ").lower())
                if row and str(e.get("how", "")).strip():
                    earlier.append({"row": row, "how": str(e["how"]).strip()})
            if str(v.get("name", "")).strip():
                variables.append({"name": str(v["name"]).strip(), "role": v.get("role") if v.get("role") in ROLES else "",
                                  "measure": str(v.get("measure", "")).strip(), "earlier": earlier})
        return {
            "title": plan["title"], "core_question": plan["core_question"],
            "research_questions": plan["research_questions"], "hypotheses": plan["hypotheses"],
            "left_out": plan["left_out"],
            "background": cited("background"), "gap": cited("gap"),
            "variables": variables or [{**v, "earlier": []} for v in plan["variables"]],
            "design": paras("design"), "data": paras("data"), "analysis": paras("analysis"),
            "contribution": paras("contribution"), "limitations": paras("limitations"),
            "timeline": [{"when": str(t.get("when", "")).strip(), "what": str(t.get("what", "")).strip()}
                         for t in raw.get("timeline") or [] if str(t.get("what", "")).strip()],
        }

    def _repair(self, fid: int, p: dict, checks: dict[str, dict], rows: list[dict]) -> list[dict]:
        """One pass at the background and gap paragraphs the matrices don't back: Muse rewrites each
        from the rows it cites and the reason the check gave, the rewrite is checked, and it replaces
        the paragraph only if it fares better. A paragraph nothing can be saved of, and that the rows
        contradict, is dropped. Returns what changed, for the writer to see."""
        flagged = [(key, c) for key in ("background", "gap") for c in p[key]
                   if c["rows"] and checks.get(c["text"], {}).get("status") in ("weak", "unsupported")]
        if not flagged:
            return []
        keys = _keys(rows)
        items = [{"claim": c["text"], "reason": checks[c["text"]]["reason"], "rows": _study_text(c["rows"], keys)}
                 for _, c in flagged]
        try:
            rewrites = self.lib.provider.repair_claims(items)
        except Exception:  # noqa: BLE001 - the draft keeps its flagged paragraphs, in amber or red
            return []
        rank = {"verified": 3, "weak": 2, "unsupported": 1, "pending": 0}
        out, drop = [], []
        for (key, c), rewrite in zip(flagged, rewrites):
            before = checks[c["text"]]
            rewrite = self._clean(rewrite)
            if not rewrite:
                if before["status"] == "unsupported":
                    drop.append((key, c))
                    out.append({"section": key, "before": c["text"], "after": "", "status": "removed", "reason": before["reason"]})
                continue
            try:
                r = self.matrices.check_finding(fid, rewrite, [row["doc_id"] for row in c["rows"]])
            except Exception:  # noqa: BLE001
                continue
            if rank[r["status"]] > rank[before["status"]]:
                out.append({"section": key, "before": c["text"], "after": rewrite, "status": r["status"], "reason": r["reason"]})
                checks[rewrite] = {"status": r["status"], "reason": r["reason"]}
                c["text"] = rewrite
        for key, c in drop:
            p[key].remove(c)
        return out

    def _drop_unstated_measures(self, p: dict, checks: dict[str, dict]) -> list[dict]:
        """Earlier measures the matrices don't state are taken out of the variables table: they come
        from the model's general knowledge, not the review. Returned so the writer sees what went."""
        removed = []
        for v in p["variables"]:
            keep = []
            for e in v["earlier"]:
                claim = self._measure_claim(v, e)
                check = checks.get(claim)
                if check and check["status"] == "unsupported":
                    removed.append({"claim": claim, "reason": check["reason"], "study": e["row"]["label"]})
                else:
                    keep.append(e)
            v["earlier"] = keep
        return removed

    @staticmethod
    def _proposed_text(p: dict) -> str:
        """What the proposal proposes, for the exclusions check."""
        parts = [p["title"], "Research questions:", *p["research_questions"], "Hypotheses:", *p["hypotheses"],
                 "Variables and how this study measures them:", *(f"{v['name']}: {v['measure']}" for v in p["variables"])]
        for key in ("design", "data", "analysis", "limitations"):
            parts += [f"{key.title()}:", *p[key]]
        parts += ["Timeline:", *(f"{t['when']}: {t['what']}" for t in p["timeline"])]
        return "\n".join(parts)

    def _check(self, fid: int, p: dict) -> dict[str, dict]:
        """Each claim about the reviewed studies, checked against the matrices: {claim: {status, reason}}."""
        claims = {c["text"]: [r["doc_id"] for r in c["rows"]] for key in ("background", "gap") for c in p[key] if c["rows"]}
        claims.update({self._measure_claim(v, e): [e["row"]["doc_id"]] for v in p["variables"] for e in v["earlier"]})

        def one(item):
            claim, doc_ids = item
            try:  # against the rows of the studies it cites: precise, and never cut off by the size of the review
                r = self.matrices.check_finding(fid, claim, doc_ids)
                return claim, {"status": r["status"], "reason": r["reason"]}
            except Exception:  # noqa: BLE001 - left for Recheck all citations
                return claim, {"status": "pending", "reason": ""}
        with ThreadPoolExecutor(max_workers=CHECKS_AT_ONCE) as pool:
            return dict(pool.map(one, claims.items()))

    @staticmethod
    def _measure_claim(v: dict, e: dict) -> str:
        return f"In {e['row']['label']}, {v['name']} was measured as: {e['how']}"

    # ---------- the draft ----------

    def _doc(self, fid: int, p: dict, checks: dict[str, dict]) -> dict:
        n = 0

        def text(t, italic=False):
            node = {"type": "text", "text": t}
            return {**node, "marks": [{"type": "italic"}]} if italic else node

        def chip(row, claim):
            nonlocal n
            n += 1
            check = checks.get(claim) or {"status": "pending", "reason": ""}
            return {"type": "citation", "attrs": {
                "cid": f"pr{fid}-{n}", "chunkId": None, "docId": row["doc_id"], "page": None, "start": None, "end": None,
                "quote": "", "claim": claim, "label": row["label"], "status": check["status"], "reason": check["reason"],
                "finding": fid}}

        def para(*nodes):
            return {"type": "paragraph", "content": [x for x in nodes if x]}

        def cited(t, rows, claim=None):
            nodes = [text(t + " ")]
            for i, r in enumerate(rows):
                nodes += [chip(r, claim or t)] + ([text(" ")] if i < len(rows) - 1 else [])
            return para(*nodes)

        def heading(t, level=2):
            return {"type": "heading", "attrs": {"level": level}, "content": [text(t)]}

        def listing(items):
            return {"type": "orderedList", "content": [{"type": "listItem", "content": [para(text(i))]} for i in items]}

        def table(header, rows):
            def cell(kind, content):
                return {"type": kind, "content": content or [para()]}
            out = [{"type": "tableRow", "content": [cell("tableHeader", [para(text(h))]) for h in header]}]
            out += [{"type": "tableRow", "content": [cell("tableCell", c) for c in r]} for r in rows]
            return {"type": "table", "content": out}

        blocks = [heading(p["title"], 1), para(text(NOTE, italic=True))]
        for key, title in (("background", "Background"), ("gap", "The gap")):
            if p[key]:
                blocks += [heading(title), *(cited(c["text"], c["rows"]) for c in p[key])]
        if p["research_questions"]:
            blocks += [heading("Research questions"), listing(p["research_questions"])]
        if p["hypotheses"]:
            blocks += [heading("Hypotheses"), listing(p["hypotheses"])]
        if p["variables"]:
            rows = []
            for v in p["variables"]:
                earlier = [cited(f"{e['row']['label']}: {e['how']}", [e["row"]], self._measure_claim(v, e))
                           for e in v["earlier"]] or [para(text("Not measured in the reviewed studies"))]
                rows.append([[para(text(v["name"]))], [para(text(ROLE_LABELS.get(v["role"], "")))], earlier,
                             [para(text(v["measure"]))]])
            blocks += [heading("Variables"),
                       table(["Variable", "Role", "In the reviewed studies", "In this study"], rows)]
        for key, title in (("design", "Design"), ("data", "Data"), ("analysis", "Analysis"),
                           ("contribution", "Contribution"), ("limitations", "Limitations")):
            if p[key]:
                blocks += [heading(title), *(para(text(t)) for t in p[key])]
        if p["timeline"]:
            blocks += [heading("Timeline"),
                       table(["When", "What"], [[[para(text(t["when"]))], [para(text(t["what"]))]] for t in p["timeline"]])]
        return {"type": "doc", "content": blocks}
