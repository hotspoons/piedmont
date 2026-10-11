// The Docker runner, against a FAKE Docker Engine served on a unix socket in this process.
//
// Not a mock of DockerJobs' methods: the real DockerEngine client speaks HTTP over a real socket to
// a server that answers the Engine API's paths in the Engine API's shapes — the multiplexed log
// stream, the pull that reports failure inside a 200, label filters as JSON in the query. What is
// asserted is what the DAEMON was asked to do: the create bodies, the order of pulls and starts, how
// many containers were running at once.
import assert from 'node:assert/strict'
import http from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { DockerJobs, bytesOf, containerBody, cpuOf, demuxer, gpuList, jobBackend, parseImage, selectorMatch, sinceOf } from './docker.mjs'
import { K8s } from './k8s.mjs'
import { Runs } from './runs.mjs'
import { Store } from './store.mjs'
import * as training from './training.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (f, ms = 30000, what = 'condition') => {
  const t = Date.now()
  while (!(await f())) {
    if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`)
    await sleep(20)
  }
}

/* ---- the fake daemon ---- */

function frame(stream, text) {
  const payload = Buffer.from(text)
  const h = Buffer.alloc(8)
  h[0] = stream
  h.writeUInt32BE(payload.length, 4)
  return Buffer.concat([h, payload])
}

async function fakeDocker(dir, { ncpu = 8, images = [], badImages = [] } = {}) {
  const socketPath = path.join(dir, 'docker.sock')
  const state = {
    containers: new Map(), // name -> { name, body, State, ExitCode, OOMKilled, StartedAt, FinishedAt, logs: [] }
    images: new Set(images),
    pulls: [],
    calls: [],
    maxRunning: 0,
    volumesRemoved: [],
  }
  const running = () => [...state.containers.values()].filter((c) => c.State === 'running').length
  const send = (res, code, body) => {
    const buf = Buffer.from(body === undefined ? '' : JSON.stringify(body))
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': buf.length })
    res.end(buf)
  }
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const raw = Buffer.concat(chunks).toString('utf8')
    const body = raw ? JSON.parse(raw) : undefined
    const u = new URL(req.url, 'http://docker')
    const p = u.pathname.replace(/^\/v[0-9.]+/, '')
    state.calls.push(`${req.method} ${p}`)
    let m
    if (p === '/_ping') return res.end('OK')
    if (p === '/info') return send(res, 200, { NCPU: ncpu, MemTotal: 64 * 2 ** 30 })
    if (req.method === 'POST' && p === '/images/create') {
      const ref = `${u.searchParams.get('fromImage')}${u.searchParams.get('tag') ? `:${u.searchParams.get('tag')}` : ''}`
      state.pulls.push({ ref, auth: req.headers['x-registry-auth'] ?? null })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.write(`${JSON.stringify({ status: `Pulling from ${ref}` })}\n`)
      if (badImages.includes(ref)) res.write(`${JSON.stringify({ errorDetail: { message: 'manifest unknown' }, error: 'manifest unknown' })}\n`)
      else {
        res.write(`${JSON.stringify({ status: 'Download complete' })}\n`)
        state.images.add(ref)
      }
      return res.end()
    }
    if ((m = /^\/images\/(.+)\/json$/.exec(p))) return state.images.has(decodeURIComponent(m[1])) ? send(res, 200, { Id: 'sha256:x' }) : send(res, 404, { message: 'No such image' })
    if (req.method === 'POST' && p === '/containers/create') {
      const name = u.searchParams.get('name')
      if (state.containers.has(name)) return send(res, 409, { message: `Conflict. The container name "/${name}" is already in use` })
      if (!state.images.has(body.Image) && !state.images.has(`${body.Image}:latest`)) return send(res, 404, { message: `No such image: ${body.Image}` })
      state.containers.set(name, { name, body, State: 'created', ExitCode: 0, OOMKilled: false, logs: [] })
      return send(res, 201, { Id: `id-${name}`, Warnings: [] })
    }
    if (req.method === 'GET' && p === '/containers/json') {
      const filters = JSON.parse(u.searchParams.get('filters') || '{}')
      const want = filters.label ?? []
      const list = [...state.containers.values()]
        .filter((c) => want.every((kv) => {
          const [k, v] = kv.split('=')
          return v === undefined ? k in c.body.Labels : c.body.Labels[k] === v
        }))
        .map((c) => ({ Id: `id-${c.name}`, Names: [`/${c.name}`], State: c.State, Status: c.State, Labels: c.body.Labels }))
      return send(res, 200, list)
    }
    if ((m = /^\/containers\/([^/]+)(\/[a-z]+)?$/.exec(p))) {
      const name = decodeURIComponent(m[1])
      const c = state.containers.get(name)
      const verb = m[2] ?? ''
      if (!c) return send(res, 404, { message: `No such container: ${name}` })
      if (req.method === 'POST' && verb === '/start') {
        c.State = 'running'
        c.StartedAt = new Date().toISOString()
        state.maxRunning = Math.max(state.maxRunning, running())
        return send(res, 204)
      }
      if (req.method === 'POST' && verb === '/stop') {
        if (c.State !== 'running') return send(res, 304)
        c.State = 'exited'
        c.ExitCode = 143
        c.FinishedAt = new Date().toISOString()
        return send(res, 204)
      }
      if (req.method === 'DELETE' && verb === '') {
        state.containers.delete(name)
        return send(res, 204)
      }
      if (req.method === 'GET' && verb === '/json') {
        return send(res, 200, { Name: `/${name}`, State: { Status: c.State, ExitCode: c.ExitCode, OOMKilled: c.OOMKilled, StartedAt: c.StartedAt, FinishedAt: c.FinishedAt, Error: '' }, Config: { Tty: false } })
      }
      if (req.method === 'GET' && verb === '/logs') {
        state.lastLogQuery = Object.fromEntries(u.searchParams)
        res.writeHead(200, { 'Content-Type': 'application/vnd.docker.multiplexed-stream' })
        for (const l of c.logs) res.write(frame(l.stream ?? 1, `${l.stamp} ${l.text}`))
        return res.end()
      }
    }
    if ((m = /^\/volumes\/(.+)$/.exec(p)) && req.method === 'DELETE') {
      state.volumesRemoved.push(decodeURIComponent(m[1]))
      return send(res, 204)
    }
    send(res, 404, { message: `fake docker: no route ${req.method} ${p}` })
  })
  await new Promise((r) => server.listen(socketPath, r))
  return {
    socketPath,
    state,
    running,
    started: () => [...state.containers.values()].filter((c) => c.State !== 'created'),
    /** let a container end, as its process would */
    exit(name, code = 0, { oom = false } = {}) {
      const c = state.containers.get(name)
      if (!c) throw new Error(`no container ${name}`)
      c.State = 'exited'
      c.ExitCode = code
      c.OOMKilled = oom
      c.FinishedAt = new Date().toISOString()
    },
    close: () => new Promise((r) => server.close(r)),
  }
}

async function setup(opts = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'docker-runner-'))
  const docker = await fakeDocker(root, opts)
  const data = path.join(root, 'srv', 'data')
  await mkdir(data, { recursive: true })
  const jobs = new DockerJobs({
    socketPath: docker.socketPath,
    root: path.join(root, 'srv'),
    claims: { 'piedmont-data': data },
    network: 'piedmont',
    maxParallel: opts.maxParallel ?? 1,
    gpus: opts.gpus ?? 0,
    pollMs: 50,
    authFile: opts.authFile ?? null,
    log: () => {},
  })
  const done = async () => {
    jobs.close()
    await docker.close()
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
  }
  return { root, data, docker, jobs, done }
}

/** A Job the way the code builds them: one container, a claim, a GPU if asked. */
function job(name, { gpus = 0, parallelism = 1, kind = 'bake', image = 'piedmont-bake:sha-1', inits = [], deadline = null, ttl = null } = {}) {
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name, labels: { 'worldeditor/kind': kind, 'piedmont.run': name } },
    spec: {
      backoffLimit: 0,
      parallelism,
      completions: parallelism,
      ...(deadline ? { activeDeadlineSeconds: deadline } : {}),
      ...(ttl !== null ? { ttlSecondsAfterFinished: ttl } : {}),
      template: {
        metadata: { labels: { 'piedmont.run': name } },
        spec: {
          restartPolicy: 'Never',
          ...(inits.length ? { initContainers: inits } : {}),
          containers: [{
            name: 'main',
            image,
            command: ['sh', '-c'],
            args: ['echo $(GREETING) && run'],
            env: [{ name: 'GREETING', value: 'hello' }],
            resources: { limits: { cpu: '64', memory: '384Gi', ...(gpus ? { 'nvidia.com/gpu': String(gpus) } : {}) }, requests: { memory: '32Gi' } },
            volumeMounts: [{ name: 'data', mountPath: '/data' }, { name: 'scratch', mountPath: '/scratch' }],
          }],
          volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'piedmont-data' } }, { name: 'scratch', emptyDir: {} }],
        },
      },
    },
  }
}

/* ---- the pure parts ---- */

test('quantities, image references, pull policy, selectors, gpu lists', () => {
  assert.equal(cpuOf('500m'), 0.5)
  assert.equal(cpuOf('16'), 16)
  assert.equal(bytesOf('32Gi'), 32 * 2 ** 30)
  assert.equal(bytesOf('512M'), 512e6)
  assert.equal(bytesOf('2048'), 2048)
  assert.deepEqual(parseImage('ghcr.io/hotspoons/piedmont-bake:latest'), { name: 'ghcr.io/hotspoons/piedmont-bake', tag: 'latest', digest: null, registry: 'ghcr.io' })
  assert.deepEqual(parseImage('localhost:5000/x'), { name: 'localhost:5000/x', tag: null, digest: null, registry: 'localhost:5000' })
  assert.equal(parseImage('wiktorn/overpass-api@sha256:abc').digest, 'sha256:abc')
  assert.equal(parseImage('wiktorn/overpass-api').registry, 'docker.io')
  const sel = selectorMatch('app=overpass,tier!=db')
  assert.equal(sel({ app: 'overpass' }), true)
  assert.equal(sel({ app: 'overpass', tier: 'db' }), false)
  assert.equal(sel({ app: 'overpass-na' }), false)
  assert.deepEqual(gpuList('3'), ['0', '1', '2'])
  assert.deepEqual(gpuList('0,2'), ['0', '2'])
  assert.deepEqual(gpuList(0), [])
  assert.equal(sinceOf('2026-10-10T12:00:00.5Z'), `${Date.parse('2026-10-10T12:00:00Z') / 1000}.500000000`)
})

test('a Job container becomes a create body: entrypoint, env, binds, limits clamped to the host, labels, network', () => {
  const j = job('piedmont-bake-w-1', { gpus: 2 })
  j.spec.template.spec.containers[0].envFrom = [{ secretRef: { name: 'piedmont-r2', optional: true } }]
  j.spec.template.spec.containers[0].volumeMounts.push({ name: 'cfg', mountPath: '/opt/regions', readOnly: false })
  j.spec.template.spec.volumes.push({ name: 'cfg', configMap: { name: 'overpass-regions' } })
  const { body, warnings } = containerBody({
    job: j,
    pod: { name: 'piedmont-bake-w-1-0', index: 0 },
    container: j.spec.template.spec.containers[0],
    podSpec: j.spec.template.spec,
    ctx: {
      network: 'piedmont',
      volume: (v) => (v.persistentVolumeClaim ? '/srv/piedmont/data' : v.configMap ? `/srv/piedmont/configmaps/${v.configMap.name}` : null),
      secretEnv: (name) => (name === 'piedmont-r2' ? ['AWS_ACCESS_KEY_ID=placeholder'] : []),
      gpuIds: ['1', '3'],
      ncpu: 16,
      shmSize: 2 ** 30,
      extraLabels: { 'worldeditor.docker/managed': 'true' },
    },
  })
  assert.deepEqual(warnings, [])
  assert.equal(body.Image, 'piedmont-bake:sha-1')
  assert.deepEqual(body.Entrypoint, ['sh', '-c'])
  assert.deepEqual(body.Cmd, ['echo hello && run'], '$(VAR) expands from the container env, as the kubelet does')
  assert.ok(body.Env.includes('GREETING=hello'))
  assert.ok(body.Env.includes('AWS_ACCESS_KEY_ID=placeholder'), 'envFrom secretRef is read from the secrets dir')
  assert.deepEqual(body.HostConfig.Binds, ['/srv/piedmont/data:/data', '/srv/piedmont/configmaps/overpass-regions:/opt/regions:ro'])
  assert.deepEqual(body.HostConfig.Mounts, [{ Type: 'volume', Source: 'piedmont-bake-w-1-0-scratch', Target: '/scratch', ReadOnly: false }])
  assert.equal(body.HostConfig.NanoCpus, 16e9, '64 CPUs on a 16-CPU host is clamped, not refused')
  assert.equal(body.HostConfig.Memory, 384 * 2 ** 30)
  assert.equal(body.HostConfig.MemoryReservation, 32 * 2 ** 30)
  assert.deepEqual(body.HostConfig.DeviceRequests, [{ Driver: 'nvidia', DeviceIDs: ['1', '3'], Capabilities: [['gpu']] }])
  assert.deepEqual(body.HostConfig.RestartPolicy, { Name: 'no' })
  assert.equal(body.HostConfig.NetworkMode, 'piedmont')
  assert.deepEqual(body.NetworkingConfig.EndpointsConfig.piedmont.Aliases, ['piedmont-bake-w-1-0'])
  assert.equal(body.Labels['job-name'], 'piedmont-bake-w-1')
  assert.equal(body.Labels['worldeditor/kind'], 'bake')
  assert.equal(body.Labels['worldeditor.docker/managed'], 'true')
  // no ids allocated: Count, the way `docker run --gpus 2` asks
  const counted = containerBody({ job: j, pod: { name: 'p', index: 0 }, container: j.spec.template.spec.containers[0], podSpec: j.spec.template.spec, ctx: { volume: () => '/x', secretEnv: () => [], gpuIds: null, ncpu: 0 } })
  assert.deepEqual(counted.body.HostConfig.DeviceRequests, [{ Driver: 'nvidia', Count: 2, Capabilities: [['gpu']] }])
  assert.equal(counted.body.HostConfig.NanoCpus, 64e9, 'with no host CPU count known the limit is passed through')
})

test('the log demuxer strips frames, pads stamps to nine digits, and drops the stamp of a continued line', async () => {
  const d = demuxer()
  let out = ''
  d.on('data', (c) => (out += c))
  const whole = Buffer.concat([
    frame(1, '2026-10-10T12:00:00.5Z first\n'),
    frame(2, '2026-10-10T12:00:01.000000001Z long-'),
    frame(2, '2026-10-10T12:00:01.000000002Z line\n'),
  ])
  // delivered in awkward pieces, across frame boundaries
  for (let i = 0; i < whole.length; i += 7) d.write(whole.subarray(i, i + 7))
  d.end()
  await new Promise((r) => d.on('end', r))
  assert.equal(out, '2026-10-10T12:00:00.500000000Z first\n2026-10-10T12:00:01.000000001Z long-line\n')
})

/* ---- the lifecycle against the daemon ---- */

test('create -> pull -> start -> running -> exit 0 -> succeeded; logs come back stamped; delete removes', async () => {
  const s = await setup({ images: [] })
  try {
    const made = await s.jobs.createJob(job('j1', { image: 'ghcr.io/x/piedmont-bake:latest' }))
    assert.equal(made.metadata.name, 'j1')
    await until(() => s.docker.running() === 1, 5000, 'the pod to start')
    assert.deepEqual(s.docker.state.pulls.map((p) => p.ref), ['ghcr.io/x/piedmont-bake:latest'], 'pulled before it ran (Always)')
    const pullAt = s.docker.state.calls.indexOf('POST /images/create')
    const createAt = s.docker.state.calls.indexOf('POST /containers/create')
    assert.ok(pullAt >= 0 && pullAt < createAt, 'the pull came before the create')
    // The daemon has started it; the runner records Running when its own loop next looks, as a
    // kubelet does. Asserting right after the daemon's start raced that on CI's slower runners.
    let pods = []
    await until(async () => {
      pods = await s.jobs.podsFor('j1')
      return pods.length === 1 && pods[0].status.phase === 'Running'
    }, 5000, 'the runner to report the pod Running')
    let j = await s.jobs.getJob('j1')
    assert.equal(j.status.active, 1)

    const c = s.docker.state.containers.get(pods[0].metadata.name)
    c.logs.push({ stamp: '2026-10-10T12:00:00.1Z', text: 'baking\n' }, { stamp: '2026-10-10T12:00:02Z', text: 'done\n', stream: 2 })
    const res = await s.jobs.logStream(pods[0].metadata.name, { follow: true, sinceTime: '2026-10-10T11:59:59.000000000Z' })
    assert.equal(res.statusCode, 200)
    let text = ''
    for await (const chunk of res) text += chunk
    assert.equal(text, '2026-10-10T12:00:00.100000000Z baking\n2026-10-10T12:00:02.000000000Z done\n')
    assert.equal(s.docker.state.lastLogQuery.timestamps, 'true')
    assert.equal(s.docker.state.lastLogQuery.since, `${Date.parse('2026-10-10T11:59:59Z') / 1000}.000000000`)

    s.docker.exit(pods[0].metadata.name, 0)
    await until(async () => (await s.jobs.getJob('j1')).status.succeeded === 1, 5000, 'succeeded')
    j = await s.jobs.getJob('j1')
    assert.equal(j.status.conditions[0].type, 'Complete')
    assert.equal(j.status.active, undefined)

    await s.jobs.deleteJob('j1')
    await assert.rejects(s.jobs.getJob('j1'), (e) => e.status === 404)
    await until(() => !s.docker.state.containers.has(pods[0].metadata.name), 5000, 'the container to be removed')
    // the runner removes the pod's volume after its container, a beat later on a slow runner
    await until(() => s.docker.state.volumesRemoved.includes('j1-0-scratch'), 5000, 'the pod-scoped emptyDir volume to go with it')
  } finally {
    await s.done()
  }
})

test('a failed pod fails the Job with the reason; OOM is named; a pull error inside a 200 fails the pod', async () => {
  const s = await setup({ images: ['piedmont-bake:sha-1'], badImages: ['ghcr.io/x/missing:latest'] })
  try {
    await s.jobs.createJob(job('bad', { kind: 'publish' }))
    await s.jobs.createJob(job('oom', { kind: 'publish' }))
    await s.jobs.createJob(job('nopull', { kind: 'publish', image: 'ghcr.io/x/missing:latest' }))
    await until(() => s.docker.running() === 2, 5000, 'two pods running')
    s.docker.exit('bad-0', 3)
    s.docker.exit('oom-0', 137, { oom: true })
    await until(async () => (await s.jobs.getJob('bad')).status.failed === 1, 5000, 'bad to fail')
    const bad = await s.jobs.getJob('bad')
    assert.equal(bad.status.conditions[0].type, 'Failed')
    assert.match(bad.status.conditions[0].message, /exited 3/)
    await until(async () => (await s.jobs.getJob('oom')).status.failed === 1, 5000, 'oom to fail')
    assert.match((await s.jobs.getJob('oom')).status.conditions[0].message, /out of memory/)
    // the silent-success family: HTTP 200, and the body says it failed
    await until(async () => (await s.jobs.getJob('nopull')).status.failed === 1, 5000, 'the pull failure to surface')
    assert.match((await s.jobs.getJob('nopull')).status.conditions[0].message, /manifest unknown/)
    assert.equal(s.docker.state.containers.has('nopull-0'), false, 'nothing was created from an image that never arrived')
  } finally {
    await s.done()
  }
})

test('every create pulls first, whatever the tag or the spec\'s pull policy ("always, always")', async () => {
  const s = await setup({ images: ['piedmont-bake:sha-1', 'pinned@sha256:abc'] })
  try {
    // No policy in the spec: for a pinned (non-latest) tag or a digest, Kubernetes' default would
    // run the copy already present without pulling. The arcade's version of this test set a
    // non-Always policy explicitly; piedmont's pull-policy check bans those values in every tracked
    // file, tests included, so the default case stands in for it.
    const pinned = job('pinned', { kind: 'publish', image: 'piedmont-bake:sha-1' })
    await s.jobs.createJob(pinned)
    await s.jobs.createJob(job('digest', { kind: 'publish', image: 'pinned@sha256:abc' }))
    await until(() => s.docker.running() === 2, 5000, 'both to run')
    assert.deepEqual(s.docker.state.pulls.map((p) => p.ref).sort(), ['piedmont-bake:sha-1', 'pinned@sha256:abc'], 'a pinned tag and a digest were pulled, though both were already here')
  } finally {
    await s.done()
  }
})

test('a pull that fails with the image already here runs the local copy, and the run\'s log says so', async () => {
  const s = await setup({ images: ['ghcr.io/x/missing:latest'], badImages: ['ghcr.io/x/missing:latest'] })
  try {
    await s.jobs.createJob(job('offline', { image: 'ghcr.io/x/missing:latest' }))
    await until(() => s.docker.running() === 1, 5000, 'the local copy to run')
    s.docker.state.containers.get('offline-0').logs.push({ stamp: '2099-01-01T00:00:00Z', text: 'baking\n' })
    let text = ''
    for await (const c of await s.jobs.logStream('offline-0', { follow: true })) text += c
    const lines = text.trim().split('\n')
    assert.match(lines[0], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{9}Z \[docker\] WARNING: could not pull ghcr\.io\/x\/missing:latest \(.*manifest unknown.*\); running the copy already on this host/)
    assert.match(lines[1], / baking$/)
    // a reconnect past the warning does not print it twice
    let again = ''
    for await (const c of await s.jobs.logStream('offline-0', { follow: true, sinceTime: lines[0].split(' ')[0] })) again += c
    assert.doesNotMatch(again, /WARNING/)
  } finally {
    await s.done()
  }
})

test('GPU pods get distinct device ids, and a pod waits (Pending) until enough are free', async () => {
  const s = await setup({ images: ['piedmont-bake:sha-1'], gpus: '0,1' })
  try {
    await s.jobs.createJob(job('train', { gpus: 1, parallelism: 2, kind: 'splat' }))
    await s.jobs.createJob(job('train2', { gpus: 1, kind: 'splat' }))
    await until(() => s.docker.running() === 2, 5000, 'two GPU pods')
    const ids = ['train-0', 'train-1'].map((n) => s.docker.state.containers.get(n).body.HostConfig.DeviceRequests[0].DeviceIDs)
    assert.deepEqual(ids.flat().sort(), ['0', '1'], 'each pod its own GPU')
    await sleep(300)
    assert.equal(s.docker.state.containers.has('train2-0'), false, 'no GPU free: not created at all')
    assert.equal((await s.jobs.podsFor('train2'))[0].status.phase, 'Pending')
    const freed = s.docker.state.containers.get('train-1').body.HostConfig.DeviceRequests[0].DeviceIDs[0]
    s.docker.exit('train-1', 0)
    await until(() => s.docker.state.containers.get('train2-0')?.State === 'running', 5000, 'the waiting pod to start')
    assert.deepEqual(s.docker.state.containers.get('train2-0').body.HostConfig.DeviceRequests[0].DeviceIDs, [freed], 'it got the GPU that was freed')
    // more GPUs than the host has: a failure that says so, not a pod Pending for ever
    await s.jobs.createJob(job('greedy', { gpus: 3, kind: 'splat' }))
    await until(async () => (await s.jobs.getJob('greedy')).status.failed === 1, 5000, 'greedy to fail')
    assert.match((await s.jobs.getJob('greedy')).status.conditions[0].message, /asks for 3 GPUs/)
  } finally {
    await s.done()
  }
})

test('init containers run first, in order, and a failed init fails the pod without starting the main one', async () => {
  const s = await setup({ images: ['piedmont-bake:sha-1'] })
  try {
    const inits = [{ name: 'assert-code', image: 'piedmont-bake:sha-1', command: ['check'] }]
    await s.jobs.createJob(job('ok', { kind: 'splat', inits }))
    await s.jobs.createJob(job('ko', { kind: 'splat', inits }))
    await until(() => s.docker.state.containers.get('ok-0-init-0')?.State === 'running' && s.docker.state.containers.get('ko-0-init-0')?.State === 'running', 5000, 'inits to run')
    assert.equal(s.docker.state.containers.has('ok-0'), false, 'main waits for its init')
    assert.equal((await s.jobs.podsFor('ok'))[0].status.phase, 'Pending')
    s.docker.exit('ok-0-init-0', 0)
    s.docker.exit('ko-0-init-0', 1)
    await until(() => s.docker.state.containers.get('ok-0')?.State === 'running', 5000, 'main to follow its init')
    await until(async () => (await s.jobs.getJob('ko')).status.failed === 1, 5000, 'ko to fail')
    assert.match((await s.jobs.getJob('ko')).status.conditions[0].message, /init container/)
    assert.equal(s.docker.state.containers.has('ko-0'), false)
  } finally {
    await s.done()
  }
})

test('activeDeadlineSeconds stops a Job that runs too long, and ttlSecondsAfterFinished removes it', async () => {
  const s = await setup({ images: ['piedmont-bake:sha-1'] })
  try {
    await s.jobs.createJob(job('slow', { kind: 'osm-import', deadline: 1 }))
    await until(() => s.docker.running() === 1, 5000, 'start')
    await until(async () => (await s.jobs.getJob('slow')).status.failed === 1, 8000, 'the deadline')
    assert.equal((await s.jobs.getJob('slow')).status.conditions[0].reason, 'DeadlineExceeded')
    await until(() => s.docker.state.containers.get('slow-0')?.State === 'exited', 5000, 'the container to be stopped')

    await s.jobs.createJob(job('brief', { kind: 'publish', ttl: 0 }))
    await until(() => s.docker.state.containers.get('brief-0')?.State === 'running', 5000, 'brief to run')
    s.docker.exit('brief-0', 0)
    await until(async () => !(await s.jobs.getJob('brief').catch(() => null)), 5000, 'the TTL to remove it')
  } finally {
    await s.done()
  }
})

test('the queue is on the volume: a new runner over the same state starts what the old one left Pending', async () => {
  const s = await setup({ images: ['piedmont-bake:sha-1'], maxParallel: 1 })
  try {
    await s.jobs.createJob(job('first'))
    await s.jobs.createJob(job('second'))
    await until(() => s.docker.running() === 1, 5000, 'first')
    s.jobs.close()
    const again = new DockerJobs({ socketPath: s.docker.socketPath, root: path.join(s.root, 'srv'), claims: { 'piedmont-data': s.data }, pollMs: 50, log: () => {} })
    try {
      assert.equal((await again.getJob('second')).status.active, undefined, 'still queued after the restart')
      s.docker.exit('first-0', 0)
      await until(() => s.docker.state.containers.get('second-0')?.State === 'running', 5000, 'second, started by the new runner')
      assert.equal((await again.getJob('first')).status.succeeded, 1)
    } finally {
      again.close()
    }
  } finally {
    await s.done()
  }
})

test('registry credentials from a docker config.json go in X-Registry-Auth for that registry only', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'docker-auth-'))
  const authFile = path.join(dir, 'config.json')
  await writeFile(authFile, JSON.stringify({ auths: { 'ghcr.io': { auth: Buffer.from('someone:placeholder').toString('base64') } } }))
  const s = await setup({ authFile })
  try {
    await s.jobs.createJob(job('a', { kind: 'x', image: 'ghcr.io/hotspoons/piedmont-bake:latest' }))
    await s.jobs.createJob(job('b', { kind: 'x', image: 'wiktorn/overpass-api:latest' }))
    await until(() => s.docker.state.pulls.length === 2, 5000, 'two pulls')
    const ghcr = s.docker.state.pulls.find((p) => p.ref.startsWith('ghcr.io'))
    const hub = s.docker.state.pulls.find((p) => p.ref.startsWith('wiktorn'))
    assert.deepEqual(JSON.parse(Buffer.from(ghcr.auth, 'base64url').toString()), { username: 'someone', password: 'placeholder', serveraddress: 'ghcr.io' })
    assert.equal(hub.auth, null)
  } finally {
    await s.done()
    await rm(dir, { recursive: true, force: true })
  }
})

/* ---- the callers, unchanged, on this backend ---- */

test('runs.mjs bakes through the Docker runner: the bake Job becomes a container on the data volume, and the run ends done with its log', async () => {
  const s = await setup({ images: [], ncpu: 8 })
  const store = new Store(s.data)
  await store.init()
  await mkdir(path.join(s.root, 'srv', 'secrets'), { recursive: true })
  await writeFile(path.join(s.root, 'srv', 'secrets', 'piedmont-r2.env'), 'AWS_ACCESS_KEY_ID=placeholder\nAWS_SECRET_ACCESS_KEY=placeholder\n')
  const runs = new Runs(store, s.jobs, { image: 'ghcr.io/hotspoons/piedmont-bake:latest', claim: 'piedmont-data', secretName: 'piedmont-r2', bucket: 'b', resources: { requests: { cpu: '8', memory: '32Gi' }, limits: { cpu: '64', memory: '384Gi' } } })
  try {
    assert.equal(runs.runner, 'docker')
    const run = await runs.bake('w', { sharded: false })
    assert.equal(run.runner, 'docker')
    await until(() => s.docker.running() === 1, 10000, 'the bake container')
    const [c] = s.docker.started()
    assert.deepEqual([...c.body.Entrypoint, ...c.body.Cmd], ['python', '-m', 'piedmont_bake', 'fetch', 'w'])
    assert.deepEqual(c.body.HostConfig.Binds, [`${s.data}:/data`], 'the data claim is the editor data dir')
    assert.ok(c.body.Env.includes('PIEDMONT_DATA=/data'))
    assert.ok(c.body.Env.includes('PIEDMONT_PYRAMID=1'))
    assert.ok(c.body.Env.includes('AWS_ACCESS_KEY_ID=placeholder'), 'the publish Secret came from <root>/secrets/piedmont-r2.env')
    assert.equal(c.body.HostConfig.NanoCpus, 8e9)
    assert.equal(c.body.Labels['worldeditor/run'], run.id)
    c.logs.push({ stamp: '2026-10-10T12:00:00Z', text: 'fetching roads\n' })
    await until(async () => (await readFile(store.logFile(run.id), 'utf8')).includes('fetching roads'), 10000, 'the log to reach the run')
    s.docker.exit(c.name, 0)
    await until(async () => JSON.parse(await readFile(store.runFile(run.id), 'utf8')).state === 'done', 15000, 'the run to finish')
  } finally {
    for (const l of runs.live.values()) l.stop?.()
    await s.done()
  }
})

test('a sharded bake fans out at most maxParallel shard containers at once, then finalizes', async () => {
  const s = await setup({ images: ['c:1'], maxParallel: 2 })
  const store = new Store(s.data)
  await store.init()
  await mkdir(path.join(store.sites, 'w', 'plan'), { recursive: true })
  await writeFile(path.join(store.sites, 'w', 'plan', 'shards.json'), JSON.stringify({ n: 3 }))
  const runs = new Runs(store, s.jobs, { image: 'c:1', claim: 'piedmont-data', resources: {} })
  const cmd = (c) => [...c.body.Entrypoint, ...c.body.Cmd].join(' ')
  const find = (re) => [...s.docker.state.containers.values()].filter((c) => re.test(cmd(c)))
  try {
    const run = await runs.bake('w', { sharded: true })
    await until(() => find(/ plan w/).some((c) => c.State === 'running'), 10000, 'the plan')
    s.docker.exit(find(/ plan w/)[0].name, 0)
    await until(() => find(/ shard w /).filter((c) => c.State === 'running').length === 2, 15000, 'two shards running')
    await sleep(500)
    assert.equal(find(/ shard w /).length, 2, 'the third shard waits for a slot')
    assert.equal(JSON.parse(await readFile(store.runFile(run.id), 'utf8')).state, 'running')
    s.docker.exit(find(/ shard w /)[0].name, 0)
    // RUNNING, not merely created: under load the third container exists a beat before it is
    // started, and exiting only the running ones left it running forever (no finalizer)
    await until(() => find(/ shard w /).filter((c) => c.State === 'running').length === 2, 10000, 'the third shard running')
    for (const c of find(/ shard w /)) if (c.State === 'running') s.docker.exit(c.name, 0)
    await until(() => find(/ finalize w/).some((c) => c.State === 'running'), 15000, 'the finalizer')
    assert.equal(s.docker.state.maxRunning, 2, 'never more than maxParallel bake containers')
    s.docker.exit(find(/ finalize w/)[0].name, 0)
    await until(async () => JSON.parse(await readFile(store.runFile(run.id), 'utf8')).state === 'done', 15000, 'done')
  } finally {
    for (const l of runs.live.values()) l.stop?.()
    await s.done()
  }
})

test('cancelling a run deletes its containers', async () => {
  const s = await setup({ images: ['c:1'] })
  const store = new Store(s.data)
  await store.init()
  const runs = new Runs(store, s.jobs, { image: 'c:1', claim: 'piedmont-data', resources: {} })
  try {
    const run = await runs.bake('w', { sharded: false })
    await until(() => s.docker.running() === 1, 10000, 'running')
    const [c] = s.docker.started()
    await runs.cancel(run.id)
    await until(() => !s.docker.state.containers.has(c.name), 5000, 'the container to go')
    assert.equal(JSON.parse(await readFile(store.runFile(run.id), 'utf8')).detail, 'cancelled')
  } finally {
    for (const l of runs.live.values()) l.stop?.()
    await s.done()
  }
})

test('an osm-import finds its Overpass service container by label and mounts its db and scripts', async () => {
  const s = await setup({ images: ['wiktorn/overpass-api:latest'] })
  // the core's long-running Overpass, as the stack starts it: not ours, labelled app=overpass
  s.docker.state.containers.set('piedmont-overpass-1', { name: 'piedmont-overpass-1', body: { Labels: { app: 'overpass' } }, State: 'running', logs: [] })
  const store = new Store(s.data)
  await store.init()
  const runs = new Runs(store, s.jobs, { image: 'c:1', claim: 'piedmont-data', resources: {}, osmImportImage: 'wiktorn/overpass-api:latest' })
  try {
    const run = await runs.osmImport({ upstream: 'overpass', region: { properties: { id: 'us/delaware', name: 'Delaware', urls: { pbf: 'https://example.invalid/delaware-latest.osm.pbf' } } } })
    assert.equal(run.runner, 'docker')
    await until(() => [...s.docker.state.containers.values()].some((c) => c.body.Labels?.['worldeditor/kind'] === 'osm-import' && c.State === 'running'), 10000, 'the import container')
    const c = [...s.docker.state.containers.values()].find((x) => x.body.Labels?.['worldeditor/kind'] === 'osm-import')
    assert.deepEqual(c.body.HostConfig.Binds, [
      `${path.join(s.root, 'srv', 'volumes', 'overpass-db')}:/db`,
      `${path.join(s.root, 'srv', 'configmaps', 'overpass-regions')}:/opt/regions:ro`,
    ])
    assert.ok(c.body.Env.includes('INTERPRETER=http://overpass/api/interpreter'))
    await runs.cancel(run.id)
  } finally {
    for (const l of runs.live.values()) l.stop?.()
    await s.done()
  }
})

test('training.mjs batch tier runs on the Docker runner: claim dir, leader + workers, status, GPUs, delete', async () => {
  const s = await setup({ images: ['g:1'], gpus: '0,1,2' })
  try {
    const p = await training.plan(s.jobs, { namespace: 'default' })
    assert.equal(p.via, 'batch', 'no TrainingDeployment, no JobSet: plain Jobs')
    assert.deepEqual(await training.gpuResources(s.jobs), ['nvidia.com/gpu'])
    const made = await training.createRun({ capture: 'cap1', workers: 2, image: 'g:1', claim: 'piedmont-data' }, s.jobs, { namespace: 'default' })
    assert.equal(made.jobs.length, 2)
    assert.ok(existsSync(path.join(s.root, 'srv', 'volumes', 'splat-cap1-out')), 'the output claim is a directory')
    await until(() => s.docker.running() === 3, 5000, 'leader + 2 workers')
    const leader = s.docker.state.containers.get('splat-cap1-leader-0')
    assert.ok(leader.body.HostConfig.Binds.includes(`${path.join(s.root, 'srv', 'volumes', 'splat-cap1-out')}:/out`))
    assert.ok(leader.body.HostConfig.Binds.includes(`${s.data}:/editor:ro`))
    assert.deepEqual((await training.freeGpus(s.jobs)).free, 0)
    assert.equal((await training.runStatus('splat-cap1', s.jobs)).state, 'running')
    assert.equal((await training.listRuns(s.jobs)).length, 1)
    await training.deleteRun('splat-cap1', s.jobs)
    await until(() => s.docker.running() === 0, 5000, 'all three stopped')
    assert.equal((await training.runStatus('splat-cap1', s.jobs)).state, 'gone')
  } finally {
    await s.done()
  }
})

test('the backend is Docker only when asked for, and the data claim maps to the editor data dir', () => {
  assert.ok(jobBackend({}, { K8s, data: '/d' }) instanceof K8s, 'unset: Kubernetes (or local), never Docker by detection')
  assert.ok(jobBackend({ PIEDMONT_EDITOR_RUNNER: 'local' }, { K8s, data: '/d' }) instanceof K8s)
  const d = jobBackend({ PIEDMONT_EDITOR_RUNNER: 'docker', DOCKER_HOST: 'unix:///tmp/x.sock', PIEDMONT_EDITOR_DOCKER_GPUS: '2', PIEDMONT_EDITOR_DOCKER_ROOT: '/srv/piedmont' }, { K8s, data: '/srv/piedmont/data', dataClaim: 'piedmont-data' })
  assert.ok(d instanceof DockerJobs)
  assert.equal(d.kind, 'docker')
  assert.equal(d.socketPath, '/tmp/x.sock')
  assert.deepEqual(d.gpuIds, ['0', '1'])
  assert.equal(d.claims['piedmont-data'], '/srv/piedmont/data')
  assert.equal(d.available, false, 'no socket there: not available, and the local runner takes over')
  d.close()
  // the stack names the claim itself, and the Jobs (runs.mjs, training.mjs) read the same variable
  const named = jobBackend({ PIEDMONT_EDITOR_RUNNER: 'docker', PIEDMONT_EDITOR_CLAIM: 'editor-data' }, { K8s, data: '/srv/piedmont/data', dataClaim: 'piedmont-data' })
  assert.equal(named.claims['editor-data'], '/srv/piedmont/data')
  assert.equal(named.claims['piedmont-data'], undefined)
  named.close()
})
