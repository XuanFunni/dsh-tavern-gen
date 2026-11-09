import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BASE = '/dsh-tavern-gen'

async function createPlugin(t, { config = {}, listener = {}, savedOrigin, rawOrigin } = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'dsh-tavern-gen-origin-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = path.join(temporary, 'plugins', 'dsh-tavern-gen')
  const originFile = path.join(temporary, 'image-cache', 'dsh-tavern-gen', 'origin.json')
  await mkdir(root, { recursive: true })
  await cp(path.join(ROOT, 'lib'), path.join(root, 'lib'), { recursive: true })
  // Exercise the real tool and routes without submitting a paid image request.
  await writeFile(path.join(root, 'lib', 'image-providers.js'), `
    export const IMAGE_PROVIDERS = [{ id: 'openai', label: 'Test' }]
    export async function testImageChannel() { return { ok: true } }
    export async function generateImage() {
      return { mediaType: 'image/png', bytes: Buffer.from('test image') }
    }
  `)
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }))
  await writeFile(path.join(root, 'config.json'), JSON.stringify({
    imageBackend: 'openai',
    activeImageChannel: 'test',
    imageChannels: [{ id: 'test', name: 'Test', provider: 'openai', apiKey: 'test-only' }],
    ...config,
  }))
  await writeFile(path.join(root, 'definitions.json'), JSON.stringify({ version: 1, characters: [] }))
  await writeFile(path.join(root, 'worldbook.json'), JSON.stringify({ version: 3, buckets: [] }))
  if (savedOrigin !== undefined || rawOrigin !== undefined) {
    await mkdir(path.dirname(originFile), { recursive: true })
    await writeFile(originFile, rawOrigin ?? JSON.stringify(savedOrigin))
  }
  const { apply } = await import(pathToFileURL(path.join(root, 'lib', 'index.js')).href)
  const warnings = []

  async function start() {
    const routes = new Map()
    let resolveTool
    const ready = new Promise(resolve => { resolveTool = resolve })
    const webServer = {
      get host() { return typeof listener.host === 'function' ? listener.host() : listener.host },
      get port() { return typeof listener.port === 'function' ? listener.port() : listener.port },
      get getOrigin() { throw new Error('getOrigin must not be accessed') },
      register({ path: route, handler }) {
        routes.set(route, handler)
        return () => routes.delete(route)
      },
    }
    const tools = {
      register(tool) {
        if (tool.name === 'gen_image') resolveTool(tool)
        return () => {}
      },
    }
    apply({
      logger: { warn(...args) { warnings.push(args.join(' ')) } },
      inject(services, install) {
        if (services[0] === 'webServer') install({ webServer })
        if (services[0] === 'tools') install({ tools })
      },
    })
    const tool = await ready

    async function request(route, { headers = {}, method = 'GET', body, encrypted = false } = {}) {
      const incoming = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
      Object.assign(incoming, {
        url: `${BASE}/${route}`,
        method,
        headers,
        socket: { encrypted },
      })
      const response = {
        status: 0,
        headersSent: false,
        writeHead(status, responseHeaders) {
          this.status = status
          this.headers = responseHeaders
          this.headersSent = true
        },
        end(value) { this.text = value === undefined ? '' : String(value) },
      }
      const handler = routes.get(route.startsWith('api/') ? `${BASE}/api` : `${BASE}/img`)
      await handler(incoming, response)
      return {
        status: response.status,
        body: response.headers?.['content-type']?.startsWith('application/json')
          ? JSON.parse(response.text)
          : response.text,
      }
    }

    return {
      request,
      tool,
      originFile,
      listener,
      warnings,
      restart: start,
      async generate() { return tool.execute({ prompt: 'landscape' }) },
    }
  }
  return start()
}

async function eventually(assertion) {
  const deadline = Date.now() + 2000
  let failure
  do {
    try { return await assertion() }
    catch (error) { failure = error }
    await setTimeout(5)
  } while (Date.now() < deadline)
  throw failure
}

