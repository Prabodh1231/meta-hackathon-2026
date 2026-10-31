"""Research proposals written from a review's gaps, for one study that addresses them.

The writer picks gaps (kept findings) from one or more review matrices, has Muse suggest the
variables such a study would use and gives each a role, says what they rule out and what they
have to work with, and gets a proposal as a new draft. Two kinds of content are kept apart:

- Background, the gap and how earlier studies measured each variable describe the reviewed
  studies. They cite them, as citations checked against the matrices (blue in the draft), since
  they compare studies or say what none of them did, which no single quote can back.
- Everything from the research questions on is proposed for the new study and cites no one.

After writing, the proposal is checked against what the writer ruled out, and what breaks a rule
is reported so it can be written again. The proposal is kept as a matrix finding (kind
"proposal") holding the rows of all its matrices, so its citations can be checked again later.
"""

from concurrent.futures import ThreadPoolExecutor

from .matrix import MAX_TABLE, _snapshot, union_snapshot

ROLES = ("independent", "dependent", "mediator", "moderator", "control")
ROLE_LABELS = {"independent": "Independent", "dependent": "Dependent", "mediator": "Mediator",
               "moderator": "Moderator", "control": "Control"}
CHECKS_AT_ONCE = 4
NOTE = ("Background, the gap and how the reviewed studies measured each variable cite your review "
        "matrices and are checked against them. Everything from the research questions on is "
        "proposed for this study, so it cites no one.")


