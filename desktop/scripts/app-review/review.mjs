// AI review panel: several AI models each use the real desktop app (Electron, driven by Playwright),
// then mark it from four points of view. Evaluation only: the app itself still calls only Muse.
//
//   npm run build                                  # the reviewers use the built UI (dist/)
//   node scripts/app-review/review.mjs run [--reviewers muse,gemini] [--steps 20] [--parallel 1]
//   node scripts/app-review/review.mjs marksheet scripts/app-review/results/<run>
//
// Each reviewer gets a fresh, throwaway library (copied search models, no papers) and the app runs on
// Muse with the keys in ~/.groundwork/.env. Gemini needs the Gemini CLI signed in with Google
// once (run `gemini` and pick "Sign in with Google"). Every step the reviewer sees a numbered list of
// what it can click (plus a screenshot, for models that take images) and answers with one action.
// Native dialogs are stubbed so nothing blocks or touches real files. Keys are read from
// ~/.groundwork/.env (Muse) and Hermes Agent's .env (OpenRouter), never printed.

import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP = path.resolve(HERE, '..', '..')
const REPO = path.resolve(DESKTOP, '..')
const RC_DATA = process.env.RC_DATA_DIR || [path.join(os.homedir(), '.groundwork'), path.join(os.homedir(), '.research-companion')].find((d) => fs.existsSync(d)) || path.join(os.homedir(), '.groundwork')
const HERMES_ENV = path.join(os.homedir(), 'AppData', 'Local', 'hermes', '.env')

// ---------- reviewers ----------

// Free or hackathon-provided only: Muse on Meta's Model API, Gemini through the Gemini CLI's Google
// sign-in, and OpenRouter's ":free" models, which allow 50 requests a day on an account that never
// bought credit (one request per step).
const REVIEWERS = {
  muse: { name: 'Muse Spark 1.3 (Meta)', provider: 'meta', model: null, vision: true },
  gemini: { name: 'Gemini (Google, via Gemini CLI)', provider: 'gemini-cli', model: null, vision: true },
  'nemotron-ultra': { name: 'Nemotron 3 Ultra 550B (NVIDIA)', provider: 'openrouter', model: 'nvidia/nemotron-3-ultra-550b-a55b:free', vision: false },
  'nemotron-vl': { name: 'Nemotron 3.5 Super VL (NVIDIA)', provider: 'openrouter', model: 'nvidia/nemotron-3.5-super-vl:free', vision: true },
  gemma: { name: 'Gemma 4 31B (Google, open)', provider: 'openrouter', model: 'google/gemma-4-31b-it:free', vision: true },
}

function readEnv(file) {
  const out = {}
  if (!fs.existsSync(file)) return out
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}

const rcEnv = readEnv(path.join(RC_DATA, '.env'))

function endpoint(r) {
  if (r.provider === 'meta') {
    return { base: rcEnv.MUSE_API_BASE || 'https://api.meta.ai/v1', key: rcEnv.MUSE_API_KEY, model: rcEnv.MUSE_MODEL || 'muse-spark-1.3' }
  }
  if (r.provider === 'gemini-cli') return { model: "the Gemini CLI's default model" }
  return { base: 'https://openrouter.ai/api/v1', key: readEnv(HERMES_ENV).OPENROUTER_API_KEY, model: r.model }
}

// ---------- talking to a model (OpenAI-compatible chat completions) ----------

/** Gemini through the Gemini CLI, signed in with Google (free tier). Images go in as @file references,
 * read from the run's screenshot folder; plan mode keeps it read-only. */
