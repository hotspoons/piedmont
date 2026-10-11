// Two things a run now carries about OSM, against the same fake cluster the sharded tests use.
//
//   1. A BAKE is told which Overpass to read by the extract's real polygon, and is handed the
//      coverage file so it can refuse a query its instance does not hold (osm.py). dc-metro-take-2
//      went to the Maryland instance by a fence and came back without Washington or Virginia.
//   2. An OSM-IMPORT is a run like a bake: one Job, on the Overpass instance's node, with its volume
//      and its scripts ConfigMap; on success the instance's coverage gains the region.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { Coverage } from './coverage.mjs'
import { drawnPolygon } from './osmbuild.mjs'
import { Runs, osmBuildJob, osmImportJob } from './runs.mjs'
import { Store } from './store.mjs'
import { manifest } from '../overpass/osm-import-job.mjs'
import { manifest as buildManifest } from '../overpass/osm-build-job.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (f, ms = 20000) => { const t = Date.now(); while (!(await f())) { if (Date.now() - t > ms) throw new Error('timed out'); await sleep(20) } }

const seed = JSON.parse(await readFile(new URL('./geofabrik-seed.json', import.meta.url), 'utf8'))
const F = (id) => seed.features.find((f) => f.properties.id === id) ?? null

function cluster({ overpassNode = 'gh200-1-node-2' } = {}) {
  const jobs = new Map()
  return {
    jobs,
    available: true,
    namespace: 'default',
    async createJob(spec) {
      jobs.set(spec.metadata.name, { status: { active: 1 }, spec })
      return { metadata: { name: spec.metadata.name } }
    },
    async getJob(name) {
      const j = jobs.get(name)
      if (!j) throw new Error(`no job ${name}`)
      return { metadata: { name }, status: j.status }
    },
    async podsFor(name) { return [{ metadata: { name: `${name}-pod` }, status: { phase: 'Running' } }] },
    async podsByLabel(sel) {
      if (!overpassNode || sel !== 'app=overpass') return []
      return [{ metadata: { name: 'overpass-abc' }, status: { phase: 'Running' }, spec: { nodeName: overpassNode } }]
    },
    async logStream() {
      const s = new PassThrough()
      s.statusCode = 200
      setTimeout(() => s.end(), 5)
      return s
    },
    async deleteJob(name) { jobs.set(name, { ...jobs.get(name), status: { failed: 1 } }) },
  }
}

async function setup(urls, regions) {
  const root = await mkdtemp(path.join(tmpdir(), 'runs-osm-'))
  const store = new Store(root)
  await store.init()
  const coverage = new Coverage(root, { urls: () => urls, regions: () => regions, lookup: async (id) => F(id) })
  await coverage.load()
  return { root, store, coverage }
}

const env = (spec) => Object.fromEntries(spec.spec.template.spec.containers[0].env.map((e) => [e.name, e.value]))
const URLS = ['http://overpass/api/interpreter', 'http://overpass-na/api/interpreter']
const REGIONS = 'overpass=us/maryland, overpass-na=north-america'

