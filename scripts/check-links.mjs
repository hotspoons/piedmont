#!/usr/bin/env node
// Every relative link in every Markdown file resolves to a file or directory in this repository.
// External links (http, https, mailto) are not fetched: CI must not go red because a third-party
// site is down. A link into vendor/ or ext/ is refused — those are not part of a clone until setup
// runs, and a doc that depends on them is a doc that 404s on GitHub.
//
//   node scripts/check-links.mjs     exit 1 and list every broken link
import { existsSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'
import { ROOT, readText, trackedFiles } from './lib/tracked.mjs'

const files = trackedFiles().filter((f) => f.endsWith('.md'))
const link = /!?\[(?:[^\][]|\[[^\]]*\])*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g
const bad = []
let checked = 0
for (const f of files) {
  const text = readText(f)
  if (text === null) continue
  // fenced code is example text, not a link
  const prose = text.replace(/^(```|~~~)[\s\S]*?^\1/gm, (m) => m.replace(/[^\n]/g, ' '))
  prose.split('\n').forEach((line, i) => {
    for (const m of line.replace(/`[^`]*`/g, (c) => ' '.repeat(c.length)).matchAll(link)) {
      const target = m[1]
      if (/^(https?:|mailto:|#|data:)/.test(target)) continue
      checked++
      const path = decodeURIComponent(target.split('#')[0].split('?')[0])
      if (!path) continue
      const abs = path.startsWith('/') ? join(ROOT, path) : join(ROOT, dirname(f), path)
      const rel = normalize(relative(ROOT, abs))
      if (rel.startsWith('..')) bad.push(`${f}:${i + 1}: ${target} (outside the repository)`)
      else if (/^(vendor|ext|\.cache|data)\//.test(rel) && rel !== 'ext/README.md') bad.push(`${f}:${i + 1}: ${target} (into ${rel.split('/')[0]}/, which a clone does not have)`)
      else if (!existsSync(abs)) bad.push(`${f}:${i + 1}: ${target}`)
    }
  })
}
if (bad.length) {
  console.error(`check-links: ${bad.length} broken link(s) of ${checked} checked:`)
  for (const b of bad) console.error(`  ${b}`)
  process.exit(1)
}
console.log(`check-links: ${checked} relative links in ${files.length} Markdown files, all resolve`)