async function geminiCli(messages, cwd) {
  const { spawn } = await import('node:child_process')
  const parts = []
  for (const m of messages) {
    for (const c of Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }]) {
      if (c.type === 'text') parts.push(m.role === 'system' ? `Instructions:\n${c.text}` : c.text)
      else if (c.file) parts.push(`Screenshot of the current screen: @${c.file}`)
    }
  }
  const started = Date.now()
  const out = await new Promise((resolve, reject) => {
    const p = spawn('gemini', ['-p', '', '-o', 'json', '--approval-mode', 'plan'], {
      cwd, shell: true, env: { ...process.env, GOOGLE_GENAI_USE_GCA: 'true', GEMINI_CLI_TRUST_WORKSPACE: 'true' },
    })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => (stdout += d))
    p.stderr.on('data', (d) => (stderr += d))
    p.on('error', reject)
    p.on('close', () => resolve({ stdout, stderr }))
    p.stdin.end(parts.join('\n\n'))
  })
  const json = JSON.parse(out.stdout.slice(out.stdout.indexOf('{')) || '{}')
  if (json.error) throw new Error(`gemini-cli: ${json.error.message}`)
  const tokens = Object.values(json.stats?.models ?? {}).map((m) => m.tokens ?? {})
  return {
    text: json.response ?? '',
    ms: Date.now() - started,
    tokensIn: tokens.reduce((n, t) => n + (t.prompt ?? 0), 0),
    tokensOut: tokens.reduce((n, t) => n + (t.candidates ?? 0), 0),
  }
}

async function chat(r, messages, { maxTokens = 1500, cwd } = {}) {
  if (r.provider === 'gemini-cli') return geminiCli(messages, cwd)
  // OpenAI-style messages carry the image inline; the CLI gets the file path (`file`) instead.
  messages = messages.map((m) => (Array.isArray(m.content) ? { ...m, content: m.content.map(({ file, ...c }) => c) } : m))
  const { base, key, model } = endpoint(r)
  if (!key) throw new Error(`No API key for ${r.provider}`)
  // Muse on Meta's API counts its hidden reasoning against max_completion_tokens (as in providers/muse.py).
  const body = r.provider === 'meta'
    ? { model, messages, max_completion_tokens: maxTokens + 4096, reasoning_effort: rcEnv.MUSE_REASONING_EFFORT || 'low', temperature: 0.3 }
    : { model, messages, max_tokens: maxTokens, temperature: 0.3 }
  for (let attempt = 0; ; attempt++) {
    const started = Date.now()
    let res
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(240_000),
      })
    } catch (e) {
      if (attempt < 3) continue
      throw e
    }
    if ([429, 500, 502, 503, 504].includes(res.status) && attempt < 4) {
      await new Promise((ok) => setTimeout(ok, 2000 * 2 ** attempt))
      continue
    }
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`${r.provider} ${res.status}: ${JSON.stringify(data).slice(0, 300)}`)
    const usage = data.usage ?? {}
    return {
      text: data.choices?.[0]?.message?.content ?? '',
      ms: Date.now() - started,
      tokensIn: usage.prompt_tokens ?? 0,
      tokensOut: usage.completion_tokens ?? 0,
    }
  }
}

/** The first JSON object in a reply (models wrap it in prose or code fences). */
function parseJSON(text) {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '')
  const start = cleaned.indexOf('{')
  if (start < 0) return null
  for (let end = cleaned.lastIndexOf('}'); end > start; end = cleaned.lastIndexOf('}', end - 1)) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1))
    } catch {
      /* try a shorter span */
    }
  }
  return null
}

// ---------- the app ----------

function freshDataDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, 'models'), { recursive: true })
  // The small search models, so each run doesn't download them again (BGE-M3 isn't used any more).
  const models = path.join(RC_DATA, 'models')
  if (fs.existsSync(models)) {
    for (const name of fs.readdirSync(models)) {
      if (/bge-m3|L-12/i.test(name)) continue
      fs.cpSync(path.join(models, name), path.join(dir, 'models', name), { recursive: true })
    }
  }
}

