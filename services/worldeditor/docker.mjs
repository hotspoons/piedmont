// The Docker Engine, standing in for the Kubernetes API, for a world editor that runs on one host.
//
// Rich, 2026-10-10: "design a docker version of the entire world baking, asset svc, world editor,
// map API, etc — everything we use in the kube version". The editor already builds Jobs: a bake, a
// plan -> shard -> finalize fan-out, an OSM import, a splat run's leader and workers. Rewriting each
// of those for Docker would give every call site two code paths that drift. So this module is the
// OTHER END of the same calls: `DockerJobs` has the methods `K8s` has (createJob, getJob, deleteJob,
// podsFor, podsByLabel, logStream, raw, permitted) and answers them in the shapes the Kubernetes API
// answers, and `runs.mjs` / `training.mjs` cannot tell which one they are holding.
//
// THE SPEC IS TRANSLATED, NOT REWRITTEN. `containerBody()` takes a pod template exactly as the code
// already builds it and produces a Docker Engine `POST /containers/create` body:
//
//   container.image / command / args / env / workingDir   Image / Entrypoint / Cmd / Env / WorkingDir
//   resources.limits.cpu, .memory; requests.memory        NanoCpus (clamped to the host), Memory, MemoryReservation
//   resources.limits["nvidia.com/gpu"] (any */gpu)         DeviceRequests, with device ids this module allocates
//   volumes: persistentVolumeClaim                         a bind of <root>/volumes/<claim> (the data claim: the data dir)
//   volumes: configMap / secret / hostPath / emptyDir      a bind of <root>/configmaps|secrets/<name>, the path, a volume or tmpfs
//   envFrom: secretRef                                     KEY=VALUE lines from <root>/secrets/<name>.env
//   metadata.labels (Job and template)                     Labels, plus job-name and our own bookkeeping
//   any image, any tag, any imagePullPolicy                a pull before every container create (Rich:
//                                                          "Policy should be always, always")
//   restartPolicy Never, backoffLimit 0                    RestartPolicy "no"; a failed pod fails the Job
//
// WHAT KUBERNETES DID THAT DOCKER DOES NOT, and where it went:
//
//   * THE SCHEDULER. Kubernetes queues a pod until a node can hold it. One host cannot hold 25 bake
//     shards at 139 GiB each, so a Job is a RECORD on the volume (<stateDir>/<job>.json) and its pods
//     are created only when a slot is free: `maxParallel` bake pods at once (a setting), GPU pods only
//     when enough of the configured GPUs are free. Until then the pod is Pending, the Job is not
//     active, and the run says "queued" — which is what it is.
//   * GPU ACCOUNTING. Docker gives `Count: 1` to EVERY container as GPU 0. With the GPUs named here
//     (`gpus`), each pod is handed distinct device ids and they are free again when it ends.
//   * activeDeadlineSeconds and ttlSecondsAfterFinished are enforced by the same pump.
//   * Placement — nodeSelector, affinity, topologySpreadConstraints — means nothing on one host and is
//     ignored. An osm-import is pinned to its Overpass instance's node; here there is one node.
//
// NO DOCKER CLI. The Engine API is HTTP over a unix socket and node:http speaks to one directly, the
// same reasoning as k8s.mjs: the image needs no binary that can be the wrong version.

import http from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PassThrough, Transform } from 'node:stream'

/* ---- the Engine API, by hand ------------------------------------------------------------------ */

export class DockerEngine {
  /**
   * @param socketPath  the daemon's socket (`unix:///var/run/docker.sock` in DOCKER_HOST terms)
   * @param apiVersion  e.g. "1.44" to pin; null speaks the daemon's own (an unversioned path)
   */
  constructor({ socketPath = '/var/run/docker.sock', apiVersion = null } = {}) {
    this.socketPath = socketPath
    this.prefix = apiVersion ? `/v${String(apiVersion).replace(/^v/, '')}` : ''
  }

