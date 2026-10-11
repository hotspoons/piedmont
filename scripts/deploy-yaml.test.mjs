// The reader behind `just deploy` (scripts/deploy-yaml.mjs). It must read `cluster.yaml`'s NESTED
// `cluster:` map: it did not, so `namespace` fell back to `default` and `just deploy gh200-1` would
// have installed into the arcade's namespace instead of `piedmont`. The real file is asserted too,
// because that is the one the deploy script actually reads.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readYaml } from './deploy-yaml.mjs'

const fixture = (text) => {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-yaml-'))
  const file = join(dir, 'cluster.yaml')
  writeFileSync(file, text)
  return readYaml(file)
}

test('the real deploy/gh200-1/cluster.yaml resolves the namespace it declares', () => {
  const doc = readYaml(new URL('../deploy/gh200-1/cluster.yaml', import.meta.url).pathname)
  // THE regression: `cluster:` is a nested map; dropping it made this `default`.
  assert.equal(doc.cluster?.namespace, 'piedmont')
  assert.equal(doc.cluster?.name, 'gh200-1')
  assert.deepEqual(
    doc.releases.map((r) => r.name),
    ['worldeditor', 'assetsvc', 'overpass-na'],
  )
  for (const r of doc.releases) assert.ok(r.chart, `${r.name} has no chart`)
})

test('a nested map is read, not opened as a list', () => {
  const doc = fixture(['cluster:', '  name: test', '  namespace: somewhere'].join('\n'))
  assert.deepEqual(doc.cluster, { name: 'test', namespace: 'somewhere' })
})

test('a list of maps keeps each item and its indented keys', () => {
  const doc = fixture(
    ['releases:', '  - name: a', '    chart: deploy/helm/a', '  - name: b', '    chart: deploy/helm/b'].join('\n'),
  )
  assert.deepEqual(doc.releases, [
    { name: 'a', chart: 'deploy/helm/a' },
    { name: 'b', chart: 'deploy/helm/b' },
  ])
})

test('quotes and colons survive; comments are cut, but not a # inside a quoted value', () => {
  const doc = fixture(
    [
      'note: "keep # this; and: that"',
      'url: https://example.test/x/api',
      'top: value # trailing comment',
      '# a whole-line comment',
      'empty:',
    ].join('\n'),
  )
  assert.equal(doc.note, 'keep # this; and: that')
  assert.equal(doc.url, 'https://example.test/x/api')
  assert.equal(doc.top, 'value')
  assert.deepEqual(doc.empty, {})
})

test('a map and a list side by side (the real file shape)', () => {
  const doc = fixture(
    ['cluster:', '  namespace: ns', 'releases:', '  - name: one', '    chart: c/one'].join('\n'),
  )
  assert.equal(doc.cluster.namespace, 'ns')
  assert.deepEqual(doc.releases, [{ name: 'one', chart: 'c/one' }])
})