async function launchApp(dataDir, outDir) {
  const env = { ...process.env, ...rcEnv, RC_DATA_DIR: dataDir, RC_PROVIDER: 'muse' }
  delete env.VITE_DEV_SERVER_URL
  delete env.RC_BACKEND_URL
  const app = await electron.launch({ args: ['.'], cwd: DESKTOP, env })
  // Native dialogs would block the run: saving goes to the run folder, picking files is cancelled,
  // and nothing opens in the system browser or goes to the Recycle Bin.
  await app.evaluate(({ dialog, shell }, out) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: `${out}/exported-${Date.now()}.docx` })
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
    shell.openExternal = async () => {}
    shell.openPath = async () => ''
    shell.trashItem = async () => {}
    shell.showItemInFolder = () => {}
  }, outDir.replace(/\\/g, '/'))
  const page = await app.firstWindow()
  page.on('dialog', (d) => d.accept().catch(() => {})) // window.confirm in the page: yes
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

/** What the reviewer can see and click: visible interactive elements, numbered, plus the screen's text. */
async function observe(page) {
  return page.evaluate(() => {
    document.querySelectorAll('[data-agent-id]').forEach((el) => el.removeAttribute('data-agent-id'))
    const sel = [
      'button', 'a[href]', 'input', 'textarea', 'select', '[role="tab"]', '[role="button"]', '[role="menuitem"]',
      // Markers and citations only in the draft: the Citations tab's help text shows example markers
      // that look clickable but aren't (the first panel run lost several steps to them).
      '[role="option"]', '[contenteditable="true"]', '.ProseMirror .cite-mark', '.ProseMirror .cite', 'summary', 'tr[tabindex]', 'li[tabindex]',
    ].join(',')
    const visible = (el) => {
      if (el.closest('[hidden]')) return false
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false
      const s = getComputedStyle(el)
      return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05
    }
    const clean = (t) => (t || '').replace(/\s+/g, ' ').trim()
    const elements = []
    let n = 0
    const listed = new Set()
    for (const el of document.querySelectorAll(sel)) {
      if (!visible(el)) continue
      // Something inside a button already listed (the marker in a Citations-tab row) is the same target.
      const parent = el.parentElement?.closest(sel)
      if (parent && listed.has(parent) && parent.getAttribute('contenteditable') !== 'true') continue
      listed.add(el)
      const tag = el.tagName.toLowerCase()
      const role = el.getAttribute('role') || (el.classList.contains('cite-mark') ? 'cite-marker' : el.classList.contains('cite') ? 'citation' : tag)
      let label = clean(el.getAttribute('aria-label')) || clean(el.innerText).slice(0, 80) || clean(el.getAttribute('placeholder')) || clean(el.getAttribute('title')).slice(0, 80)
      if (tag === 'input' || tag === 'textarea') label = `${clean(el.getAttribute('aria-label') || el.getAttribute('placeholder')).slice(0, 60)} = "${clean(el.value).slice(0, 60)}"`
      if (el.getAttribute('contenteditable') === 'true') label = `editor: "${clean(el.innerText).slice(0, 120)}"`
      const title = clean(el.getAttribute('title'))
      const state = [el.disabled && 'disabled', el.getAttribute('aria-selected') === 'true' && 'selected',
        el.getAttribute('aria-current') && 'current', el.checked && 'checked'].filter(Boolean).join(',')
      const id = ++n
      el.setAttribute('data-agent-id', String(id))
      elements.push(`[${id}] ${role}: ${label}${title && !label.includes(title.slice(0, 20)) ? ` (hint: ${title.slice(0, 80)})` : ''}${state ? ` {${state}}` : ''}`)
      if (n >= 150) break
    }
    const toasts = [...document.querySelectorAll('.toast')].map((t) => clean(t.innerText))
    return {
      text: clean(document.body.innerText).slice(0, 3500),
      elements,
      toasts,
      status: clean(document.querySelector('.dock .status')?.textContent),
    }
  })
}