  /**
   * One request. `stream: true` resolves with the response itself (logs, a pull's progress);
   * otherwise the body is read, parsed when it is JSON, and a status >= 400 rejects with `.status`.
   */
  request(method, apiPath, { body, query, headers = {}, stream = false, timeoutMs = 0 } = {}) {
    const qs = query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]))}` : ''
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const opts = {
      socketPath: this.socketPath,
      path: `${this.prefix}${apiPath}${qs}`,
      method,
      headers: {
        Host: 'docker',
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        ...headers,
      },
    }
    return new Promise((resolve, reject) => {
      const req = http.request(opts, (res) => {
        if (stream && res.statusCode < 400) return resolve(res)
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed = text
          try {
            parsed = text ? JSON.parse(text) : {}
          } catch { /* not JSON: hand back the text */ }
          if (res.statusCode >= 400) {
            const msg = typeof parsed === 'object' && parsed?.message ? parsed.message : text.slice(0, 300)
            return reject(Object.assign(new Error(`docker ${method} ${apiPath}: ${res.statusCode} ${msg}`), { status: res.statusCode }))
          }
          resolve(parsed)
        })
        res.on('error', reject)
      })
      req.on('error', reject)
      if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error(`docker ${method} ${apiPath}: timed out after ${timeoutMs} ms`)))
      if (payload) req.write(payload)
      req.end()
    })
  }

  ping() {
    return this.request('GET', '/_ping', { timeoutMs: 5000 })
  }

  info() {
    return this.request('GET', '/info', { timeoutMs: 10000 })
  }

  /**
   * Pull an image, and BELIEVE THE BODY, NOT THE STATUS.
   *
   * `POST /images/create` answers 200 the moment the pull starts and reports a failure — an unknown
   * tag, a registry that wants credentials, a manifest for the wrong platform — as a line of JSON
   * with an `error` field, partway down a stream that still ends 200. A client that checks the
   * status reports a pull that did nothing as a success. So the whole stream is read and any error
   * line rejects.
   */
  async pull(image, { auth = null } = {}) {
    const { name, tag, digest } = parseImage(image)
    const query = digest ? { fromImage: `${name}@${digest}` } : { fromImage: name, tag: tag ?? 'latest' }
    const res = await this.request('POST', '/images/create', { query, stream: true, headers: auth ? { 'X-Registry-Auth': auth } : {} })
    const text = await new Promise((resolve, reject) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      res.on('error', reject)
    })
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let ev
      try {
        ev = JSON.parse(line)
      } catch {
        continue
      }
      if (ev.error || ev.errorDetail) throw Object.assign(new Error(`pull ${image}: ${ev.error ?? ev.errorDetail?.message}`), { status: 502 })
    }
    return { pulled: image }
  }

  async imageExists(image) {
    try {
      await this.request('GET', `/images/${encodeURIComponent(image)}/json`)
      return true
    } catch (e) {
      if (e.status === 404) return false
      throw e
    }
  }

  createContainer(name, body) {
    return this.request('POST', '/containers/create', { query: { name }, body })
  }

  startContainer(id) {
    return this.request('POST', `/containers/${encodeURIComponent(id)}/start`)
  }

  inspectContainer(id) {
    return this.request('GET', `/containers/${encodeURIComponent(id)}/json`)
  }

  /** `filters` in the Engine's own shape: `{ label: ['a=b'] }`. */
  listContainers(filters = {}) {
    return this.request('GET', '/containers/json', { query: { all: 'true', filters } })
  }

  stopContainer(id, seconds = 10) {
    return this.request('POST', `/containers/${encodeURIComponent(id)}/stop`, { query: { t: seconds } }).catch((e) => {
      if (e.status === 304 || e.status === 404) return null // already stopped, or already gone
      throw e
    })
  }

  removeContainer(id) {
    return this.request('DELETE', `/containers/${encodeURIComponent(id)}`, { query: { force: 'true', v: 'true' } }).catch((e) => {
      if (e.status === 404) return null
      throw e
    })
  }

  removeVolume(name) {
    return this.request('DELETE', `/volumes/${encodeURIComponent(name)}`, { query: { force: 'true' } }).catch(() => null)
  }

  logs(id, { follow = true, since = null } = {}) {
    return this.request('GET', `/containers/${encodeURIComponent(id)}/logs`, {
      query: { follow: String(follow), stdout: 'true', stderr: 'true', timestamps: 'true', ...(since ? { since } : {}) },
      stream: true,
    })
  }
}

/* ---- the pure parts: names, quantities, the translation ---------------------------------------- */

/** `ghcr.io/x/y:tag`, `y@sha256:…`, `localhost:5000/y` — split without mistaking a port for a tag. */
export function parseImage(ref) {
  let rest = String(ref)
  let digest = null
  const at = rest.indexOf('@')
  if (at >= 0) {
    digest = rest.slice(at + 1)
    rest = rest.slice(0, at)
  }
  let tag = null
  const slash = rest.lastIndexOf('/')
  const colon = rest.lastIndexOf(':')
  if (colon > slash) {
    tag = rest.slice(colon + 1)
    rest = rest.slice(0, colon)
  }
  const first = rest.split('/')[0]
  const registry = rest.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost') ? first : 'docker.io'
  return { name: rest, tag, digest, registry }
}

/** "500m" -> 0.5, "16" -> 16 */
export function cpuOf(q) {
  if (q === undefined || q === null || q === '') return null
  const s = String(q)
  if (s.endsWith('m')) return Number(s.slice(0, -1)) / 1000
  return Number(s)
}

const BIN = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 }
const DEC = { k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 }

/** "32Gi" -> bytes, "512M" -> bytes, "1e9" -> bytes */
export function bytesOf(q) {
  if (q === undefined || q === null || q === '') return null
  const m = /^([0-9.e+]+)([KMGTPE]i|[kKMGTPE])?$/.exec(String(q).trim())
  if (!m) return null
  const n = Number(m[1])
  const unit = m[2] ? (BIN[m[2]] ?? DEC[m[2]]) : 1
  return Math.round(n * unit)
}

/** The extended resources that are GPUs: nvidia.com/gpu, amd.com/gpu, … (as training.mjs reads them). */
const GPU_KEY = /(^|\/)(gpu|gaudi|i915|xe)s?$|gpu\.intel\.com|habana\.ai/i

/** How many GPUs a container asks for, and under which resource name. */
export function gpusOf(container) {
  const lim = { ...(container.resources?.requests ?? {}), ...(container.resources?.limits ?? {}) }
  for (const [k, v] of Object.entries(lim)) {
    if (k.includes('/') && GPU_KEY.test(k)) {
      const n = Number(v)
      if (n > 0) return { resource: k, count: n }
    }
  }
  return { resource: null, count: 0 }
}

/** `$(VAR)` in command/args expands from the container's env, and `$$(` escapes it — as the kubelet does. */
function expand(s, vars) {
  return String(s).replace(/\$\$\(|\$\(([A-Za-z_][A-Za-z0-9_]*)\)/g, (m, name) => (m === '$$(' ? '$(' : name in vars ? vars[name] : m))
}

/**
 * A Kubernetes container (in its pod) -> a Docker create body. PURE, exported for the tests.
 *
 * @param o.job        the Job object (metadata, spec)
 * @param o.pod        { name, index }
 * @param o.container  the container spec
 * @param o.podSpec    the pod template's spec (volumes, securityContext)
 * @param o.ctx        { network, volume(vol) -> source|null, secretEnv(name, optional) -> ['K=V'],
 *                       gpuIds: ['0'] | null, ncpu, shmSize, extraLabels }
 * @returns { body, warnings }
 */
export function containerBody({ job, pod, container, podSpec, ctx }) {
  const warnings = []
  const env = {}
  for (const ref of container.envFrom ?? []) {
    if (ref.secretRef) for (const line of ctx.secretEnv(ref.secretRef.name, ref.secretRef.optional)) {
      const i = line.indexOf('=')
      if (i > 0) env[line.slice(0, i)] = line.slice(i + 1)
    } else warnings.push(`envFrom ${JSON.stringify(ref)} is not supported here; skipped`)
  }
  for (const e of container.env ?? []) {
    if ('value' in e) env[e.name] = String(e.value ?? '')
    else if (e.valueFrom?.fieldRef?.fieldPath === 'metadata.name') env[e.name] = pod.name
    else if (e.valueFrom?.fieldRef?.fieldPath === 'metadata.namespace') env[e.name] = ctx.namespace ?? 'default'
    else if (e.valueFrom?.secretKeyRef) {
      const want = e.valueFrom.secretKeyRef
      const hit = ctx.secretEnv(want.name, true).find((l) => l.startsWith(`${want.key}=`))
      if (hit) env[e.name] = hit.slice(want.key.length + 1)
      else if (!want.optional) warnings.push(`secret ${want.name} has no ${want.key}`)
    } else warnings.push(`env ${e.name}: valueFrom is not supported here; skipped`)
  }
  // Kubernetes sets this on every Job pod; a script that reads it should not break on Docker
  if (job.spec?.completionMode === 'Indexed' || (job.spec?.completions ?? 1) > 1) env.JOB_COMPLETION_INDEX ??= String(pod.index)

  const binds = []
  const tmpfs = {}
  const mounts = []
  const volumes = new Map((podSpec.volumes ?? []).map((v) => [v.name, v]))
  for (const m of container.volumeMounts ?? []) {
    const v = volumes.get(m.name)
    if (!v) {
      warnings.push(`volumeMount ${m.name} names no volume`)
      continue
    }
    const ro = !!(m.readOnly || v.persistentVolumeClaim?.readOnly || v.configMap || v.secret)
    if (v.emptyDir) {
      if (v.emptyDir.medium === 'Memory') tmpfs[m.mountPath] = v.emptyDir.sizeLimit ? `size=${bytesOf(v.emptyDir.sizeLimit)}` : ''
      // a named volume per pod, so an init container and the main one share it as in a pod
      else mounts.push({ Type: 'volume', Source: `${pod.name}-${v.name}`, Target: m.mountPath, ReadOnly: ro })
      continue
    }
    const src = ctx.volume(v)
    if (!src) {
      warnings.push(`volume ${v.name} has no Docker equivalent here; not mounted`)
      continue
    }
    const from = m.subPath ? path.posix.join(src, m.subPath) : src
    binds.push(`${from}:${m.mountPath}${ro ? ':ro' : ''}`)
  }

  const lim = container.resources?.limits ?? {}
  const req = container.resources?.requests ?? {}
  const host = {
    Binds: binds,
    ...(mounts.length ? { Mounts: mounts } : {}),
    ...(Object.keys(tmpfs).length ? { Tmpfs: tmpfs } : {}),
    NetworkMode: ctx.network ?? 'bridge',
    // restartPolicy Never is what every Job here asks for: a failure is a failure a person reads
    RestartPolicy: podSpec.restartPolicy === 'OnFailure' ? { Name: 'on-failure', MaximumRetryCount: job.spec?.backoffLimit ?? 6 } : { Name: 'no' },
    ...(ctx.shmSize ? { ShmSize: ctx.shmSize } : {}),
  }
  // A LIMIT ABOVE THE HOST IS AN ERROR IN DOCKER, NOT A NO-OP. The bake asks for 64 CPUs, which on
  // gh200-1 is a cap and on a 16-core box makes `create` refuse: "Range of CPUs is from 0.01 to 16".
  const cpus = cpuOf(lim.cpu)
  if (cpus) host.NanoCpus = Math.round(Math.min(cpus, ctx.ncpu || cpus) * 1e9)
  const mem = bytesOf(lim.memory)
  if (mem) host.Memory = mem
  const reserve = bytesOf(req.memory)
  if (reserve) host.MemoryReservation = mem ? Math.min(reserve, mem) : reserve
  const gpu = gpusOf(container)
  if (gpu.count) {
    host.DeviceRequests = [ctx.gpuIds?.length
      ? { Driver: 'nvidia', DeviceIDs: ctx.gpuIds, Capabilities: [['gpu']] }
      : { Driver: 'nvidia', Count: gpu.count, Capabilities: [['gpu']] }]
  }
  const sc = { ...(podSpec.securityContext ?? {}), ...(container.securityContext ?? {}) }
  if (podSpec.securityContext?.fsGroup) host.GroupAdd = [String(podSpec.securityContext.fsGroup)]

  const labels = {
    ...(job.metadata?.labels ?? {}),
    ...(job.spec?.template?.metadata?.labels ?? {}),
    'job-name': job.metadata.name,
    'batch.kubernetes.io/job-name': job.metadata.name,
    ...(ctx.extraLabels ?? {}),
  }
  const network = ctx.network && !['bridge', 'host', 'none'].includes(ctx.network)
    ? { EndpointsConfig: { [ctx.network]: { Aliases: [pod.name] } } }
    : undefined

  const body = {
    Image: container.image,
    ...(container.command ? { Entrypoint: container.command.map((s) => expand(s, env)) } : {}),
    ...(container.args ? { Cmd: container.args.map((s) => expand(s, env)) } : container.command ? { Cmd: [] } : {}),
    Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
    ...(container.workingDir ? { WorkingDir: container.workingDir } : {}),
    ...(sc.runAsUser !== undefined ? { User: sc.runAsGroup !== undefined ? `${sc.runAsUser}:${sc.runAsGroup}` : String(sc.runAsUser) } : {}),
    Hostname: pod.name.slice(0, 63),
    Labels: labels,
    Tty: false,
    AttachStdout: false,
    AttachStderr: false,
    StopTimeout: Number(podSpec.terminationGracePeriodSeconds ?? 30),
    HostConfig: host,
    ...(network ? { NetworkingConfig: network } : {}),
  }
  return { body, warnings }
}

/* ---- logs: the Engine's multiplexed stream -> the lines the kubelet would send ----------------- */

/**
 * Docker's non-TTY log stream is FRAMED: an 8-byte header (stream id, three zeros, a big-endian
 * length) before each payload. This strips the frames and normalises each line's timestamp to nine
 * fractional digits, so runs.mjs's `stamp <= last` string compare is a time compare — the same
 * contract a pod log with `timestamps=true` has.
 *
 * A LONG LINE ARRIVES IN PIECES, EACH WITH ITS OWN STAMP. The daemon cuts a log message at 16 KiB
 * and stamps every piece, so the second piece's stamp would land in the middle of a line. A frame
 * that does not end in a newline is remembered, and the next frame's stamp is dropped.
 */
export function demuxer({ tty = false } = {}) {
  let buf = Buffer.alloc(0)
  let open = false // the last payload did not end in a newline
  const fix = (payload) => {
    let s = payload.toString('utf8')
    if (open) {
      const sp = s.indexOf(' ')
      if (/^\d{4}-\d\d-\d\dT/.test(s) && sp > 0) s = s.slice(sp + 1)
    } else {
      s = s.replace(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)? /, (_, a, f = '', z = 'Z') => `${a}.${(f + '000000000').slice(0, 9)}${z} `)
    }
    open = !s.endsWith('\n')
    return s
  }
  return new Transform({
    transform(chunk, _enc, done) {
      if (tty) {
        done(null, chunk)
        return
      }
      buf = Buffer.concat([buf, chunk])
      let out = ''
      while (buf.length >= 8) {
        const size = buf.readUInt32BE(4)
        if (buf.length < 8 + size) break
        out += fix(buf.subarray(8, 8 + size))
        buf = buf.subarray(8 + size)
      }
      done(null, out || undefined)
    },
  })
}

/** A Date as a log stamp: RFC 3339 with nine fractional digits, as the demuxer writes them. */
function stampOf(d) {
  return d.toISOString().replace(/\.(\d{3})Z$/, '.$1000000Z')
}

/** RFC 3339 -> the Engine's `since` (seconds since the epoch, with up to nine fractional digits). */
export function sinceOf(stamp) {
  if (!stamp) return null
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)?$/.exec(stamp)
  if (!m) return null
  const secs = Math.floor(Date.parse(`${m[1]}${m[3] ?? 'Z'}`) / 1000)
  return m[2] ? `${secs}.${(m[2] + '000000000').slice(0, 9)}` : String(secs)
}

/** A stream the runs.mjs follower can read like a pod log that is not there yet: 400, then end. */
function notYet(message) {
  const s = new PassThrough()
  s.statusCode = 400
  s.statusMessage = message
  s.end()
  return s
}

/* ---- label selectors, as far as anything here writes them --------------------------------------- */

/** `a=b,c!=d,e` -> a predicate over a labels object. Set-based selectors are not used here. */
export function selectorMatch(selector) {
  const terms = String(selector ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((t) => {
    let m
    if ((m = /^([^!=]+)!=(.*)$/.exec(t))) return (l) => l[m[1].trim()] !== m[2].trim()
    if ((m = /^([^=]+)==?(.*)$/.exec(t))) return (l) => l[m[1].trim()] === m[2].trim()
    return (l) => t in l
  })
  return (labels = {}) => terms.every((f) => f(labels ?? {}))
}

/* ---- the Job backend ------------------------------------------------------------------------------ */

const MANAGED = 'worldeditor.docker/managed'
const JOB = 'worldeditor.docker/job'
const POD = 'worldeditor.docker/pod'
const STAGE = 'worldeditor.docker/stage'

const nowIso = () => new Date().toISOString()

export class DockerJobs {
  /**
   * @param o.engine       a DockerEngine (or a stand-in)
   * @param o.root         the shared volume as the DAEMON sees it: claims, configmaps and secrets live under it
   * @param o.stateDir     where Job records are kept (on the volume, so a restart finds its queue)
   * @param o.claims       { claimName: path } — a claim mapped somewhere other than <root>/volumes/<claim>
   * @param o.network      the network jobs join, so `http://overpass/…` resolves as it does in the cluster
   * @param o.maxParallel  bake pods at once: a number or a function returning one (a setting)
   * @param o.gpus         the GPUs this host may hand out: a count, or a list of ids ("0,1,3"). 0/empty: Count only
   * @param o.shmSize      /dev/shm for every job container, bytes
   * @param o.authFile     a docker config.json whose `auths` are used to pull
   * @param o.pollMs       how often the pump runs on its own
   */
  constructor({
    engine = null,
    socketPath = '/var/run/docker.sock',
    apiVersion = null,
    root = '/srv/piedmont',
    stateDir = null,
    claims = {},
    network = 'piedmont',
    namespace = 'default',
    maxParallel = 1,
    gpus = 0,
    shmSize = 2 ** 30,
    authFile = null,
    pollMs = 3000,
    log = (line) => console.log(`docker: ${line}`),
  } = {}) {
    this.kind = 'docker'
    this.engine = engine ?? new DockerEngine({ socketPath, apiVersion })
    this.socketPath = socketPath
    this.root = root
    this.stateDir = stateDir ?? path.join(root, 'jobs')
    this.claims = claims
    this.network = network
    this.namespace = namespace
    this.maxParallel = maxParallel
    this.gpuIds = gpuList(gpus)
    this.shmSize = shmSize
    this.authFile = authFile
    this.pollMs = pollMs
    this.log = log
    this.jobs = null // name -> record, loaded on first use
    this.containers = new Map() // name -> container summary, as of the last pump
    this.listedAt = 0
    this.starting = new Set() // pod names whose start is in flight
    this.pulled = new Map() // image -> time of the last successful pull
    this.chain = Promise.resolve()
    this.timer = null
    this.ncpu = 0
    this.writes = 0
  }

  /** A socket to talk to. Off a Docker host this is false and the local runner takes over. */
  get available() {
    // an injected engine (a test's) has no socket to look for
    return !!this.engine && (this.socketPath ? existsSync(this.socketPath) : true)
  }

  usable() {
    return this.available
  }

  describe() {
    return {
      available: this.available,
      backend: 'docker',
      socket: this.socketPath,
      network: this.network,
      maxParallel: this.#max(),
      gpus: this.gpuIds.length ? this.gpuIds : 'unallocated (Count)',
      root: this.root,
    }
  }

  async permitted() {
    if (!this.available) return { ok: false, detail: `no Docker socket at ${this.socketPath}` }
    try {
      await this.engine.ping()
      return { ok: true, namespace: this.namespace, backend: 'docker' }
    } catch (e) {
      return { ok: false, detail: String(e.message ?? e) }
    }
  }

  /** Stop the pump's timer — for a test, or a shutdown. Containers keep running; their records stay. */
  close() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  #max() {
    const v = Number(typeof this.maxParallel === 'function' ? this.maxParallel() : this.maxParallel)
    return Number.isFinite(v) && v > 0 ? v : 1
  }

  /* ---- records ---- */

  async #load() {
    if (this.jobs) return
    this.jobs = new Map()
    await mkdir(this.stateDir, { recursive: true })
    for (const f of await readdir(this.stateDir)) {
      if (!f.endsWith('.json')) continue
      try {
        const rec = JSON.parse(await readFile(path.join(this.stateDir, f), 'utf8'))
        if (rec?.name) this.jobs.set(rec.name, rec)
      } catch { /* a half-written record is skipped, not fatal */ }
    }
    try {
      const info = await this.engine.info()
      this.ncpu = Number(info?.NCPU) || 0
      this.memTotal = Number(info?.MemTotal) || 0
    } catch { /* the daemon answers later, or permitted() says why */ }
    if (!this.timer && this.pollMs > 0) {
      this.timer = setInterval(() => void this.pump().catch(() => {}), this.pollMs)
      this.timer.unref?.()
    }
  }

  async #write(rec) {
    const file = path.join(this.stateDir, `${rec.name}.json`)
    const tmp = `${file}.tmp-${++this.writes}`
    await writeFile(tmp, JSON.stringify(rec, null, 1))
    await rename(tmp, file)
  }

  /* ---- the Kubernetes-shaped surface ---- */

  async createJob(spec) {
    await this.#load()
    const name = spec?.metadata?.name
    if (!name) throw Object.assign(new Error('a Job needs metadata.name'), { status: 422 })
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) throw Object.assign(new Error(`"${name}" is not a valid container name`), { status: 422 })
    if (this.jobs.has(name)) throw Object.assign(new Error(`jobs.batch "${name}" already exists`), { status: 409 })
    const n = Math.max(1, Number(spec.spec?.completions ?? spec.spec?.parallelism ?? 1))
    const inits = spec.spec?.template?.spec?.initContainers ?? []
    const rec = {
      name,
      created: nowIso(),
      seq: Date.now(),
      spec,
      pods: Array.from({ length: n }, (_, i) => {
        const pod = n === 1 ? `${name}-0` : `${name}-${i}`
        return { name: pod, index: i, stages: [...inits.map((_, k) => `${pod}-init-${k}`), pod], gpus: [], error: null, started: null }
      }),
      startTime: null,
      completionTime: null,
      failure: null,
    }
    this.jobs.set(name, rec)
    await this.#write(rec)
    void this.pump().catch((e) => this.log(`pump: ${e.message}`))
    return { apiVersion: 'batch/v1', kind: 'Job', metadata: { name, labels: spec.metadata?.labels ?? {}, creationTimestamp: rec.created }, spec: spec.spec }
  }

  async getJob(name) {
    await this.#load()
    const rec = this.jobs.get(name)
    if (!rec) throw Object.assign(new Error(`jobs.batch "${name}" not found`), { status: 404 })
    if (Date.now() - this.listedAt > 1000) await this.pump()
    return this.#jobObject(rec)
  }

  /** Background propagation, as in the cluster: the record goes now, the containers right after. */
  async deleteJob(name) {
    await this.#load()
    const rec = this.jobs.get(name)
    if (!rec) throw Object.assign(new Error(`jobs.batch "${name}" not found`), { status: 404 })
    this.jobs.delete(name)
    await rm(path.join(this.stateDir, `${name}.json`), { force: true })
    void this.#reap(rec).catch((e) => this.log(`delete ${name}: ${e.message}`))
    return { kind: 'Status', status: 'Success', details: { name, kind: 'jobs' } }
  }

  async podsFor(jobName) {
    await this.#load()
    const rec = this.jobs.get(jobName)
    if (!rec) return []
    if (Date.now() - this.listedAt > 1000) await this.pump()
    return rec.pods.map((p) => this.#podObject(rec, p))
  }

  /**
   * Pods by label — including containers this module did not make. An osm-import asks for
   * `app=<upstream>` to find its Overpass instance; the core's service containers carry that label.
   */
  async podsByLabel(selector) {
    await this.#load()
    const match = selectorMatch(selector)
    const out = []
    for (const rec of this.jobs.values()) {
      const labels = { ...(rec.spec.metadata?.labels ?? {}), ...(rec.spec.spec?.template?.metadata?.labels ?? {}), 'job-name': rec.name }
      if (match(labels)) out.push(...rec.pods.map((p) => this.#podObject(rec, p)))
    }
    const all = await this.engine.listContainers({}).catch(() => [])
    for (const c of all) {
      if (c.Labels?.[MANAGED]) continue
      if (!match(c.Labels ?? {})) continue
      const name = (c.Names?.[0] ?? c.Id).replace(/^\//, '')
      out.push({
        metadata: { name, labels: c.Labels ?? {} },
        spec: { nodeName: 'docker' },
        status: { phase: c.State === 'running' ? 'Running' : c.State === 'exited' ? 'Succeeded' : 'Pending' },
      })
    }
    return out
  }

  /**
   * A pod's log, as the kubelet sends it with `timestamps=true`: one RFC 3339 stamp per line.
   * A pod with no container yet answers 400 — the same thing ContainerCreating answers — and the
   * follower in runs.mjs already waits and asks again on that.
   */
  async logStream(podName, { follow = true, sinceTime = null, container = null } = {}) {
    await this.#load()
    const found = this.#findPod(podName)
    let target = podName
    if (found) {
      const { pod } = found
      target = container ? pod.stages.find((s) => s === container || s.endsWith(`-${container}`)) ?? pod.stages.at(-1) : pod.stages.at(-1)
    }
    const c = this.containers.get(target) ?? (await this.engine.inspectContainer(target).then((i) => ({ State: i.State?.Status, tty: i.Config?.Tty })).catch(() => null))
    if (!c) return notYet(`${podName} has no container yet`)
    if (c.State === 'created') return notYet(`${podName} is waiting to start`)
    const res = await this.engine.logs(target, { follow, since: sinceOf(sinceTime) })
    const out = new PassThrough()
    out.statusCode = 200
    // the pod's events first (a failed pull, …), stamped like log lines so a reconnect skips them
    for (const ev of found?.pod.events ?? []) if (!sinceTime || ev.stamp > sinceTime) out.write(`${ev.stamp} ${ev.text}\n`)
    const tty = c.tty ?? /raw-stream/.test(String(res.headers?.['content-type'] ?? ''))
    res.on('error', (e) => out.destroy(e))
    res.pipe(demuxer({ tty })).pipe(out)
    out.on('close', () => res.destroy())
    return out
  }

  /**
   * The few raw API paths the other users of K8s read — training.mjs's batch tier and models.mjs's
   * discovery — answered from the same records. Anything else is a 404, which every caller already
   * reads as "that API is not here": no TrainingDeployment, no JobSet, no InferenceDeployment.
   */
  async raw(method, apiPath, { body } = {}) {
    await this.#load()
    const u = new URL(apiPath, 'http://k8s')
    const p = u.pathname
    const sel = u.searchParams.get('labelSelector')
    const dry = u.searchParams.get('dryRun') === 'All'
    let m
    if (method === 'GET' && p === '/apis') return { kind: 'APIGroupList', groups: [] }
    if ((m = /^\/apis\/batch\/v1\/namespaces\/[^/]+\/jobs(?:\/([^/]+))?$/.exec(p))) {
      const name = m[1] ? decodeURIComponent(m[1]) : null
      if (method === 'POST' && !name) return dry ? { ...body, metadata: { ...body.metadata } } : this.createJob(body)
      if (method === 'GET' && name) return this.getJob(name)
      if (method === 'DELETE' && name) return this.deleteJob(name)
      const match = selectorMatch(sel)
      const recs = [...this.jobs.values()].filter((r) => match({ ...(r.spec.metadata?.labels ?? {}), 'job-name': r.name }))
      if (method === 'GET') {
        if (Date.now() - this.listedAt > 1000) await this.pump()
        return { kind: 'JobList', items: recs.map((r) => this.#jobObject(r)) }
      }
      if (method === 'DELETE') {
        for (const r of recs) await this.deleteJob(r.name)
        return { kind: 'Status', status: 'Success' }
      }
    }
    if ((m = /^\/api\/v1\/namespaces\/[^/]+\/persistentvolumeclaims$/.exec(p)) && method === 'POST') {
      // A CLAIM IS A DIRECTORY. Idempotent the way the API is: one that exists is a 409, which
      // training.createRun reads as "already there, use it".
      const dir = this.#claimPath(body.metadata.name)
      if (existsSync(dir)) throw Object.assign(new Error(`persistentvolumeclaims "${body.metadata.name}" already exists`), { status: 409 })
      if (!dry) await mkdir(dir, { recursive: true })
      return { ...body, metadata: { ...body.metadata, creationTimestamp: nowIso() }, status: { phase: 'Bound' } }
    }
    if (method === 'GET' && p === '/api/v1/nodes') {
      const allocatable = { cpu: String(this.ncpu || 1), memory: String(this.memTotal || 0) }
      if (this.gpuIds.length) allocatable['nvidia.com/gpu'] = String(this.gpuIds.length)
      return { kind: 'NodeList', items: [{ metadata: { name: 'docker' }, status: { allocatable, capacity: allocatable } }] }
    }
    if (method === 'GET' && p === '/api/v1/pods') {
      if (Date.now() - this.listedAt > 1000) await this.pump()
      const items = []
      for (const rec of this.jobs.values()) {
        for (const pod of rec.pods) {
          const o = this.#podObject(rec, pod)
          if (o.status.phase === 'Running' || o.status.phase === 'Pending') items.push({ ...o, spec: { ...o.spec, containers: rec.spec.spec?.template?.spec?.containers ?? [] } })
        }
      }
      return { kind: 'PodList', items }
    }
    if (method === 'GET' && /^\/api\/v1\/namespaces\/[^/]+\/services$/.test(p)) return { kind: 'ServiceList', items: [] }
    throw Object.assign(new Error(`${method} ${p} is not served by the docker runner`), { status: 404 })
  }

  /* ---- the pump: start what can start, end what has to end ---- */

  /** Serialised: two pumps at once would both see a free slot and both take it. */
  pump() {
    this.chain = this.chain.then(() => this.#pump()).catch((e) => this.log(`pump: ${e.message ?? e}`))
    return this.chain
  }

  async #pump() {
    await this.#load()
    const list = await this.engine.listContainers({ label: [`${MANAGED}=true`] })
    this.containers = new Map(list.map((c) => [(c.Names?.[0] ?? '').replace(/^\//, ''), { State: c.State, Status: c.Status, Labels: c.Labels ?? {}, Id: c.Id }]))
    this.listedAt = Date.now()
    // the running states need the exit code, which only an inspect carries
    for (const [name, c] of this.containers) {
      if (c.State === 'exited' || c.State === 'dead') {
        const known = this.exits?.get(name)
        if (known) Object.assign(c, known)
        else {
          const i = await this.engine.inspectContainer(name).catch(() => null)
          if (i) {
            const s = { exitCode: i.State?.ExitCode ?? -1, oom: !!i.State?.OOMKilled, finishedAt: i.State?.FinishedAt ?? null, error: i.State?.Error || null }
            ;(this.exits ??= new Map()).set(name, s)
            Object.assign(c, s)
          }
        }
      }
      if (c.State === 'running' && !c.startedAt) {
        const i = await this.engine.inspectContainer(name).catch(() => null)
        c.startedAt = i?.State?.StartedAt ?? null
      }
    }

    // orphans: a container whose record is gone (a delete, or a record removed by hand)
    for (const [name, c] of this.containers) {
      if (!this.jobs.has(c.Labels[JOB])) {
        this.containers.delete(name)
        void this.engine.removeContainer(name).catch(() => {})
      }
    }

    const recs = [...this.jobs.values()].sort((a, b) => a.seq - b.seq)
    const now = Date.now()
    const held = new Set()
    for (const rec of recs) for (const p of rec.pods) if (this.#holds(p)) for (const g of p.gpus) held.add(g)
    let running = recs.filter((r) => poolOf(r) === 'bake').flatMap((r) => r.pods).filter((p) => this.#holds(p)).length

    for (const rec of recs) {
      const st = this.#jobStatus(rec)
      if (st.terminal) {
        if (!rec.completionTime) {
          rec.completionTime = nowIso()
          if (st.failed) {
            // a failed pod fails the Job, and the Job stops its siblings, as backoffLimit 0 does
            for (const p of rec.pods) for (const s of p.stages) if (this.containers.get(s)?.State === 'running') void this.engine.stopContainer(s).catch(() => {})
          }
          await this.#write(rec)
        }
        const ttl = rec.spec.spec?.ttlSecondsAfterFinished
        if (ttl !== undefined && ttl !== null && now - Date.parse(rec.completionTime) > ttl * 1000) {
          this.jobs.delete(rec.name)
          await rm(path.join(this.stateDir, `${rec.name}.json`), { force: true })
          void this.#reap(rec).catch(() => {})
        }
        continue
      }
      const deadline = rec.spec.spec?.activeDeadlineSeconds
      if (deadline && rec.startTime && now - Date.parse(rec.startTime) > deadline * 1000) {
        rec.failure = { reason: 'DeadlineExceeded', message: `Job was active longer than ${deadline} s` }
        await this.#write(rec)
        for (const p of rec.pods) for (const s of p.stages) if (this.containers.get(s)?.State === 'running') void this.engine.stopContainer(s).catch(() => {})
        continue
      }
      for (const pod of rec.pods) {
        if (pod.error || this.starting.has(pod.name)) continue
        const next = this.#nextStage(pod)
        if (!next) continue
        if (next.index === 0) {
          // a NEW pod: it needs a slot and its GPUs
          if (poolOf(rec) === 'bake' && running >= this.#max()) continue
          const want = gpusOf(this.#stageSpec(rec, 0, pod)).count || gpusOf(this.#stageSpec(rec, pod.stages.length - 1, pod)).count
          if (want && this.gpuIds.length) {
            const free = this.gpuIds.filter((g) => !held.has(g))
            if (want > this.gpuIds.length) {
              pod.error = `asks for ${want} GPUs and this host is configured with ${this.gpuIds.length}`
              await this.#write(rec)
              continue
            }
            if (free.length < want) continue
            pod.gpus = free.slice(0, want)
            for (const g of pod.gpus) held.add(g)
          }
          if (poolOf(rec) === 'bake') running++
        }
        this.starting.add(pod.name)
        void this.#startStage(rec, pod, next.index)
          .catch(async (e) => {
            pod.error = String(e.message ?? e)
            this.log(`${pod.name}: ${pod.error}`)
            await this.#write(rec).catch(() => {})
          })
          .finally(() => this.starting.delete(pod.name))
      }
    }
  }

  /** The stage a pod should run next, or null: running, finished, or failed. */
  #nextStage(pod) {
    for (let i = 0; i < pod.stages.length; i++) {
      const c = this.containers.get(pod.stages[i])
      if (!c) return { index: i }
      if (c.State === 'exited' || c.State === 'dead') {
        if (c.exitCode === 0) continue
        return null
      }
      if (c.State === 'created') return { index: i, created: true }
      return null // running, restarting, paused
    }
    return null
  }

  /** A pod holds its slot and its GPUs from its first start until it ends. */
  #holds(pod) {
    if (this.starting.has(pod.name)) return true
    if (pod.error) return false
    const phase = this.#phase(pod)
    return phase === 'Running' || (phase === 'Pending' && !!pod.started)
  }

  #stageSpec(rec, i, pod) {
    const t = rec.spec.spec?.template?.spec ?? {}
    const inits = t.initContainers ?? []
    return i < pod.stages.length - 1 ? inits[i] : t.containers[0]
  }

  async #startStage(rec, pod, i) {
    const tmpl = rec.spec.spec?.template?.spec ?? {}
    const container = this.#stageSpec(rec, i, pod)
    const name = pod.stages[i]
    if (!this.containers.has(name)) {
      await this.#ensureImage(container, rec, pod)
      const { body, warnings } = containerBody({
        job: rec.spec,
        pod,
        container,
        podSpec: tmpl,
        ctx: {
          network: this.network,
          namespace: this.namespace,
          volume: (v) => this.#volumeSource(v),
          secretEnv: (n, optional) => this.#secretEnv(n, optional),
          gpuIds: pod.gpus.length ? pod.gpus : null,
          ncpu: this.ncpu,
          shmSize: this.shmSize,
          extraLabels: { [MANAGED]: 'true', [JOB]: rec.name, [POD]: pod.name, [STAGE]: String(i) },
        },
      })
      for (const w of warnings) this.log(`${name}: ${w}`)
      for (const b of body.HostConfig.Binds) {
        // a claim the cluster would have provisioned: the directory, made before the daemon is asked
        const src = b.split(':')[0]
        if (src.startsWith(path.join(this.root, 'volumes'))) await mkdir(src, { recursive: true }).catch(() => {})
      }
      await this.engine.createContainer(name, body)
    }
    await this.engine.startContainer(name)
    const t = nowIso()
    if (!pod.started) pod.started = t
    if (!rec.startTime) rec.startTime = t
    await this.#write(rec)
    this.containers.set(name, { State: 'running', Labels: { [JOB]: rec.name }, startedAt: t })
  }

  /**
   * PULL BEFORE EVERY CREATE, whatever the tag and whatever the spec's imagePullPolicy says (Rich,
   * 2026-10-10: "Policy should be always, always"). Throttled to once per image per minute only so
   * that twenty-five shards starting together pull once, not twenty-five times.
   *
   * A pull that fails with the image already here runs the local copy — on a cluster it would be
   * ImagePullBackOff, and on one host offline that would stop every bake — but NOT QUIETLY: the
   * warning is an event on the pod, and the pod's log stream opens with it, so it lands in the
   * run's own log where the person watching the bake reads it.
   */
  async #ensureImage(container, rec, pod) {
    const image = container.image
    const last = this.pulled.get(image)
    if (last && Date.now() - last < 60000) return
    try {
      await this.engine.pull(image, { auth: this.#authFor(image) })
      this.pulled.set(image, Date.now())
    } catch (e) {
      if (await this.engine.imageExists(image).catch(() => false)) {
        const text = `[docker] WARNING: could not pull ${image} (${e.message}); running the copy already on this host, which may be stale`
        this.log(`${pod.name}: ${text}`)
        ;(pod.events ??= []).push({ stamp: stampOf(new Date()), text })
        await this.#write(rec).catch(() => {})
        return
      }
      throw e
    }
  }

  /** X-Registry-Auth from a docker config.json, for a private registry (ghcr.io/hotspoons). Never logged. */
  #authFor(image) {
    if (!this.authFile) return null
    try {
      const cfg = JSON.parse(readFileSync(this.authFile, 'utf8'))
      const { registry } = parseImage(image)
      const keys = registry === 'docker.io' ? ['https://index.docker.io/v1/', 'docker.io', 'index.docker.io'] : [registry, `https://${registry}`]
      const a = keys.map((k) => cfg?.auths?.[k]).find(Boolean)
      if (!a) return null
      let username = a.username
      let password = a.password
      if (a.auth) {
        const raw = Buffer.from(a.auth, 'base64').toString('utf8')
        const i = raw.indexOf(':')
        username = raw.slice(0, i)
        password = raw.slice(i + 1)
      }
      if (!username && !a.identitytoken) return null
      const doc = a.identitytoken ? { identitytoken: a.identitytoken, serveraddress: registry } : { username, password, serveraddress: registry }
      return Buffer.from(JSON.stringify(doc)).toString('base64url')
    } catch {
      return null
    }
  }

  #claimPath(claim) {
    return this.claims[claim] ?? path.join(this.root, 'volumes', claim)
  }

  /** Where a Kubernetes volume is on this host, as the daemon sees it. */
  #volumeSource(v) {
    if (v.persistentVolumeClaim) return this.#claimPath(v.persistentVolumeClaim.claimName)
    if (v.configMap) return path.join(this.root, 'configmaps', v.configMap.name)
    if (v.secret) return path.join(this.root, 'secrets', v.secret.secretName)
    if (v.hostPath) return v.hostPath.path
    return null
  }

  /** A Secret is `<root>/secrets/<name>.env`: KEY=VALUE lines. Missing and optional is nothing. */
  #secretEnv(name, optional) {
    const file = path.join(this.root, 'secrets', `${name}.env`)
    try {
      return readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('='))
    } catch {
      if (!optional) this.log(`secret ${name}: no ${file}`)
      return []
    }
  }

  async #reap(rec) {
    for (const p of rec.pods) {
      for (const s of p.stages) {
        await this.engine.stopContainer(s, Number(rec.spec.spec?.template?.spec?.terminationGracePeriodSeconds ?? 10)).catch(() => {})
        await this.engine.removeContainer(s).catch(() => {})
        this.containers.delete(s)
        this.exits?.delete(s)
      }
      for (const v of rec.spec.spec?.template?.spec?.volumes ?? []) if (v.emptyDir && v.emptyDir.medium !== 'Memory') await this.engine.removeVolume(`${p.name}-${v.name}`)
    }
  }

  /* ---- reading state back in Kubernetes' words ---- */

  #findPod(name) {
    for (const rec of this.jobs.values()) {
      const pod = rec.pods.find((p) => p.name === name)
      if (pod) return { rec, pod }
    }
    return null
  }

  #phase(pod) {
    if (pod.error) return 'Failed'
    for (let i = 0; i < pod.stages.length; i++) {
      const c = this.containers.get(pod.stages[i])
      if (!c || c.State === 'created') return 'Pending'
      if (c.State === 'exited' || c.State === 'dead') {
        if (c.exitCode === undefined) return 'Running' // exited a moment ago; the inspect is next pump
        if (c.exitCode !== 0) return 'Failed'
        if (i === pod.stages.length - 1) return 'Succeeded'
        continue
      }
      return i === pod.stages.length - 1 ? 'Running' : 'Pending' // an init container running: PodInitializing
    }
    return 'Pending'
  }

  /** Why a pod failed, in a sentence a person can act on. */
  #why(pod) {
    if (pod.error) return pod.error
    for (const s of pod.stages) {
      const c = this.containers.get(s)
      if (c && (c.State === 'exited' || c.State === 'dead') && c.exitCode !== 0) {
        const init = s !== pod.stages.at(-1) ? ' (init container)' : ''
        if (c.oom) return `${s}${init}: killed — out of memory (OOMKilled, exit ${c.exitCode})`
        if (c.exitCode === 137) return `${s}${init}: killed (exit 137)`
        return `${s}${init}: exited ${c.exitCode}${c.error ? ` — ${c.error}` : ''}`
      }
    }
    return 'a pod failed'
  }

  #jobStatus(rec) {
    let active = 0
    let succeeded = 0
    let failed = 0
    let failedPod = null
    for (const p of rec.pods) {
      const ph = this.#phase(p)
      if (ph === 'Running' || (ph === 'Pending' && this.#holds(p))) active++
      else if (ph === 'Succeeded') succeeded++
      else if (ph === 'Failed') {
        failed++
        failedPod ??= p
      }
    }
    const completions = rec.pods.length
    const done = succeeded >= completions
    const isFailed = !!rec.failure || failed > 0
    return { active, succeeded, failed: isFailed ? Math.max(1, failed) : 0, terminal: done || isFailed, done, failedPod }
  }

  #jobObject(rec) {
    const st = this.#jobStatus(rec)
    const status = {}
    if (st.active) status.active = st.active
    if (st.succeeded) status.succeeded = st.succeeded
    if (st.failed) status.failed = st.failed
    if (rec.startTime) status.startTime = rec.startTime
    if (st.done) {
      status.completionTime = rec.completionTime ?? nowIso()
      status.conditions = [{ type: 'Complete', status: 'True', lastTransitionTime: status.completionTime }]
    } else if (st.failed) {
      const f = rec.failure ?? { reason: 'BackoffLimitExceeded', message: this.#why(st.failedPod ?? rec.pods[0]) }
      status.conditions = [{ type: 'Failed', status: 'True', reason: f.reason, message: f.message, lastTransitionTime: rec.completionTime ?? nowIso() }]
    }
    return {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: rec.name, labels: rec.spec.metadata?.labels ?? {}, creationTimestamp: rec.created },
      spec: rec.spec.spec,
      status,
    }
  }

  #podObject(rec, pod) {
    return {
      metadata: { name: pod.name, labels: { ...(rec.spec.spec?.template?.metadata?.labels ?? {}), 'job-name': rec.name } },
      spec: { nodeName: 'docker' },
      status: { phase: this.#phase(pod), ...(pod.error ? { message: pod.error } : {}), ...(pod.gpus.length ? { gpus: pod.gpus } : {}) },
    }
  }
}

function poolOf(rec) {
  return rec.spec.metadata?.labels?.['worldeditor/kind'] === 'bake' ? 'bake' : 'other'
}

/** "3" -> ['0','1','2']; "0,2" -> ['0','2']; 0 / '' -> [] */
export function gpuList(v) {
  if (Array.isArray(v)) return v.map(String)
  const s = String(v ?? '').trim()
  if (!s || s === '0') return []
  if (/^\d+$/.test(s)) return Array.from({ length: Number(s) }, (_, i) => String(i))
  return s.split(',').map((x) => x.trim()).filter(Boolean)
}

/**
 * Which backend the editor's Jobs go to.
 *
 *   PIEDMONT_EDITOR_RUNNER=docker       the Docker Engine on PIEDMONT_EDITOR_DOCKER_SOCKET (or DOCKER_HOST)
 *   PIEDMONT_EDITOR_RUNNER=local        subprocesses (Runs reads `force` itself; this returns K8s, unused)
 *   anything else, or unset         Kubernetes when a service-account token is mounted, else local
 *
 * DOCKER IS NEVER CHOSEN BY DETECTION. A laptop with Docker Desktop has a socket and has always run
 * its bakes as subprocesses; finding the socket and switching would change what an unchanged laptop
 * does. And in a cluster Kubernetes stays the default whatever is mounted.
 */
export function jobBackend(env, { K8s, data, dataClaim, maxParallel } = {}) {
  if (String(env.PIEDMONT_EDITOR_RUNNER ?? '').toLowerCase() !== 'docker') return new K8s(env)
  const host = env.PIEDMONT_EDITOR_DOCKER_SOCKET || env.DOCKER_HOST || 'unix:///var/run/docker.sock'
  const socketPath = host.replace(/^unix:\/\//, '')
  const root = env.PIEDMONT_EDITOR_DOCKER_ROOT || '/srv/piedmont'
  const claims = { ...JSON.parse(env.PIEDMONT_EDITOR_DOCKER_CLAIMS || '{}') }
  // the bake's claim IS the editor's data directory, at the same path the daemon sees. Its name is
  // whatever the caller's Jobs say (PIEDMONT_EDITOR_CLAIM, else the server's own default).
  const claim = env.PIEDMONT_EDITOR_CLAIM || dataClaim
  if (claim) claims[claim] ??= data
  return new DockerJobs({
    socketPath,
    apiVersion: env.PIEDMONT_EDITOR_DOCKER_API_VERSION || null,
    root,
    stateDir: env.PIEDMONT_EDITOR_DOCKER_STATE || path.join(root, 'jobs'),
    claims,
    network: env.PIEDMONT_EDITOR_DOCKER_NETWORK || 'piedmont',
    namespace: env.PIEDMONT_EDITOR_NAMESPACE || 'default',
    maxParallel: maxParallel ?? Number(env.PIEDMONT_EDITOR_DOCKER_MAX_PARALLEL || 1),
    gpus: env.PIEDMONT_EDITOR_DOCKER_GPUS || 0,
    shmSize: bytesOf(env.PIEDMONT_EDITOR_DOCKER_SHM || '1Gi'),
    authFile: env.PIEDMONT_EDITOR_DOCKER_AUTH || (existsSync('/run/piedmont/docker-config.json') ? '/run/piedmont/docker-config.json' : null),
  })
}
