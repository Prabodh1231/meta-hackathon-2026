# Review task: test Research Companion and mark it

You are one reviewer on an AI review panel. Other AI models are testing the same app with the same goals and marking it on the same scale, and the marks are compared. Test the app yourself, in a browser, as a first-time user. Nobody explains it to you: work it out from the screen.

## The app

Research Companion helps a researcher write from their own sources with citations that are checked against the source. Open it at **http://localhost:5173** in your browser. This is the app's browser version, running against a local test library. It already holds six sample files (two papers, notes, a fieldwork log, slides and a chapter outline) and a demo draft, **Sleep, memory and reefs (demo)**, which opens first. The app's AI is Meta's Muse: drafting and checking take time, so wait (up to 30 s) instead of clicking again.

## What to try, in roughly this order

1. Work out what the app is for.
2. In the demo draft, each sentence has a small **cite** marker that checks it against the library. One sentence is false on purpose. Then:
   1. Confirm a source: click a green marker, then **Use this source** in the Citations tab.
   2. See the quote on its page: click the citation that replaced the marker.
   3. Draft with the Assistant: ask for a paragraph (say, on coral bleaching) and insert it.
   4. Check for duplication: open the **Review** tab.
   5. Export to Word with **Export**. In the browser version this downloads a .docx; you don't need to open it.
3. Look at the other places in the left rail (**Library**, **Network**, **Matrix**) and try the search box.
4. Open **Settings** briefly.

Notice what is clear, confusing, slow, broken or impressive. Keep a short note of each thing you do and what you notice.

## Rules

- Use only http://localhost:5173. Don't visit other sites.
- Don't change API keys or the AI model in Settings, and don't delete sources or drafts.
- Don't read the app's source code: judge it from using it. For the engineer's view only, you may read these two files, which the other reviewers were also given:
  - `C:/Users/prabo/CS_projects/Meta_AI_Hackathon/docs/ARCHITECTURE.md`
  - `C:/Users/prabo/CS_projects/Meta_AI_Hackathon/backend/eval/README.md`
- Spend about the same effort as the other reviewers: roughly 20 to 40 actions.

## Then mark the app

Mark it from four points of view, as a tough, calibrated grader whose marks are compared with other graders'.

Scale: 3 = weak, 5 = an average hackathon entry, 7 = a strong entry, 9 = among the best you have seen, 10 = nothing left to improve (almost never give it). Most criteria for a good project land between 5 and 8.

Score only what you actually saw or read. Something you didn't get to try caps that criterion at 6, and the reason must say so. Every point of view must name at least one concrete weakness in its verdict.

| Point of view | Brief | Criteria |
|---|---|---|
| Hackathon judge | You judge the Meta AI hackathon: impact, originality, how well it uses Meta's models, and how finished it feels. | `impact`, `innovation`, `use_of_meta_models`, `polish`, `demo_quality` |
| Researcher (user) | You are a PhD student writing a literature review. Would this save you time, and would you trust what it writes? | `usefulness`, `trust_in_citations`, `time_saved`, `would_use_it` |
| UX designer | You review interfaces: clarity, layout, onboarding, feedback, how easy each task was. | `clarity`, `onboarding`, `visual_design`, `ease_of_tasks`, `feedback_and_errors` |
| Engineer | You review software: reliability and speed as you saw them, error handling, privacy, and (from the two files above) design and testing. | `reliability`, `performance`, `privacy_and_security`, `architecture`, `testing_and_evaluation` |

## Save your result

Write ONE JSON file to:

`C:/Users/prabo/CS_projects/Meta_AI_Hackathon/desktop/scripts/app-review/results/2026-11-02T04-36-28/antigravity/agent-output.json`

shaped like this (scores are numbers from 1 to 10):

```json
{
  "model": "the model you are",
  "log": [{"step": 1, "did": "what you did", "noticed": "what you noticed"}],
  "review": {
    "hackathon_judge": {
      "scores": {"impact": 0, "innovation": 0, "use_of_meta_models": 0, "polish": 0, "demo_quality": 0},
      "reasons": {"impact": "one sentence: why this score, citing what you saw"},
      "verdict": "two sentences from this point of view"
    },
    "researcher": {"scores": {}, "reasons": {}, "verdict": ""},
    "ux_designer": {"scores": {}, "reasons": {}, "verdict": ""},
    "engineer": {"scores": {}, "reasons": {}, "verdict": ""},
    "strengths": ["top 3"],
    "weaknesses": ["top 3"],
    "bugs": [{"what": "", "where": "", "severity": "low|medium|high"}],
    "overall": 0
  }
}
```

Fill in a reason for every criterion. When the file is written, say so and stop.