async function act(page, a) {
  const target = a.id != null ? page.locator(`[data-agent-id="${a.id}"]`).first() : null
  switch (a.type) {
    case 'click':
      if (!target) throw new Error('click needs an element id')
      await target.click({ timeout: 5000 })
      return `clicked [${a.id}]`
    case 'type': {
      if (!target) throw new Error('type needs an element id')
      const tag = await target.evaluate((el) => el.tagName.toLowerCase())
      if (tag === 'input' || tag === 'textarea') await target.fill(String(a.text ?? ''), { timeout: 5000 })
      else {
        await target.click({ timeout: 5000 })
        await page.keyboard.type(String(a.text ?? ''), { delay: 5 })
      }
      if (a.submit) await page.keyboard.press('Enter')
      return `typed "${String(a.text).slice(0, 60)}" into [${a.id}]${a.submit ? ' and pressed Enter' : ''}`
    }
    case 'press':
      await page.keyboard.press(String(a.key))
      return `pressed ${a.key}`
    case 'scroll':
      if (target) await target.hover({ timeout: 3000 })
      await page.mouse.wheel(0, a.direction === 'up' ? -700 : 700)
      return `scrolled ${a.direction ?? 'down'}`
    case 'wait': {
      const s = Math.min(30, Math.max(1, Number(a.seconds) || 5))
      await page.waitForTimeout(s * 1000)
      return `waited ${s}s`
    }
    default:
      throw new Error(`unknown action ${a.type}`)
  }
}

// ---------- the session ----------

const GOALS = `You are testing "Groundwork", a desktop app for researchers, as a first-time user. Nobody explains it to you: work it out from the screen.
Try to, in roughly this order:
1. Work out what the app is for.
2. Load the sample library and work through the demo checklist that appears above the demo draft (confirm a source, see a quote on its page, draft with the Assistant, check for duplication, export to Word).
3. Look at the other places in the left rail (Library, Network, Matrix) and try the search box.
4. Open Settings briefly (don't change API keys or the AI model).
Imports and AI answers take time: use "wait" (up to 30 s) rather than clicking again. Notice what is clear, confusing, slow, broken or impressive.

Every turn, reply with ONE JSON object and nothing else:
{"observation": "what you notice on this screen (good or bad), one or two sentences",
 "action": {"type": "click", "id": 12} | {"type": "type", "id": 7, "text": "...", "submit": false} | {"type": "press", "key": "Escape"} | {"type": "scroll", "direction": "down", "id": 3} | {"type": "wait", "seconds": 10} | {"type": "done"}}
Ids are the [numbers] in the element list of the current screen; they change every turn.`

