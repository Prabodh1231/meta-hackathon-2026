# AI review panel

Several AI models each **use the real app** and then mark it out of 10 from four points of view: hackathon judge, researcher, UX designer and engineer. The result is one marksheet that shows where the app is strong and weak, and where the reviewers disagree. It's evaluation only. The app itself still calls only Muse.

## How it works

`review.mjs` launches the desktop app with Playwright for each reviewer, each time on a fresh, throwaway library with Muse switched on. Every step, the reviewer gets a numbered list of what it can click, plus a screenshot if the model takes images. It answers with one action (click, type, press, scroll, wait, done). After the session it marks the app on a fixed, calibrated rubric, based on what it did. Native dialogs are stubbed: saving goes to the run folder, and nothing opens in the system browser or touches real files.

```bash
cd desktop
npm run build                                   # reviewers use the built UI
node scripts/app-review/review.mjs run --reviewers muse,muse-open,nemotron-ultra,nemotron-vl --steps 20
node scripts/app-review/review.mjs run --reviewers gemma --run scripts/app-review/results/<run>   # add to a run
node scripts/app-review/review.mjs marksheet scripts/app-review/results/<run>                     # rebuild the page
```

| Reviewer key | Model | Through | Cost |
|---|---|---|---|
| `muse` | Muse Spark 1.3 (Meta) | Meta's Model API, key from `~/.research-companion/.env` | hackathon |
| `muse-open` | Muse Spark open (Meta) | Baseten Model APIs (the hackathon key covers only Muse) | hackathon |
| `nemotron-ultra` | Nemotron 3 Ultra 550B (NVIDIA), text only | OpenRouter `:free` | free |
| `nemotron-vl` | Nemotron 3.5 Super VL (NVIDIA), sees screenshots | OpenRouter `:free` | free |
| `gemma` | Gemma 4 31B (Google, open) | OpenRouter `:free` | free |
| `gemini` | Gemini | Gemini CLI signed in with Google | free |

The OpenRouter key is the one Hermes Agent uses (`%LOCALAPPDATA%/hermes/.env`). An account that never bought credit gets **50 free-model requests a day**, and each step is one request, so two 20-step reviewers fit in a day.

**Gemini through Antigravity.** Antigravity's `agentapi` starts Gemini conversations but never returns the replies to a script, so it can't drive this harness. Instead, Antigravity's own agent tested the app's browser version with its own tools, following [antigravity-task.md](antigravity-task.md): the same goals, rubric and output shape. Its result is converted into the run's `antigravity/review.json` and appears on the marksheet labelled as such.

Results go to `results/<run>/` (git-ignored): each reviewer's screenshots, step log, review JSON, and `marksheet.html` / `marksheet.json`.

## First marksheet (2026-11-02)

Five reviewers, about 20 steps each; Gemini took 27.

| Reviewer | Overall | Judge | Researcher | UX | Engineer |
|---|---|---|---|---|---|
| Gemini 3.8 Flash (Antigravity agent, browser version) | 7 | 7.8 | 8.0 | 7.4 | 8.0 |
| Muse Spark 1.3 (Meta) | 7 | 7.0 | 6.8 | 7.2 | 7.4 |
| Muse Spark open (Meta, Baseten) | 7 | 6.8 | 6.2 | 6.6 | 7.0 |
| Nemotron 3 Ultra 550B (NVIDIA) | 6 | 5.6 | 6.0 | 6.6 | 6.8 |
| Nemotron 3.5 Super VL (NVIDIA) | 6 | 5.6 | 5.8 | 5.6 | 6.0 |
| **Average** | **6.6** | | | | |

| Strongest (avg) | | Weakest (avg) | |
|---|---|---|---|
| testing and evaluation | 8.2 | performance | 5.4 |
| onboarding | 7.8 | time saved | 5.4 |
| architecture | 7.8 | demo quality | 5.6 (±1.5) |
| trust in citations | 7.6 | feedback and errors | 5.6 (±1.4) |
| privacy and security | 7.6 | polish | 6.0 |

Every reviewer completed the first demo steps and saw Muse mark the false REM sentence red. Every one named waiting as the main weakness.

**Read the low performance and demo marks with care.** The four harness reviewers ran at the same time, and with two Muse reviewers they shared one Baseten Muse key. It hit its rate limit (`429`), and the app fell back to Meta's API. Every draft did finish, but some took minutes. Gemini ran alone and got its Assistant draft in 7.5 s. The harness now runs one app at a time by default.

## What we learned about testing with AI reviewers

- **Uncalibrated AIs grade too kindly.** A 10-step dry run gave almost everything 9–10. A scale with anchors (5 = average entry, 7 = strong, 10 = almost never), a cap of 6 on anything not tried, and a required weakness per viewpoint brought the marks to a 5–9 spread that tracks what each reviewer actually saw.
- **The harness can produce false bugs.** In the first run, the Citations tab's help text showed example `cite` markers. Listed as clickable, they cost Muse several steps and showed up as a "bug". The harness now lists only markers in the draft and skips elements nested in a listed button. Reviewer-reported bugs need checking against the app before acting on them: "click on element [716] timed out" was a reviewer clicking an id that didn't exist.
- **Reviewers sometimes make things up.** Gemini's notes cite the reef sentence as "Hughes et al. 2019"; the saved draft shows Okafor & Raman 2019. Its actions were real (the draft confirms them), but its log needs the same check.
- **Shared keys and parallel runs distort what's measured.** Contention on the hackathon key made the app look slow. Run reviewers one at a time.
- **Access is the practical limit, not cost.**
  - The hackathon Baseten key covers only Muse: every other model there answers `403`, even though Baseten lists them.
  - OpenRouter's free tier allows 50 requests a day.
  - Free models are sometimes rate-limited upstream, as Gemma 4 was.
  - Antigravity's CLI can't return replies to a script.
  - A full 20-step session costs about 100k input tokens.

## What to improve in the app

In the order the reviewers' marks suggest:

1. **Feedback during AI waits.** This was the top complaint, from every reviewer.
   - Done for the Assistant in [PR 19](https://github.com/Prabodh1231/meta-hackathon-2026/pull/19): a timer, Muse's retry and route notes, and Cancel.
   - Still to do: the same for the **Ask** tab, review matrices, proposals and cite-marker checks. Muse and Gemini both asked for progress on each marker while the Citations tab checks.
2. **Import progress.** The Library shows "0 sources" and "0/6" for the first ~15 s of an import, with no per-file detail. Two reviewers flagged it.
3. **Layout overlaps.** The sticky formatting toolbar covered the Assistant's Insert button for one reviewer. The right panel feels crowded with the citation queue, source view and drafting controls together.
4. **Search palette backdrop.** Clicking near the search pill opens the palette, whose backdrop blocks clicks on the tabs until Esc.
5. **Perceived speed on demo day.** Drafting takes 7–30 s on Muse, more when a shared key is rate-limited. Use your own Muse key for the demo, and keep the Baseten route first; it's about twice as fast.
6. **Reach of the demo path.** Reviewers rarely reached Network or Matrix within 20 steps, so those features scored "not tried". A checklist step pointing at the review matrix would show more of what the app does.

## Next time

- **Re-run with everyone under the same conditions:** one at a time, the same step count, and Gemini through the harness with a free AI Studio key (so it runs the desktop app like the others).
- **Add Gemma 4** when its free route isn't rate-limited.
- **Give free models more steps** if the account gets the higher free quota (1,000 requests a day after buying $10 of credit), so they reach Network and Matrix too.