test('a dc-metro-take-2 bake is handed overpass-na, the coverage file, and says why in its log', async () => {
  const { root, store, coverage } = await setup(URLS, REGIONS)
  const k8s = cluster()
  try {
    await store.putWorld({ slug: 'dc-metro-take-2', name: 'DC', lat: 38.911621, lon: -77.005045, radius_m: 19933, all_streets: true })
    const runs = new Runs(store, k8s, { force: 'kubernetes', image: 'piedmont-bake:latest', claim: 'data', resources: {}, coverage, overpassUrl: URLS.join(',') })
    const run = await runs.bake('dc-metro-take-2', { sharded: false })
    await until(() => k8s.jobs.size === 1)
    const e = env([...k8s.jobs.values()][0].spec)
    assert.equal(e.PIEDMONT_OVERPASS_URL, 'http://overpass-na/api/interpreter')
    assert.equal(e.PIEDMONT_OVERPASS_COVERAGE, '/data/overpass/coverage.json')
    assert.equal(e.PIEDMONT_OSM_REFRESH, undefined)
    const log = await readFile(store.logFile(run.id), 'utf8')
    assert.match(log, /OSM for dc-metro-take-2: overpass-na \(overpass 3\d\.\d% outside, overpass-na holds it\)/)
    // and the coverage file the bake will read is really there, with Maryland's polygon in it
    const doc = JSON.parse(await readFile(path.join(root, 'overpass', 'coverage.json'), 'utf8'))
    assert.equal(doc.upstreams.find((u) => u.name === 'overpass').regions[0].id, 'us/maryland')
    await runs.cancel(run.id)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('refreshOsm refreshes ONCE: the plan Job asks Overpass again, the shards read what it fetched', async () => {
  const { root, store, coverage } = await setup(URLS, REGIONS)
  const k8s = cluster()
  try {
    await store.putWorld({ slug: 'w', name: 'W', lat: 39.0, lon: -76.7, radius_m: 2000, all_streets: true })
    const runs = new Runs(store, k8s, { force: 'kubernetes', image: 'piedmont-bake:latest', claim: 'data', resources: {}, coverage, overpassUrl: URLS.join(',') })
    const run = await runs.bake('w', { sharded: true, refreshOsm: true })
    await until(() => k8s.jobs.size === 1)
    const e = env([...k8s.jobs.values()][0].spec)
    assert.equal(e.PIEDMONT_OSM_REFRESH, '1')
    // a Maryland world: the Maryland extract first
    assert.equal(e.PIEDMONT_OVERPASS_URL, URLS.join(','))
    assert.match(run.label, /fresh OSM/)
    // the plan finishes; its shards must NOT refresh (2026-10-10: 25 shards each re-asked the
    // whole network at once and one got a non-JSON 200 from an instance under that load)
    await mkdir(path.join(store.sites, 'w', 'plan'), { recursive: true })
    await writeFile(path.join(store.sites, 'w', 'plan', 'shards.json'), JSON.stringify({ n: 2, blocks: [{ index: 0 }, { index: 1 }] }))
    for (const [name, j] of k8s.jobs) if (name.includes('-plan-')) j.status = { succeeded: 1 }
    await until(() => [...k8s.jobs.keys()].filter((n) => n.includes('-shard-')).length === 2)
    for (const [name, j] of k8s.jobs) {
      if (!name.includes('-shard-')) continue
      assert.equal(env(j.spec).PIEDMONT_OSM_REFRESH, undefined, `${name} refreshes`)
      assert.ok(env(j.spec).PIEDMONT_OVERPASS_URL, `${name} still knows its upstreams`)
    }
    await runs.cancel(run.id)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('an osm-import is one Job on the instance\'s node, with its volume and scripts, and adds coverage when it succeeds', async () => {
  const { root, store, coverage } = await setup(URLS, REGIONS)
  const k8s = cluster()
  try {
    const imported = []
    const runs = new Runs(store, k8s, {
      force: 'kubernetes',
      image: 'piedmont-bake:latest',
      claim: 'data',
      resources: {},
      coverage,
      osmImportImage: 'wiktorn/overpass-api@sha256:9bb5',
      onImported: async (r) => {
        imported.push(r.osm.region)
        await coverage.addRegion(r.osm.upstream, F(r.osm.region), { run: r.id })
      },
    })
    const run = await runs.osmImport({ upstream: 'overpass', region: F('us/virginia') })
    assert.equal(run.kind, 'osm-import')
    assert.match(run.label, /add Virginia to overpass/)
    await until(() => k8s.jobs.size === 1)
    const [job] = [...k8s.jobs.values()]
    const pod = job.spec.spec.template.spec
    assert.deepEqual(pod.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].values, ['gh200-1-node-2'])
    assert.equal(pod.volumes.find((v) => v.name === 'db').persistentVolumeClaim.claimName, 'overpass-db')
    assert.equal(pod.volumes.find((v) => v.name === 'scripts').configMap.name, 'overpass-regions')
    assert.equal(pod.containers[0].image, 'wiktorn/overpass-api@sha256:9bb5')
    assert.deepEqual(pod.containers[0].command, ['/bin/bash', '/opt/regions/import.sh'])
    assert.equal(job.spec.spec.backoffLimit, 0)
    const e = env(job.spec)
    assert.equal(e.REGION_ID, 'us/virginia')
    assert.equal(e.PBF_URL, 'https://download.geofabrik.de/north-america/us/virginia-latest.osm.pbf')
    assert.equal(e.INTERPRETER, 'http://overpass/api/interpreter')

    // one at a time per instance: they share one disk and one dispatcher
    await assert.rejects(runs.osmImport({ upstream: 'overpass', region: F('us/district-of-columbia') }), /already has an import running/)

    // before: dc-metro goes to North America. The Job succeeds...
    job.status = { succeeded: 1 }
    await until(async () => JSON.parse(await readFile(store.runFile(run.id), 'utf8')).state === 'done')
    assert.deepEqual(imported, ['us/virginia'])
    const ov = coverage.upstreams().find((u) => u.name === 'overpass')
    assert.deepEqual(ov.regions.map((r) => r.id).sort(), ['us/maryland', 'us/virginia'])
    assert.match(await readFile(store.logFile(run.id), 'utf8'), /coverage: overpass now holds us\/virginia/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('an import is refused, by name, when the instance is not running or the editor is not in a cluster', async () => {
  const { root, store, coverage } = await setup(URLS, REGIONS)
  try {
    const down = new Runs(store, cluster({ overpassNode: null }), { force: 'kubernetes', coverage })
    await assert.rejects(down.osmImport({ upstream: 'overpass', region: F('us/virginia') }), /overpass has no running pod/)
    const laptop = new Runs(store, { ...cluster(), available: false }, { force: 'local', coverage })
    await assert.rejects(laptop.osmImport({ upstream: 'overpass', region: F('us/virginia') }), /not running in one/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('an osm-build is one Job on the instance, with the drawn shape and the covering extracts, and adds a build region', async () => {
  const { root, store, coverage } = await setup(URLS, REGIONS)
  const k8s = cluster()
  try {
    const polygon = drawnPolygon([[-77.2, 38.8], [-76.9, 38.8], [-76.9, 39.0]])
    const sources = [
      { id: 'us/maryland', name: 'us/maryland', pbf: 'https://download.geofabrik.de/north-america/us/maryland-latest.osm.pbf', updates: 'https://download.geofabrik.de/north-america/us/maryland-updates', bytes: 123 },
    ]
    const runs = new Runs(store, k8s, {
      force: 'kubernetes',
      image: 'piedmont-bake:latest',
      claim: 'data',
      resources: {},
      coverage,
      osmImportImage: 'wiktorn/overpass-api@sha256:9bb5',
      onImported: async (r) => {
        // the server's branch (server.mjs onImported): a build's outline is the polygon, not a lookup
        if (r.kind === 'osm-build') {
          await coverage.addRegion(r.osm.upstream, { type: 'Feature', properties: { id: r.osm.region, name: r.osm.name }, geometry: { type: 'Polygon', coordinates: [r.osm.polygon] } }, { source: 'build', run: r.id })
          return
        }
        await coverage.addRegion(r.osm.upstream, F(r.osm.region), { run: r.id })
      },
    })
    const run = await runs.osmBuild({ upstream: 'overpass', polygon, sources, name: 'my patch' })
    assert.equal(run.kind, 'osm-build')
    assert.match(run.label, /build my patch/)
    assert.match(run.slug, /overpass-build-mypatch-[0-9a-f]{6}/)
    await until(() => k8s.jobs.size === 1)
    const [job] = [...k8s.jobs.values()]
    const pod = job.spec.spec.template.spec
    assert.equal(job.spec.metadata.labels['worldeditor/kind'], 'osm-build')
    assert.equal(pod.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].values[0], 'gh200-1-node-2')
    assert.equal(pod.volumes.find((v) => v.name === 'db').persistentVolumeClaim.claimName, 'overpass-db')
    assert.equal(pod.volumes.find((v) => v.name === 'scripts').configMap.name, 'overpass-regions')
    assert.equal(pod.containers[0].image, 'wiktorn/overpass-api@sha256:9bb5')
    // the same script as an import: the instance's sidecar does the apply either way
    assert.deepEqual(pod.containers[0].command, ['/bin/bash', '/opt/regions/import.sh'])
    const e = env(job.spec)
    assert.equal(e.REGION_ID, run.osm.region)
    assert.equal(e.PBF_URLS, sources[0].pbf)
    assert.equal(e.UPDATES_URL, undefined, 'a drawn area follows no diff stream')
    const poly = Buffer.from(e.POLYGON_POLY_B64, 'base64').toString('utf8')
    assert.match(poly, /^my patch\n1\n/)
    assert.match(poly, /-77\.2000000 38\.8000000/)

    // one at a time ACROSS kinds: they share one disk and one dispatcher
    await assert.rejects(runs.osmImport({ upstream: 'overpass', region: F('us/district-of-columbia') }), /already has a build running/)

    job.status = { succeeded: 1 }
    await until(async () => JSON.parse(await readFile(store.runFile(run.id), 'utf8')).state === 'done')
    const ov = coverage.upstreams().find((u) => u.name === 'overpass')
    const built = ov.regions.find((r) => r.source === 'build')
    assert.ok(built, 'the drawn area is in coverage, as a build region')
    assert.equal(built.id, run.osm.region)
    assert.equal(built.name, 'my patch')
    assert.match(await readFile(store.logFile(run.id), 'utf8'), /coverage: overpass now holds/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('a build is refused by name when the instance is down, and two unnamed draws get their own regions', async () => {
  const { root, store, coverage } = await setup(URLS, REGIONS)
  try {
    const polygon = drawnPolygon([[-77.2, 38.8], [-76.9, 38.8], [-76.9, 39.0]])
    const down = new Runs(store, cluster({ overpassNode: null }), { force: 'kubernetes', coverage })
    await assert.rejects(down.osmBuild({ upstream: 'overpass', polygon, sources: [{ pbf: 'x' }] }), /overpass has no running pod/)
    const laptop = new Runs(store, { ...cluster(), available: false }, { force: 'local', coverage })
    await assert.rejects(laptop.osmBuild({ upstream: 'overpass', polygon, sources: [{ pbf: 'x' }] }), /not running in one/)

    const runs = new Runs(store, cluster(), { force: 'kubernetes', coverage, osmImportImage: 'i' })
    const a = await runs.osmBuild({ upstream: 'overpass', polygon, sources: [{ pbf: 'x' }] })
    // the same shape and (default) name is the same region: rebuilding it is idempotent, not a dupe
    await runs.cancel(a.id)
    const again = await runs.osmBuild({ upstream: 'overpass', polygon, sources: [{ pbf: 'x' }] })
    assert.equal(again.osm.region, a.osm.region)
    // a DIFFERENT shape under the same default name must NOT collide, or it would be skipped as done
    await runs.cancel(again.id)
    const other = await runs.osmBuild({ upstream: 'overpass', polygon: drawnPolygon([[-80, 36], [-79, 36], [-79, 37]]), sources: [{ pbf: 'x' }] })
    assert.notEqual(other.osm.region, a.osm.region)
    await runs.cancel(other.id)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
})

test('the reviewed manifest is exactly what the editor creates', async () => {
  // services/overpass/osm-import-job.yaml is what an admin reads; this holds it to the code
  const onDisk = await readFile(new URL('../overpass/osm-import-job.yaml', import.meta.url), 'utf8')
  assert.equal(onDisk, manifest(osmImportJob), 'regenerate with: node services/overpass/osm-import-job.mjs > services/overpass/osm-import-job.yaml')
})

test('the reviewed BUILD manifest is exactly what the editor creates', async () => {
  const onDisk = await readFile(new URL('../overpass/osm-build-job.yaml', import.meta.url), 'utf8')
  assert.equal(onDisk, buildManifest(osmBuildJob), 'regenerate with: node services/overpass/osm-build-job.mjs > services/overpass/osm-build-job.yaml')
})