async function session(key, r, { steps, runDir }) {
  const outDir = path.join(runDir, key)
  const shots = path.join(outDir, 'screens')
  fs.mkdirSync(shots, { recursive: true })
  const dataDir = path.join(os.tmpdir(), 'groundwork-app-review', path.basename(runDir), key)
  freshDataDir(dataDir)
  const log = []
  const usage = { calls: 0, tokensIn: 0, tokensOut: 0, ms: 0 }
  let vision = r.vision
  const say = (m) => console.log(`[${key}] ${m}`)
  const { app, page } = await launchApp(dataDir, outDir)
  try {
    await page.waitForFunction(() => !/Starting backend/.test(document.querySelector('.dock .status')?.textContent ?? 'Starting backend'), null, { timeout: 120_000 })
    for (let step = 1; step <= steps; step++) {
      await page.waitForTimeout(700)
      const view = await observe(page)
      const shot = path.join(shots, `step-${String(step).padStart(2, '0')}.png`)
      const png = await page.screenshot({ path: shot })
      const history = log.slice(-25).map((l) => `${l.step}. ${l.result}${l.error ? ` (ERROR: ${l.error})` : ''} | noticed: ${l.observation}`).join('\n')
      const prompt = [
        `Step ${step} of ${steps}.`,
        history ? `Your previous steps:\n${history}` : 'This is the first screen.',
        `Status bar: ${view.status}`,
        view.toasts.length ? `Messages on screen: ${view.toasts.join(' | ')}` : '',
        `Visible text (shortened): ${view.text}`,
        `Elements you can act on:\n${view.elements.join('\n')}`,
      ].filter(Boolean).join('\n\n')
      const content = vision
        ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` }, file: path.basename(shot) }]
        : prompt
      let reply
      try {
        reply = await chat(r, [{ role: 'system', content: GOALS }, { role: 'user', content }], { maxTokens: 1200, cwd: shots })
      } catch (e) {
        if (vision && /image|vision|multimodal|content/i.test(String(e))) {
          vision = false // this deployment doesn't take images: continue with text only
          say('no image support here; continuing with text only')
          reply = await chat(r, [{ role: 'system', content: GOALS }, { role: 'user', content: prompt }], { maxTokens: 1200, cwd: shots })
        } else throw e
      }
      usage.calls++
      usage.tokensIn += reply.tokensIn
      usage.tokensOut += reply.tokensOut
      usage.ms += reply.ms
      const parsed = parseJSON(reply.text) ?? {}
      const action = parsed.action ?? { type: 'wait', seconds: 2 }
      const entry = { step, observation: String(parsed.observation ?? reply.text.slice(0, 200)), action, result: '', error: null, ms: reply.ms }
      if (action.type === 'done') {
        entry.result = 'finished exploring'
        log.push(entry)
        say(`done after ${step} steps`)
        break
      }
      try {
        entry.result = await act(page, action)
      } catch (e) {
        entry.result = `tried ${action.type}${action.id != null ? ` [${action.id}]` : ''}`
        entry.error = String(e.message ?? e).split('\n')[0].slice(0, 200)
      }
      log.push(entry)
      say(`${step}: ${entry.result}${entry.error ? ' (failed)' : ''}`)
    }
    const finalShot = await page.screenshot({ path: path.join(shots, 'final.png') })
    fs.writeFileSync(path.join(outDir, 'session.json'), JSON.stringify({ reviewer: r.name, vision, usage, log }, null, 2))
    return { log, usage, vision, finalShot }
  } finally {
    await app.close().catch(() => {})
  }
}

// ---------- the review ----------

export const PERSPECTIVES = {
  hackathon_judge: {
    title: 'Hackathon judge',
    brief: 'You judge the Meta AI hackathon: impact, originality, how well it uses Meta\'s models, and how finished it feels.',
    criteria: ['impact', 'innovation', 'use_of_meta_models', 'polish', 'demo_quality'],
  },
  researcher: {
    title: 'Researcher (user)',
    brief: 'You are a PhD student writing a literature review. Would this save you time, and would you trust what it writes?',
    criteria: ['usefulness', 'trust_in_citations', 'time_saved', 'would_use_it'],
  },
  ux_designer: {
    title: 'UX designer',
    brief: 'You review interfaces: clarity, layout, onboarding, feedback, how easy each task was.',
    criteria: ['clarity', 'onboarding', 'visual_design', 'ease_of_tasks', 'feedback_and_errors'],
  },
  engineer: {
    title: 'Engineer',
    brief: 'You review software: reliability and speed as you saw them, error handling, privacy, and (from the architecture notes below) design and testing.',
    criteria: ['reliability', 'performance', 'privacy_and_security', 'architecture', 'testing_and_evaluation'],
  },
}

function reviewPrompt(log, archNotes) {
  const lines = log.map((l) => `${l.step}. ${l.result}${l.error ? ` (ERROR: ${l.error})` : ''}${l.ms > 15000 ? ' [the app took a while]' : ''} | noticed: ${l.observation}`).join('\n')
  const schema = Object.fromEntries(Object.entries(PERSPECTIVES).map(([k, p]) => [k, {
    scores: Object.fromEntries(p.criteria.map((c) => [c, '1-10'])),
    reasons: Object.fromEntries(p.criteria.map((c) => [c, 'one sentence: why this score, citing what you saw'])),
    verdict: 'two sentences from this point of view',
  }]))
  return `You just tested the desktop app "Groundwork" yourself. Here is everything you did and noticed:

${lines}

Architecture and evaluation notes from the project (for the engineer's view only):
${archNotes}

Now mark the app from four points of view, as a tough, calibrated grader whose marks are compared with other graders'.
Scale: 3 = weak, 5 = an average hackathon entry, 7 = a strong entry, 9 = among the best you have seen, 10 = nothing left to improve (almost never give it). Most criteria for a good project land between 5 and 8.
Score only what you actually saw or read; something you didn't get to try caps that criterion at 6, and the reason must say so. Every point of view must name at least one concrete weakness in its verdict.
${Object.values(PERSPECTIVES).map((p) => `- ${p.title}: ${p.brief}`).join('\n')}

Reply with ONE JSON object and nothing else, shaped like this:
${JSON.stringify({ ...schema, strengths: ['top 3'], weaknesses: ['top 3'], bugs: [{ what: '', where: '', severity: 'low|medium|high' }], overall: '1-10' }, null, 1)}`
}

function archNotes() {
  const arch = fs.readFileSync(path.join(REPO, 'docs', 'ARCHITECTURE.md'), 'utf8').slice(0, 9000)
  const evalReadme = fs.readFileSync(path.join(REPO, 'backend', 'eval', 'README.md'), 'utf8').slice(0, 5000)
  return `${arch}\n\n--- Evaluation results ---\n${evalReadme}`
}

async function review(key, r, s, runDir) {
  const prompt = reviewPrompt(s.log, archNotes())
  const content = s.vision
    ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:image/png;base64,${s.finalShot.toString('base64')}` }, file: 'final.png' }]
    : prompt
  const cwd = path.join(runDir, key, 'screens')
  let reply = await chat(r, [{ role: 'user', content }], { maxTokens: 4000, cwd })
  let parsed = parseJSON(reply.text)
  if (!parsed) {
    reply = await chat(r, [{ role: 'user', content: prompt }, { role: 'assistant', content: reply.text }, { role: 'user', content: 'Reply again with only the JSON object.' }], { maxTokens: 4000, cwd })
    parsed = parseJSON(reply.text)
  }
  s.usage.calls++
  s.usage.tokensIn += reply.tokensIn
  s.usage.tokensOut += reply.tokensOut
  const out = { reviewer: r.name, key, model: endpoint(r).model, provider: r.provider, vision: s.vision, steps: s.log.length,
    errors: s.log.filter((l) => l.error).length, usage: s.usage, review: parsed, raw: parsed ? undefined : reply.text }
  fs.writeFileSync(path.join(runDir, key, 'review.json'), JSON.stringify(out, null, 2))
  return out
}

