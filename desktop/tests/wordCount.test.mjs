// The word count in every language, on the cases the backend's word_count is tested on too, so the
// status bar and the drafts list agree. `npm test` (Node runs the TypeScript directly).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { countWords } from '../src/wordCount.ts'

const cases = JSON.parse(readFileSync(new URL('./word-count-cases.json', import.meta.url), 'utf8'))

for (const c of cases) {
  test(`${c.why}: ${JSON.stringify(c.text)}`, () => {
    assert.equal(countWords(c.text), c.words)
  })
}
