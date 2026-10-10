#!/usr/bin/env node
// No trace of the project's old name in this repository: not in a path, an identifier, a string,
// an env var, a package, an image, an API, a storage key, a comment or a doc (docs/ORIGIN.md says
// what the name was and why it went). Case-insensitive. Run by CI and by `npx vitest run`
// (scripts/checks/checks.test.ts).
//
//   node scripts/check-names.mjs            exit 1 and list every hit
//   node scripts/check-names.mjs --root <dir>
//
// The word is assembled here rather than written, so that this file passes its own check.
import { ROOT, readText, trackedFiles } from './lib/tracked.mjs'

const WORD = ['cor', 'ridor'].join('')
const re = new RegExp(WORD, 'i')
const root = process.argv.includes('--root') ? process.argv[process.argv.indexOf('--root') + 1] : ROOT

const hits = []
for (const f of trackedFiles(root)) {
  if (re.test(f)) hits.push(`${f}: in the path`)
  const text = readText(f, root)
  if (text === null || !re.test(text)) continue
  text.split('\n').forEach((line, i) => {
    if (re.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 160)}`)
  })
}
if (hits.length) {
  console.error(`check-names: ${hits.length} reference(s) to the old name (case-insensitive "${WORD}"):`)
  for (const h of hits) console.error(`  ${h}`)
  process.exit(1)
}
console.log('check-names: 0 references')