async function assertPersistedOrigin(plugin, expected) {
  return eventually(async () => {
    const value = JSON.parse(await readFile(plugin.originFile, 'utf8'))
    assert.equal(value.origin, expected)
    assert.ok(value.updatedAt)
    return value
  })
}

async function originSnapshot(plugin) {
  return {
    content: await readFile(plugin.originFile, 'utf8'),
    modified: (await stat(plugin.originFile)).mtimeMs,
  }
}

async function assertGeneratedOrigin(plugin, expected) {
  const result = await plugin.generate()
  assert.equal(result.ok, true)
  assert.equal(result.images.length, 1)
  const image = result.images[0]
  assert.equal(image.url, `${expected}${BASE}/img/${path.basename(image.file)}`)
  const markdown = plugin.tool.output.render({}, result).map(item => item.text).join('\n')
  assert.ok(markdown.includes(`](${image.url})`))
  return image
}

async function assertGalleryOrigin(plugin, expected, options) {
  const result = await plugin.request('api/gallery', options)
  assert.equal(result.status, 200)
  assert.ok(result.body.items.length > 0)
  for (const item of result.body.items) {
    assert.equal(item.url, `${expected}${BASE}/img/${item.file}`)
  }
  return result.body.items
}

test('old and empty configurations retain the relative fallback when all origin sources are missing', async t => {
  for (const config of [{}, { publicOrigin: '' }]) {
    const plugin = await createPlugin(t, { config })
    await assertGeneratedOrigin(plugin, '')
    await assertGalleryOrigin(plugin, '')
  }
})

test('publicOrigin overrides restored, learned, and listener origins and is normalized', async t => {
  const plugin = await createPlugin(t, {
    config: { publicOrigin: '  https://images.example.test:8443///  ' },
    listener: { host: '0.0.0.0', port: 3080 },
    savedOrigin: { origin: 'http://saved.example.test:3080', updatedAt: '2026-01-01' },
  })
  await assertGeneratedOrigin(plugin, 'https://images.example.test:8443')
  await assertGalleryOrigin(plugin, 'https://images.example.test:8443', {
    headers: { host: '192.168.1.2:3088' },
  })
  await assertPersistedOrigin(plugin, 'http://192.168.1.2:3088')
})

test('cold starts use listener host and port without opening a page or calling getOrigin', async t => {
  for (const host of ['0.0.0.0', '::', '[::]', '127.0.0.1']) {
    const plugin = await createPlugin(t, { listener: { host, port: 3080 } })
    await assertGeneratedOrigin(plugin, 'http://127.0.0.1:3080')
    await assertGalleryOrigin(plugin, 'http://127.0.0.1:3080')
    await assert.rejects(readFile(plugin.originFile), { code: 'ENOENT' })
  }
})

test('listener fallbacks format LAN and IPv6 addresses', async t => {
  for (const [host, expected] of [
    ['192.168.1.20', 'http://192.168.1.20:3088'],
    ['2001:db8::1', 'http://[2001:db8::1]:3088'],
    ['[::1]', 'http://[::1]:3088'],
  ]) {
    const plugin = await createPlugin(t, { listener: { host, port: 3088 } })
    await assertGeneratedOrigin(plugin, expected)
  }
})

test('missing, throwing, and invalid listener fields leave generation usable', async t => {
  for (const listener of [
    {},
    { host: '127.0.0.1' },
    { host: 'invalid/host', port: 3080 },
    { host: '127.0.0.1', port: 'invalid' },
    { host: '127.0.0.1', port: 65536 },
    { host: () => { throw new Error('unavailable') }, port: 3080 },
    { host: '127.0.0.1', port: () => { throw new Error('unavailable') } },
  ]) {
    const plugin = await createPlugin(t, { listener })
    await assertGeneratedOrigin(plugin, '')
  }
})

