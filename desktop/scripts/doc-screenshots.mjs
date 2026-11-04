// Retake the user guide's screenshots (docs/images) from the web preview, in Edge, at 1360x680.
// Start the "backend" and "web" previews first, then:
//   node desktop/scripts/doc-screenshots.mjs [outDir] [name,name]
// It drives your own library (its open draft, the "Cryptocurrency" matrix) without editing drafts
// or settings, and shows the light theme without changing your saved one. pdf-viewer.png
// (Chromium's PDF window) is not taken here.
import { chromium } from 'playwright'

const OUT = process.argv[2] || new URL('../../docs/images', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')
const ONLY = process.argv[3]?.split(',')
const wait = (p, ms) => p.waitForTimeout(ms)
const btn = (p, name, exact = false) => p.getByRole('button', { name, exact }).first()

const openMatrix = async (p) => { await btn(p, /^Matrix/).click(); await wait(p, 2000); await btn(p, /^Open .Cryptocurrency/).click(); await wait(p, 3000) }

const SHOTS = {
  write: async (p) => {},
  'tools-closed': async (p) => { await btn(p, 'Close the writing tools').click() },
  focus: async (p) => { await btn(p, 'Focus mode').click() },
  'drafts-menu': async (p) => { await btn(p, /^Drafts/).click() },
  review: async (p) => { await p.getByRole('tab', { name: /Check/ }).or(btn(p, /^Check/)).first().click(); await wait(p, 6000) },
  'citation-source': async (p) => { await p.locator('.paper, .ProseMirror, [contenteditable]').getByText('Chen & Martinez 2021, p. 341').first().click(); await wait(p, 2500) },
  library: async (p) => { await btn(p, /^Library/).click(); await wait(p, 1500); await p.locator('tbody tr').nth(2).click(); await wait(p, 1500) },
  'add-sources': async (p) => { await btn(p, /^Library/).click(); await wait(p, 1200); await btn(p, /Add sources/).click() },
  network: async (p) => { await btn(p, /^Network/).click(); await wait(p, 1500); await p.getByPlaceholder(/^A topic/).first().fill('cryptocurrency'); await btn(p, 'Map this topic').click(); await wait(p, 45000) },
  matrix: async (p) => { await openMatrix(p) },
  'matrix-cell': async (p) => { await openMatrix(p); await p.locator('td.mx-cell:not(.mx-detail)').nth(1).click({ position: { x: 30, y: 20 } }); await wait(p, 4000) },
  'matrix-new': async (p) => { await btn(p, /^Matrix/).click(); await wait(p, 2000); await btn(p, /New matrix/).click(); await wait(p, 1500) },
  settings: async (p) => { await btn(p, 'Settings', true).click(); await wait(p, 1500) },
}

const browser = await chromium.launch({ channel: 'msedge' })
for (const [name, steps] of Object.entries(SHOTS)) {
  if (ONLY && !ONLY.includes(name)) continue
  const page = await browser.newPage({ viewport: { width: 1360, height: 680 }, colorScheme: 'light' })
  // The page reads the theme as light; the user's saved setting (GET only, nothing written) is untouched.
  await page.route(/\/settings$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const res = await route.fetch()
    route.fulfill({ response: res, json: { ...(await res.json()), theme: 'light' } })
  })
  try {
    await page.goto('http://localhost:5173/')
    // Light theme for the docs without changing the user's saved setting: keep <html data-theme> light.
    await page.evaluate(() => {
      const force = () => { if (document.documentElement.dataset.theme !== 'light') document.documentElement.dataset.theme = 'light' }
      new MutationObserver(force).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
      force()
    })
    await wait(page, 5000)
    await steps(page)
    await wait(page, 800)
    await page.mouse.move(1359, 679)
    await page.screenshot({ path: `${OUT}/${name}.png` })
    console.log('ok', name)
  } catch (e) {
    console.log('FAIL', name, e.message.split('\n')[0])
  }
  await page.close()
}
await browser.close()
