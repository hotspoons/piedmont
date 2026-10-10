#!/usr/bin/env node
// Move the arcade pin: `npm run arcade:bump <ref>`.
//
// <ref> is anything the arcade's remote can name — a full or short sha, a tag (engine-v2026.10.10),
// a branch — and it is resolved to the full sha it points at NOW, because a pin that moves by
// itself is not a pin. Short shas are looked up in ext/siomporas-arcade when it is checked out
// (a remote cannot expand them). Then run `npm run setup` to fetch and link it.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const file = join(ROOT, 'arcade.json')
const pin = JSON.parse(readFileSync(file, 'utf8'))
const ref = process.argv[2]
if (!ref) {
  console.error('usage: npm run arcade:bump <sha|tag|branch>')
  process.exit(2)
}
const git = (argv, cwd) => execFileSync('git', argv, { encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'pipe'] }).trim()

let sha = null
if (/^[0-9a-f]{40}$/.test(ref)) sha = ref
const ext = join(ROOT, 'ext/siomporas-arcade')
if (!sha && existsSync(ext)) {
  try { sha = git(['rev-parse', '--verify', `${ref}^{commit}`], ext) } catch { /* not known locally */ }
}
if (!sha) {
  const repo = process.env.PIEDMONT_ARCADE_REPO ?? pin.repo
  const out = git(['ls-remote', repo, ref, `refs/tags/${ref}^{}`])
  // a peeled annotated tag (^{}) names the commit; prefer it over the tag object
  const lines = out.split('\n').filter(Boolean).map((l) => l.split('\t'))
  const hit = lines.find(([, n]) => n.endsWith('^{}')) ?? lines[0]
  if (!hit) {
    console.error(`arcade:bump: ${repo} has no ref called ${ref} (short shas need ext/siomporas-arcade checked out)`)
    process.exit(1)
  }
  sha = hit[0]
}
const was = pin.ref
pin.ref = sha
writeFileSync(file, JSON.stringify(pin, null, 2) + '\n')
console.log(`arcade.json: ${was.slice(0, 12)} -> ${sha.slice(0, 12)} (${ref}). Now: npm run setup, then npx tsc -b && npx vitest run.`)
