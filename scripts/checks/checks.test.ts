// The services' own suites (node:test), the linter and the repository checks, run by vitest so
// they fail on the laptop before they fail in CI. Each node:test FILE is its own vitest test: a red
// run names the file and carries its failing TAP block, not three thousand lines of everyone
// else's output.
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain ESM helper with no types; it is what CI's summary step uses
import { failures } from '../ci-failures.mjs'

const root = new URL('../..', import.meta.url).pathname
const suites = ['services/worldeditor', 'services/assetsvc', 'scripts'].flatMap((dir) =>
  readdirSync(join(root, dir))
    .filter((f) => f.endsWith('.test.mjs'))
    .sort()
    .map((f) => `${dir}/${f}`),
)

function run(cmd: string, args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: root, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    p.on('close', (code) => resolve({ code, out }))
  })
}

const report = (out: string) => {
  const blocks = (failures(out) as string[][]).map((b) => b.join('\n'))
  return blocks.length ? blocks.join('\n\n') : out.split('\n').slice(-60).join('\n')
}

describe.concurrent('service tests (node --test)', () => {
  it('found the suites', () => {
    expect(suites.length).toBeGreaterThan(10)
  })
  for (const file of suites) {
    it(file, async () => {
      // node's own per-test limit, under vitest's 180 s: a hung test then fails BY NAME in the TAP
      // block this test reports, instead of vitest timing out the whole file anonymously (CI,
      // 2026-10-11: "Test timed out in 180000ms" and no way to tell which suite)
      const r = await run(process.execPath, ['--test', '--test-reporter=tap', '--test-timeout=150000', file])
      expect(r.code, report(r.out)).toBe(0)
    })
  }
})

describe('lint', () => {
  it('oxlint reports no errors', async () => {
    const r = await run(process.execPath, [join(root, 'node_modules/oxlint/bin/oxlint')])
    expect(r.code, r.out.split('\n').filter((l) => !/warning/.test(l)).slice(-60).join('\n')).toBe(0)
  })
})

describe.concurrent('repository checks', () => {
  // scripts/check-names.mjs: the project's old name nowhere in the repository (docs/dev/project/ORIGIN.md)
  it('names', async () => {
    const r = await run(process.execPath, ['scripts/check-names.mjs'])
    expect(r.code, r.out).toBe(0)
  })
  // scripts/check-pull-policy.mjs: every image pulls with policy Always (deploy/README.md)
  it('pull policy', async () => {
    const r = await run(process.execPath, ['scripts/check-pull-policy.mjs'])
    expect(r.code, r.out).toBe(0)
  })
  // scripts/check-links.mjs: every relative link in the docs resolves
  it('links', async () => {
    const r = await run(process.execPath, ['scripts/check-links.mjs'])
    expect(r.code, r.out).toBe(0)
  })
})
