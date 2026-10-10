#!/usr/bin/env node
// Every image pulls with policy Always — Helm values, the Job and pod specs the world editor builds,
// compose files, all of it (Rich, 2026-10-10: "Policy should be always, always"). A tag like
// `latest` MOVES, and under any other policy a node that has pulled it once keeps running its
// cached copy: the rollout restarts the old image and the fix never lands, silently.
//
// Fails on:
//   - any Kubernetes pull policy (`pullPolicy` / `imagePullPolicy`, YAML or JS) whose value is not
//     `Always` or a Helm template expression that renders a value (`{{ .Values.image.pullPolicy }}`);
//   - any compose `pull_policy` that is not `always`;
//   - the two Kubernetes alternatives, named anywhere at all, even in a comment.
//
// The alternatives are assembled rather than written, so this file passes its own check.
import { ROOT, readText, trackedFiles } from './lib/tracked.mjs'

const BANNED = [['If', 'Not', 'Present'].join(''), ['Ne', 'ver'].join('')]
const root = process.argv.includes('--root') ? process.argv[process.argv.indexOf('--root') + 1] : ROOT
const k8s = /\b(?:image)?[pP]ull[pP]olicy\s*[:=]\s*["'`]?([^\s"'`,}]+(?:\s*\}\})?)/g
const compose = /\bpull_policy\s*:\s*["'`]?([^\s"'`,]+)/g
const anyBanned = new RegExp(`\\b${BANNED[0]}\\b`)
const bannedPolicy = new RegExp(`[pP]ull[_ ]?[pP]olicy[^\\n]{0,40}\\b${BANNED[1]}\\b`)

const hits = []
for (const f of trackedFiles(root)) {
  const text = readText(f, root)
  if (text === null || !/pull|Present/i.test(text)) continue
  text.split('\n').forEach((line, i) => {
    const at = `${f}:${i + 1}: ${line.trim().slice(0, 160)}`
    if (anyBanned.test(line) || bannedPolicy.test(line)) { hits.push(at); return }
    for (const m of line.matchAll(k8s)) {
      const v = m[1]
      if (v === 'Always' || v.startsWith('{{')) continue
      hits.push(at)
    }
    for (const m of line.matchAll(compose)) if (m[1] !== 'always') hits.push(at)
  })
}
if (hits.length) {
  console.error(`check-pull-policy: ${hits.length} image pull polic(ies) other than Always:`)
  for (const h of [...new Set(hits)]) console.error(`  ${h}`)
  process.exit(1)
}
console.log('check-pull-policy: every pull policy is Always')
