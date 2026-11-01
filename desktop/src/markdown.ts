// A small Markdown renderer for the chatbot's replies: paragraphs, headings, lists, quotes, code,
// tables and rules, with bold, italics and inline code. The text is escaped before any markup is
// added, so the HTML is safe to show and to insert into the draft (the editor parses it).

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function inline(s: string): string {
  // Inline code first, so stars inside it stay literal.
  return escape(s)
    .split(/(`[^`]+`)/)
    .map((part) =>
      part.startsWith('`') && part.endsWith('`') && part.length > 1
        ? `<code>${part.slice(1, -1)}</code>`
        : part
            .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`)
            .replace(/(^|[^\w*])\*(?!\s)(.+?)\*(?!\w)|(^|\W)_(?!\s)(.+?)_(?!\w)/g, (_, p1, a, p2, b) => `${p1 ?? p2}<em>${a ?? b}</em>`),
    )
    .join('')
}

const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())

export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let para: string[] = []
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`)
    para = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = line.match(/^\s*```/)
    if (fence) {
      flush()
      const code: string[] = []
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i])
      out.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`)
      continue
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.*?)\s*#*\s*$/)
    if (heading) {
      flush()
      const level = Math.min(heading[1].length + 1, 4) // a reply's "#" is a section, not the page's title
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush()
      out.push('<hr>')
      continue
    }
    const list = line.match(/^\s*([-*+]|\d+[.)])\s+/)
    if (list) {
      flush()
      const ordered = /\d/.test(list[1])
      const items: string[] = []
      for (; i < lines.length; i++) {
        const m = lines[i].match(/^\s*([-*+]|\d+[.)])\s+(.*)$/)
        if (m && /\d/.test(m[1]) === ordered) items.push(m[2])
        else if (items.length && /^\s{2,}\S/.test(lines[i])) items[items.length - 1] += ' ' + lines[i].trim() // a wrapped item
        else break
      }
      i--
      const tag = ordered ? 'ol' : 'ul'
      out.push(`<${tag}>${items.map((it) => `<li><p>${inline(it)}</p></li>`).join('')}</${tag}>`)
      continue
    }
    if (/^\s*>/.test(line)) {
      flush()
      const quote: string[] = []
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s*>\s?/, ''))
      i--
      out.push(`<blockquote>${markdownToHtml(quote.join('\n'))}</blockquote>`)
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
      flush()
      const head = cells(line)
      const rows: string[][] = []
      for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(cells(lines[i]))
      i--
      const tr = (cs: string[], tag: string) => `<tr>${cs.map((c) => `<${tag}><p>${inline(c)}</p></${tag}>`).join('')}</tr>`
      out.push(`<table><tbody>${tr(head, 'th')}${rows.map((r) => tr(r, 'td')).join('')}</tbody></table>`)
      continue
    }
    if (!line.trim()) flush()
    else para.push(line.trim())
  }
  flush()
  return out.join('')
}