def _study_text(rows: list[dict], ids: dict[int, str], quotes: bool = True) -> str:
    """One line per study, with its id for the model to cite: "[S1] Label (title): Column: answer [quote] | …"."""
    def val(v: dict) -> str:
        text = v["value"] or ("unknown" if v["key"].split(":")[-1].startswith("@") else "not reported")
        return f'{text} ["{v["quote"][:400]}"]' if quotes and v["quote"] else text
    return "\n".join(f"[{ids[r['doc_id']]}] {r['label']} ({r['title'][:90]}): "
                     + " | ".join(f"{v['label']}: {val(v)}" for v in r["values"]) for r in rows)


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
    def _tables(rows: list[dict]) -> tuple[str, dict[int, str]]:
        ids = {r["doc_id"]: f"S{i + 1}" for i, r in enumerate(rows)}
        text = _study_text(rows, ids)
        if len(text) > MAX_TABLE:  # a large review: the answers, without the quotes behind them
            text = _study_text(rows, ids, quotes=False)
        return text, ids

    @staticmethod
    def _gap_text(gaps: list[dict]) -> str:
        return "\n".join(f"- {g['title']}. {g['text']} (from “{g['matrix_name']}”)" for g in gaps)

    @staticmethod
    def _study_refs(refs: list[str], by_id: dict[str, dict]) -> list[dict]:
        """The rows a model's study ids name, each once; ids it made up are dropped."""
        out = []
        for ref in refs:
            row = by_id.get(str(ref).strip("[] "))
            if row and row not in out:
                out.append(row)
        return out

    # ---------- suggesting variables ----------

    def variables(self, matrix_ids: list[int], finding_ids: list[int], focus: str = "") -> list[dict]:
        """Variables a study addressing the gaps would use, each with a suggested role and how the
        reviewed studies measured it: [{name, role, why, measures: [{doc_id, label, how}]}]."""
        _, gaps, rows = self._sources(matrix_ids, finding_ids)
        if not gaps and not focus.strip():
            raise ValueError("Choose a gap, or say what the study should be about")
        tables, ids = self._tables(rows)
        by_id = {ids[r["doc_id"]]: r for r in rows}
        out = []
        for v in self.lib.provider.propose_variables(tables, self._gap_text(gaps), focus.strip()):
            name = str(v.get("name", "")).strip()
            if not name:
                continue
            measures = []
            for m in v.get("measures") or []:
                row = by_id.get(str(m.get("study", "")).strip("[] "))
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
        tables, ids = self._tables(rows)
        by_id = {ids[r["doc_id"]]: r for r in rows}
        chosen = [v for v in variables if str(v.get("name", "")).strip() and v.get("role") in ROLES]
        var_text = "\n".join(f"- {v['name'].strip()} ({v['role']})"
                             + (f"; measured as: {v['measure'].strip()}" if str(v.get("measure") or "").strip() else "")
                             for v in chosen)
        avoid_text = "\n".join(f"- {a.get('rule', '')}: {a.get('why', '')}" for a in avoid or [])
        raw = self.lib.provider.write_proposal(tables, self._gap_text(gaps), focus.strip(), var_text,
                                               exclusions.strip(), resources.strip(), avoid_text)
        p = self._normalize(raw, by_id)

        violations = []
        if exclusions.strip():
            violations = [{"rule": str(v.get("rule", "")).strip(), "section": str(v.get("section", "")).strip(),
                           "why": str(v.get("why", "")).strip()}
                          for v in self.lib.provider.check_exclusions(exclusions.strip(), self._proposed_text(p))]

        names = ", ".join(m["name"] for m in ms)
        with self.lib.lock, self.lib.conn:
            fid = self.matrices._save_finding(ms[0]["id"], names, "proposal", p["title"],
                                              "\n".join(p["research_questions"]), [], [], rows,
                                              matrix_ids=[m["id"] for m in ms])
        doc = self._doc(fid, p, self._check(fid, p))
        statuses = [n["attrs"]["status"] for n in _walk(doc) if n.get("type") == "citation"]
        return {"finding": fid, "title": p["title"], "doc": doc, "research_questions": p["research_questions"],
                "hypotheses": p["hypotheses"], "violations": violations, "matrices": names,
                "citations": {"verified": statuses.count("verified"),
                              "flagged": sum(s != "verified" for s in statuses)}}

    def _normalize(self, raw: dict, by_id: dict[str, dict]) -> dict:
        def paras(key):
            return [t for t in (str(x).strip() for x in raw.get(key) or []) if t]

        def cited(key):
            return [{"text": str(c.get("text", "")).strip(), "rows": self._study_refs(c.get("studies") or [], by_id)}
                    for c in raw.get(key) or [] if str(c.get("text", "")).strip()]
        variables = []
        for v in raw.get("variables") or []:
            earlier = []
            for e in v.get("earlier") or []:
                row = by_id.get(str(e.get("study", "")).strip("[] "))
                if row and str(e.get("how", "")).strip():
                    earlier.append({"row": row, "how": str(e["how"]).strip()})
            if str(v.get("name", "")).strip():
                variables.append({"name": str(v["name"]).strip(), "role": v.get("role") if v.get("role") in ROLES else "",
                                  "measure": str(v.get("measure", "")).strip(), "earlier": earlier})
        return {
            "title": str(raw.get("title") or "").strip() or "Research proposal",
            "background": cited("background"), "gap": cited("gap"),
            "research_questions": paras("research_questions"), "hypotheses": paras("hypotheses"),
            "variables": variables, "design": paras("design"), "data": paras("data"), "analysis": paras("analysis"),
            "contribution": paras("contribution"), "limitations": paras("limitations"),
            "timeline": [{"when": str(t.get("when", "")).strip(), "what": str(t.get("what", "")).strip()}
                         for t in raw.get("timeline") or [] if str(t.get("what", "")).strip()],
        }

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
        claims = [c["text"] for key in ("background", "gap") for c in p[key] if c["rows"]]
        claims += [self._measure_claim(v, e) for v in p["variables"] for e in v["earlier"]]
        claims = list(dict.fromkeys(claims))

        def one(claim):
            try:
                r = self.matrices.check_finding(fid, claim)
                return claim, {"status": r["status"], "reason": r["reason"]}
            except Exception:  # noqa: BLE001 - left for Recheck all citations
                return claim, {"status": "pending", "reason": ""}
        with ThreadPoolExecutor(max_workers=CHECKS_AT_ONCE) as pool:
            return dict(pool.map(one, claims))

    @staticmethod
    def _measure_claim(v: dict, e: dict) -> str:
        return f"{e['row']['label']} measured {v['name']}: {e['how']}"

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
