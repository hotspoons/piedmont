// The tiny YAML reader `scripts/deploy.mjs` uses for a cluster's `cluster.yaml`.
//
// Its own module so it can be tested: the shape it reads — a flat top level, ONE nested map
// (`cluster:`) and ONE list of maps (`releases:`) — is exactly the shape it used to get wrong.
//
// It dropped the nested `cluster:` block from the arcade import (2026-09) until 2026-10-11: a key
// with no value opened a LIST, so the `namespace:` beneath `cluster:` was discarded and deploy.mjs
// fell back to `default`. That was invisible while cluster.yaml itself said `namespace: default` —
// the two agreed by luck — and became live when the split changed the file to `piedmont`:
// `just deploy gh200-1` would have installed the whole stack into `default`, on top of the arcade's
// own releases, with `--create-namespace` making it look deliberate. The reader now parses the
// nested map and deploy.mjs reads `doc.cluster.namespace`.

import { readFileSync } from 'node:fs'

const clean = (s) => s.trim().replace(/^["']|["']$/g, '')

/** Cut a trailing `# comment`, but not a `#` inside a quoted value (the cluster `note` has none; stay general). */
function stripComment(line) {
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
  }
  return line
}

/**
 * Parse a `cluster.yaml`. Enough for that file and deliberately no more.
 *
 * A container key (`cluster:` with no value) becomes a map or a list by its FIRST child: a `- ` item
 * means a list, anything else a map. Indentation decides nesting through a stack, so the nested
 * `cluster:` map is read rather than dropped.
 */
export function readYaml(file) {
  const out = {}
  const stack = [{ indent: -1, obj: out }]
  const lines = readFileSync(file, 'utf8').split('\n').map(stripComment)
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trimEnd()
    if (!raw.trim()) continue
    const indent = raw.length - raw.trimStart().length
    const t = raw.trim()
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    const parent = stack[stack.length - 1].obj
    if (t.startsWith('- ')) {
      const item = {}
      parent.push(item)
      const [k, ...v] = t.slice(2).split(':')
      if (v.length) item[k.trim()] = clean(v.join(':'))
      stack.push({ indent, obj: item })
      continue
    }
    const [k, ...v] = t.split(':')
    const key = k.trim()
    const value = v.join(':').trim()
    if (value) {
      parent[key] = clean(value)
      continue
    }
    // a key with no value: a nested map or a list, decided by its first child
    const child = lines.slice(i + 1).find((l) => l.trim())?.trim().startsWith('- ') ? [] : {}
    parent[key] = child
    stack.push({ indent, obj: child })
  }
  return out
}