// ---------- the marksheet ----------

const num = (v) => {
  const n = Number(String(v).match(/\d+(\.\d+)?/)?.[0])
  return Number.isFinite(n) && n >= 1 && n <= 10 ? n : null
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const sd = (xs) => {
  const m = mean(xs)
  return xs.length > 1 ? Math.sqrt(mean(xs.map((x) => (x - m) ** 2))) : 0
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

function marksheet(runDir) {
  const reviews = fs.readdirSync(runDir)
    .map((d) => path.join(runDir, d, 'review.json'))
    .filter((f) => fs.existsSync(f))
    .map((f) => JSON.parse(fs.readFileSync(f, 'utf8')))
    .filter((r) => r.review)
  const rows = reviews.map((r) => {
    const perspective = {}
    for (const [k, p] of Object.entries(PERSPECTIVES)) {
      const scores = Object.fromEntries(p.criteria.map((c) => [c, num(r.review[k]?.scores?.[c])]))
      perspective[k] = { scores, avg: mean(Object.values(scores).filter((x) => x != null)) }
    }
    return { ...r, perspective, overall: num(r.review.overall) }
  })
  const columns = Object.entries(PERSPECTIVES).flatMap(([k, p]) => p.criteria.map((c) => ({ k, c })))
  const colStats = columns.map(({ k, c }) => {
    const xs = rows.map((r) => r.perspective[k].scores[c]).filter((x) => x != null)
    return { k, c, avg: mean(xs), sd: sd(xs) }
  })
  const summary = { run: path.basename(runDir), reviewers: rows.length, criteria: colStats,
    rows: rows.map((r) => ({ reviewer: r.reviewer, model: r.model, provider: r.provider, vision: r.vision, steps: r.steps, errors: r.errors,
      usage: r.usage, overall: r.overall, perspectives: Object.fromEntries(Object.entries(r.perspective).map(([k, v]) => [k, v.avg])) })) }
  fs.writeFileSync(path.join(runDir, 'marksheet.json'), JSON.stringify(summary, null, 2))

  const fmt = (x) => (x == null ? '–' : x.toFixed(1))
  const tone = (x) => (x == null ? '' : x >= 8 ? 'hi' : x >= 6 ? 'mid' : 'lo')
  const label = (c) => c.replace(/_/g, ' ')
  const head = Object.entries(PERSPECTIVES).map(([, p]) => `<th colspan="${p.criteria.length}">${esc(p.title)}</th>`).join('')
  const sub = columns.map(({ c }) => `<th class="crit">${esc(label(c))}</th>`).join('')
  const body = rows.map((r) => `<tr><th class="who">${esc(r.reviewer)}<small>${esc(r.provider)} · ${r.steps} steps${r.vision ? ' · saw screenshots' : ' · text only'}</small></th>${
    columns.map(({ k, c }) => { const x = r.perspective[k].scores[c]; return `<td class="${tone(x)}" title="${esc(r.review[k]?.reasons?.[c])}">${x ?? '–'}</td>` }).join('')
  }<td class="${tone(r.overall)} total">${r.overall ?? '–'}</td></tr>`).join('')
  const avgRow = `<tr class="avg"><th class="who">Average</th>${colStats.map((s) => `<td class="${tone(s.avg)}">${fmt(s.avg)}</td>`).join('')}<td class="total">${fmt(mean(rows.map((r) => r.overall).filter((x) => x != null)))}</td></tr>`
  const spreadRow = `<tr class="spread"><th class="who">Disagreement (±)</th>${colStats.map((s) => `<td>${s.sd.toFixed(1)}</td>`).join('')}<td></td></tr>`
  const notes = rows.map((r) => `<section class="card"><h3>${esc(r.reviewer)}</h3>${r.note ? `<p class="note"><b>Note:</b> ${esc(r.note)}</p>` : ''}
    ${Object.entries(PERSPECTIVES).map(([k, p]) => `<p><b>${esc(p.title)} (${fmt(r.perspective[k].avg)}):</b> ${esc(r.review[k]?.verdict)}</p>`).join('')}
    <div class="cols"><div><h4>Strengths</h4><ul>${(r.review.strengths ?? []).map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div>
    <div><h4>Weaknesses</h4><ul>${(r.review.weaknesses ?? []).map((s) => `<li>${esc(s)}</li>`).join('')}</ul></div></div>
    ${(r.review.bugs ?? []).length ? `<h4>Bugs it hit</h4><ul>${r.review.bugs.map((b) => `<li><b>${esc(b.severity)}</b> · ${esc(b.what)}${b.where ? ` <i>(${esc(b.where)})</i>` : ''}</li>`).join('')}</ul>` : ''}
  </section>`).join('')
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Review Marksheet</title><style>
:root{--bg:#f4f6f2;--panel:#fff;--text:#18241c;--muted:#5a6a5f;--line:#d7ded4;--hi:#d8f0df;--mid:#fbf1cf;--lo:#fbe2dd;--accent:#2d5a3d}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#121813;--panel:#1a221c;--text:#e4ece5;--muted:#9aaa9e;--line:#2e3a31;--hi:#1f3d29;--mid:#3d3519;--lo:#45231e;--accent:#8fd0a3}}
:root[data-theme="dark"]{--bg:#121813;--panel:#1a221c;--text:#e4ece5;--muted:#9aaa9e;--line:#2e3a31;--hi:#1f3d29;--mid:#3d3519;--lo:#45231e;--accent:#8fd0a3}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,"Segoe UI",sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px}h1{font:600 26px/1.2 Georgia,serif;margin:0 0 4px}p.lead{color:var(--muted);margin:0 0 20px}
.wrap{overflow-x:auto;background:var(--panel);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{padding:7px 8px;border-bottom:1px solid var(--line);text-align:center}
thead th{font-size:12px;color:var(--muted);font-weight:600}th.crit{writing-mode:vertical-rl;transform:rotate(180deg);height:120px;font-weight:500}
th.who{text-align:left;min-width:190px}th.who small{display:block;font-weight:400;color:var(--muted);font-size:11.5px}
td.hi{background:var(--hi)}td.mid{background:var(--mid)}td.lo{background:var(--lo)}td.total{font-weight:700}tr.avg th,tr.avg td{font-weight:700;border-top:2px solid var(--line)}
tr.spread td{color:var(--muted);font-size:12.5px}.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 18px;margin:14px 0}
.card h3{margin:0 0 8px}.note{color:var(--muted);font-size:13.5px}.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}h4{margin:10px 0 4px;font-size:13px;color:var(--muted)}
@media (max-width:640px){.cols{grid-template-columns:1fr}}</style></head><body><main>
<h1>AI Review Marksheet</h1><p class="lead">${rows.length} AI models each used Groundwork (the real desktop app, on a fresh sample library) and marked it out of 10 from four points of view. Hover a score for the reviewer's reason. Run ${esc(path.basename(runDir))}.</p>
<div class="wrap"><table><thead><tr><th></th>${head}<th>Overall</th></tr><tr><th></th>${sub}<th></th></tr></thead><tbody>${body}${avgRow}${spreadRow}</tbody></table></div>
<h2>What each reviewer said</h2>${notes}</main></body></html>`
  fs.writeFileSync(path.join(runDir, 'marksheet.html'), html)
  return summary
}

// ---------- command line ----------

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const opt = (name, dflt) => {
    const i = rest.indexOf(`--${name}`)
    return i >= 0 ? rest[i + 1] : dflt
  }
  if (cmd === 'marksheet') {
    const s = marksheet(path.resolve(rest[0]))
    console.log(`marksheet for ${s.reviewers} reviewers written to ${path.resolve(rest[0])}`)
    return
  }
  if (cmd !== 'run') throw new Error('usage: review.mjs run [--reviewers a,b] [--steps 40] [--parallel 3] | marksheet RUN_DIR')
  if (!fs.existsSync(path.join(DESKTOP, 'dist', 'index.html'))) throw new Error('Build the UI first: npm run build')
  const keys = opt('reviewers', Object.keys(REVIEWERS).join(',')).split(',')
  for (const k of keys) if (!REVIEWERS[k]) throw new Error(`unknown reviewer ${k}; choose from ${Object.keys(REVIEWERS).join(', ')}`)
  const steps = Number(opt('steps', 20))
  // One app at a time by default: parallel apps share one Muse key, and its rate limit slowed every
  // reviewer's session in the first panel run (429s on the shared key; drafts took minutes).
  const parallel = Number(opt('parallel', 1))
  // --run adds reviewers to an earlier run, so they share its marksheet.
  const runDir = opt('run') ? path.resolve(opt('run')) : path.join(HERE, 'results', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19))
  fs.mkdirSync(runDir, { recursive: true })
  console.log(`run ${runDir}: ${keys.join(', ')}; ${steps} steps each, ${parallel} at a time`)
  const queue = [...keys]
  const worker = async () => {
    for (let key = queue.shift(); key; key = queue.shift()) {
      const r = REVIEWERS[key]
      try {
        const s = await session(key, r, { steps, runDir })
        const out = await review(key, r, s, runDir)
        console.log(`[${key}] reviewed: overall ${out.review?.overall ?? '?'}; ${s.usage.tokensIn} tokens in, ${s.usage.tokensOut} out`)
      } catch (e) {
        console.error(`[${key}] failed: ${e.message ?? e}`)
        fs.writeFileSync(path.join(runDir, `${key}-error.txt`), String(e.stack ?? e))
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, keys.length) }, worker))
  const s = marksheet(runDir)
  console.log(`marksheet: ${s.reviewers} reviews -> ${path.join(runDir, 'marksheet.html')}`)
}

export { launchApp, observe }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message ?? e)
    process.exit(1)
  })
}
