// Muse's chat replies become HTML that's shown in Compose and can be inserted into the draft, so
// nothing in a reply may turn into markup it didn't ask for.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { markdownToHtml } from '../src/markdown.ts'

test('HTML in a reply is shown as text, never run', () => {
  const html = markdownToHtml('Look: <img src=x onerror="alert(1)"> and <script>alert(2)</script>')
  assert.ok(!html.includes('<img') && !html.includes('<script'))
  assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'))
})

test('HTML stays text inside code, headings, lists, quotes and tables', () => {
  const md = ['# <b>x</b>', '- <i>y</i>', '> <u>z</u>', '`<s>`', '```', '<iframe>', '```', '| <a> | b |', '|---|---|', '| <c> | d |'].join('\n')
  const html = markdownToHtml(md)
  for (const tag of ['<b>', '<i>', '<u>', '<s>', '<iframe>', '<a>', '<c>']) assert.ok(!html.includes(tag), tag)
})

test('the markup a reply does use comes out', () => {
  assert.equal(markdownToHtml('**bold** and *italic* and `code`'), '<p><strong>bold</strong> and <em>italic</em> and <code>code</code></p>')
  assert.equal(markdownToHtml('# Findings'), '<h2>Findings</h2>') // a reply's "#" is a section, not the page title
  assert.equal(markdownToHtml('1. one\n2. two'), '<ol><li><p>one</p></li><li><p>two</p></li></ol>')
  assert.equal(markdownToHtml('> quoted'), '<blockquote><p>quoted</p></blockquote>')
  assert.equal(markdownToHtml('---'), '<hr>')
})

test('stars inside code stay stars', () => {
  assert.equal(markdownToHtml('`a*b*c`'), '<p><code>a*b*c</code></p>')
})