test('delayed listener fields are retried before generation and unlearned ports stay current', async t => {
  const listener = {}
  const plugin = await createPlugin(t, { listener })
  listener.host = '0.0.0.0'
  listener.port = 3080
  await assertGeneratedOrigin(plugin, 'http://127.0.0.1:3080')
  listener.port = 3088
  await assertGeneratedOrigin(plugin, 'http://127.0.0.1:3088')
})

test('saved origins are restored before the first generated image', async t => {
  const plugin = await createPlugin(t, {
    listener: { host: '0.0.0.0', port: 3080 },
    savedOrigin: { origin: 'https://saved.example.test:8443', updatedAt: '2026-01-01' },
  })
  await assertGeneratedOrigin(plugin, 'https://saved.example.test:8443')
  await assertGalleryOrigin(plugin, 'https://saved.example.test:8443')
})

test('malformed and unsafe saved origins are ignored on startup', async t => {
  for (const rawOrigin of [
    '{broken',
    'null',
    '[]',
    '{}',
    '{"origin":"javascript:alert(1)"}',
    '{"origin":"https://name:password@example.test"}',
    '{"origin":"https://example.test?token=secret"}',
  ]) {
    const plugin = await createPlugin(t, {
      listener: { host: '0.0.0.0', port: 3080 },
      rawOrigin,
    })
    await assertGeneratedOrigin(plugin, 'http://127.0.0.1:3080')
  }
})

test('API requests learn Android origins and gallery links follow changed ports', async t => {
  const plugin = await createPlugin(t)
  const state = await plugin.request('api/state', { headers: { host: '127.0.0.1:3080' } })
  assert.equal(state.status, 200)
  const first = await assertGeneratedOrigin(plugin, 'http://127.0.0.1:3080')
  const items = await assertGalleryOrigin(plugin, 'http://127.0.0.1:3088', {
    headers: { host: '127.0.0.1:3088' },
  })
  assert.equal(items[0].file, path.basename(first.file))
  await assertGeneratedOrigin(plugin, 'http://127.0.0.1:3088')
  await assertPersistedOrigin(plugin, 'http://127.0.0.1:3088')
})

test('browser API origins replace a loopback listener origin and support LAN and IPv6 addresses', async t => {
  const plugin = await createPlugin(t, { listener: { host: '127.0.0.1', port: 3080 } })
  for (const host of ['192.168.1.20:3088', '[::1]:3088']) {
    const state = await plugin.request('api/state', { headers: { host } })
    assert.equal(state.status, 200)
    await assertGeneratedOrigin(plugin, `http://${host}`)
    await assertGalleryOrigin(plugin, `http://${host}`)
  }
  await assertPersistedOrigin(plugin, 'http://[::1]:3088')
})

test('reverse proxies use the first forwarded host and protocol values', async t => {
  const plugin = await createPlugin(t)
  const headers = {
    host: '127.0.0.1:3080',
    'x-forwarded-host': ' images.example.test:8443, proxy.internal ',
    'x-forwarded-proto': ' https, http ',
  }
  const state = await plugin.request('api/state', { headers })
  assert.equal(state.status, 200)
  await assertGeneratedOrigin(plugin, 'https://images.example.test:8443')
  await assertGalleryOrigin(plugin, 'https://images.example.test:8443', { headers })
  await assertPersistedOrigin(plugin, 'https://images.example.test:8443')
})

test('array-valued forwarded headers use the first item and its first proxy value', async t => {
  const plugin = await createPlugin(t)
  const headers = {
    host: '127.0.0.1:3080',
    'x-forwarded-host': [' images.example.test:8443, first.proxy ', 'second.proxy'],
    'x-forwarded-proto': [' https, http ', 'http'],
  }
  const state = await plugin.request('api/state', { headers })
  assert.equal(state.status, 200)
  await assertGeneratedOrigin(plugin, 'https://images.example.test:8443')
  await assertGalleryOrigin(plugin, 'https://images.example.test:8443', { headers })
  await assertPersistedOrigin(plugin, 'https://images.example.test:8443')
})

