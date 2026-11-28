// The Library's filter chips and saved views.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NO_FILTERS, authorKey, matches, readViews, sameFilters, yearMatches } from '../src/libraryFilters.ts'

test('one author however the paper prints the name', () => {
  assert.equal(authorKey('Tavneet Suri'), 'suri t')
  assert.equal(authorKey('Suri, Tavneet'), 'suri t')
  assert.equal(authorKey('T.  Suri'), 'suri t')
})

test('year choices: the last few years, a decade, before a year, or no year', () => {
  assert.equal(yearMatches(2024, { last: 3 }, 2026), true)
  assert.equal(yearMatches(2023, { last: 3 }, 2026), false)
  assert.equal(yearMatches(2019, { decade: 2010 }, 2026), true)
  assert.equal(yearMatches(1999, { before: 2000 }, 2026), true)
  assert.equal(yearMatches(null, 'none', 2026), true)
  assert.equal(yearMatches(0, 'none', 2026), true) // a year of 0 is no year
  assert.equal(yearMatches(null, { last: 3 }, 2026), false)
})

test('choices in one chip add up; chips narrow', () => {
  const paper = { kind: 'pdf', authors: ['Suri, Tavneet'], year: 2016, venue: 'Science', folderIds: [7], highlights: 0 }
  assert.equal(matches(paper, { ...NO_FILTERS, kinds: ['pdf', 'pptx'] }, 2026), true)
  assert.equal(matches(paper, { ...NO_FILTERS, kinds: ['pdf'], authors: ['suri t'], venues: ['science'] }, 2026), true)
  assert.equal(matches(paper, { ...NO_FILTERS, kinds: ['pdf'], year: { last: 5 } }, 2026), false)
  assert.equal(matches(paper, { ...NO_FILTERS, highlighted: true }, 2026), false)
  // A removed paper's record has no topics: a topic filter leaves it out.
  assert.equal(matches({ ...paper, folderIds: undefined }, { ...NO_FILTERS, topics: [7] }, 2026), false)
})

test('the same filters in any order are the same view', () => {
  assert.equal(sameFilters({ ...NO_FILTERS, kinds: ['pdf', 'docx'] }, { ...NO_FILTERS, kinds: ['docx', 'pdf'] }), true)
  assert.equal(sameFilters({ ...NO_FILTERS, kinds: ['pdf'] }, NO_FILTERS), false)
})

test('saved views read back from disk drop anything that is not one', () => {
  const good = { id: 'v1', name: 'Recent PDFs', scope: 'all', query: '', filters: { ...NO_FILTERS, kinds: ['pdf'], year: { last: 3 } } }
  const raw = [good, null, 'x', { ...good, id: 2 }, { ...good, filters: { ...good.filters, year: { last: '3' } } }, { ...good, filters: { ...good.filters, topics: ['a'] } }]
  assert.deepEqual(readViews(raw), [good])
  assert.deepEqual(readViews({ not: 'a list' }), [])
})
