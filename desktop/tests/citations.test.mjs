// How a cite marker's colour and the draft's citation counts follow from the checks' results: the
// status bar, Check's badge and the marker in the draft all read these.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stateOf, stateSoFar, unfinished } from '../src/editor/citeMark.ts'
import { sourceLabel, tally } from '../src/editor/citeStatus.ts'

const r = (status) => ({ status })

test('a marker takes the colour of its best candidate', () => {
  assert.equal(stateOf([]), 'none')
  assert.equal(stateOf([r('verified'), r('weak')]), 'verified')
  assert.equal(stateOf([r('weak'), r('unsupported')]), 'weak')
  assert.equal(stateOf([r('unsupported')]), 'unsupported')
})

test('while checks come in, one supported candidate is enough to turn the marker green', () => {
  assert.equal(stateSoFar([r('pending'), r('verified')]), 'verified')
  assert.equal(stateSoFar([r('weak'), r('pending')]), 'searching') // a later one may still be better
  assert.equal(stateSoFar([r('weak'), r('unsupported')]), 'weak')
})

test('a marker whose search was cut short searches again', () => {
  assert.equal(unfinished({ state: 'searching', results: [] }), true)
  assert.equal(unfinished({ state: 'weak', results: [r('weak'), r('pending')] }), true)
  assert.equal(unfinished({ state: 'verified', results: [r('verified')] }), false)
})

test('the draft names a source without its page: the page is on the card', () => {
  assert.equal(sourceLabel('Chen & Martinez 2021, p. 342'), 'Chen & Martinez 2021')
  assert.equal(sourceLabel('Okafor et al. 2019, PDF p. 3'), 'Okafor et al. 2019') // an unnumbered page
  assert.equal(sourceLabel('Lab meeting 2024, slide 12'), 'Lab meeting 2024')
  assert.equal(sourceLabel('Suri 2016, p. iv'), 'Suri 2016')
  assert.equal(sourceLabel('Reading notes: sleep & memory'), 'Reading notes: sleep & memory') // no page to drop
  assert.equal(sourceLabel('Smith 2020, pp. 3–4'), 'Smith 2020')
})

test('the tally counts each citation once, and a retracted paper needs attention even when supported', () => {
  const chips = [
    { status: 'verified', docId: 1 },
    { status: 'verified', docId: 2 }, // retracted
    { status: 'weak', docId: 3 },
    { status: 'pending', docId: 4 },
  ]
  const marks = [{ state: 'searching' }, { state: 'verified' }, { state: 'none' }]
  assert.deepEqual(tally(chips, marks, new Set([2])), { supported: 1, attention: 4, toConfirm: 1, checking: 2, total: 7 })
})