test('direct TLS requests infer HTTPS without proxy headers', async t => {
  const plugin = await createPlugin(t)
  const result = await plugin.request('api/state', {
    headers: { host: 'tavern.example.test' },
    encrypted: true,
  })
  assert.equal(result.status, 200)
  await assertGeneratedOrigin(plugin, 'https://tavern.example.test')
  await assertPersistedOrigin(plugin, 'https://tavern.example.test')
})

test('invalid request origins do not overwrite the last valid API origin', async t => {
  const plugin = await createPlugin(t)
  await plugin.request('api/state', { headers: { host: '127.0.0.1:3080' } })
  await assertPersistedOrigin(plugin, 'http://127.0.0.1:3080')
  const snapshot = await originSnapshot(plugin)
  const invalidHeaders = [
    {},
    { host: 'invalid host' },
    { host: '127.0.0.1:3080', 'x-forwarded-proto': 'javascript' },
    { host: '127.0.0.1:3080', 'x-forwarded-proto': 'ftp' },
    ...[
      'https://other.example.test',
      'other.example.test/path',
      'name:password@other.example.test',
      'other.example.test?token=secret',
      'other.example.test#fragment',
      'other.example.test\\path',
      'other.\nexample.test',
      'other.example.test:invalid',
      'bad)host.example.test',
      'bad%29host.example.test',
    ].map(host => ({ host: '127.0.0.1:3080', 'x-forwarded-host': host })),
  ]
  for (const headers of invalidHeaders) {
    await plugin.request('api/state', { headers })
    await assertGeneratedOrigin(plugin, 'http://127.0.0.1:3080')
  }
  await setTimeout(30)
  assert.deepEqual(await originSnapshot(plugin), snapshot)
})

test('invalid configured origins fall back without putting credentials or tokens in image URLs', async t => {
  for (const publicOrigin of [
    'javascript:alert(1)',
    'https://name:password@images.example.test',
    'https://images.example.test/path',
    'https://images.example.test?token=secret',
    'https://images.example.test#fragment',
    'http:///images.example.test',
    'http:\\\\images.example.test',
    'https://im\nages.example.test',
    'https://images.example.test:invalid',
    'https://bad)host.example.test',
    'https://bad%29host.example.test',
    3080,
  ]) {
    const plugin = await createPlugin(t, { config: { publicOrigin } })
    await plugin.request('api/state', { headers: { host: '127.0.0.1:3080' } })
    const image = await assertGeneratedOrigin(plugin, 'http://127.0.0.1:3080')
    assert.ok(!image.url.includes('secret'))
    await assertGalleryOrigin(plugin, 'http://127.0.0.1:3080')
    await assertPersistedOrigin(plugin, 'http://127.0.0.1:3080')
  }
})

test('image requests immediately learn and persist their externally reachable origin', async t => {
  const plugin = await createPlugin(t, { listener: { host: '0.0.0.0', port: 3080 } })
  const image = await assertGeneratedOrigin(plugin, 'http://127.0.0.1:3080')
  const response = await plugin.request(`img/${path.basename(image.file)}`, {
    headers: {
      host: '127.0.0.1:3080',
      'x-forwarded-host': 'images.example.test',
      'x-forwarded-proto': 'https',
    },
    method: 'HEAD',
  })
  assert.equal(response.status, 200)
  await assertGeneratedOrigin(plugin, 'https://images.example.test')
  await assertPersistedOrigin(plugin, 'https://images.example.test')
})

test('learned origins survive an actual restart before any new browser request', async t => {
  const plugin = await createPlugin(t, { listener: { host: '0.0.0.0', port: 3080 } })
  await plugin.request('api/state', { headers: { host: '192.168.1.20:3088' } })
  await assertPersistedOrigin(plugin, 'http://192.168.1.20:3088')
  const restarted = await plugin.restart()
  await assertGeneratedOrigin(restarted, 'http://192.168.1.20:3088')
  await assertGalleryOrigin(restarted, 'http://192.168.1.20:3088')
})

test('saved learned origins outrank a changed listener until a request refreshes them', async t => {
  const listener = { host: '0.0.0.0', port: 3080 }
  const plugin = await createPlugin(t, { listener })
  await plugin.request('api/state', { headers: { host: '127.0.0.1:3080' } })
  await assertPersistedOrigin(plugin, 'http://127.0.0.1:3080')
  listener.port = 3088
  await assertGeneratedOrigin(plugin, 'http://127.0.0.1:3080')
  const restarted = await plugin.restart()
  const image = await assertGeneratedOrigin(restarted, 'http://127.0.0.1:3080')
  const response = await restarted.request(`img/${path.basename(image.file)}`, {
    headers: { host: '127.0.0.1:3088' },
    method: 'HEAD',
  })
  assert.equal(response.status, 200)
  await assertGeneratedOrigin(restarted, 'http://127.0.0.1:3088')
  await assertPersistedOrigin(restarted, 'http://127.0.0.1:3088')
})

test('unchanged request origins do not rewrite the saved record', async t => {
  const plugin = await createPlugin(t)
  const headers = { host: '127.0.0.1:3080' }
  await plugin.request('api/state', { headers })
  await assertPersistedOrigin(plugin, 'http://127.0.0.1:3080')
  const snapshot = await originSnapshot(plugin)
  await plugin.request('api/state', { headers })
  const image = await assertGeneratedOrigin(plugin, 'http://127.0.0.1:3080')
  assert.equal((await plugin.request(`img/${path.basename(image.file)}`, {
    headers,
    method: 'HEAD',
  })).status, 200)
  await setTimeout(30)
  assert.deepEqual(await originSnapshot(plugin), snapshot)
})

test('rapid origin changes are persisted in order with the latest value last', async t => {
  const plugin = await createPlugin(t)
  const hosts = ['first.example.test', 'second.example.test', 'last.example.test']
  const responses = await Promise.all(hosts.map(host =>
    plugin.request('api/state', { headers: { host } })))
  assert.ok(responses.every(response => response.status === 200))
  await assertGeneratedOrigin(plugin, 'http://last.example.test')
  await assertPersistedOrigin(plugin, 'http://last.example.test')
  await setTimeout(30)
  assert.equal(JSON.parse(await readFile(plugin.originFile, 'utf8')).origin, 'http://last.example.test')
})

test('origin persistence failures warn without breaking requests or generation', async t => {
  const plugin = await createPlugin(t)
  await mkdir(plugin.originFile, { recursive: true })
  const before = plugin.warnings.length
  const response = await plugin.request('api/state', {
    headers: { host: '192.168.1.20:3080' },
  })
  assert.equal(response.status, 200)
  await assertGeneratedOrigin(plugin, 'http://192.168.1.20:3080')
  await eventually(() => assert.ok(plugin.warnings.length > before))
})

test('saving publicOrigin takes effect immediately and clearing it restores automatic inference', async t => {
  const plugin = await createPlugin(t)
  const headers = { host: '127.0.0.1:3080' }
  const state = await plugin.request('api/state', { headers })
  for (const publicOrigin of ['https://images.example.test/', '']) {
    const response = await plugin.request('api/save', {
      headers,
      method: 'POST',
      body: { target: 'config', content: { ...state.body.config, publicOrigin } },
    })
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)
    const origin = publicOrigin ? 'https://images.example.test' : 'http://127.0.0.1:3080'
    await assertGeneratedOrigin(plugin, origin)
    await assertGalleryOrigin(plugin, origin)
  }
  await assertPersistedOrigin(plugin, 'http://127.0.0.1:3080')
})
