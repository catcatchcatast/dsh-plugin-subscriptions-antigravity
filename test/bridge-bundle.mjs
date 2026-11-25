// 变更追溯：CHG-20261124-145318-quota-models-47c9e254；记录：.codex/doc/change-history/CHG-20261124-145318-quota-models-47c9e254.md
// 变更追溯：CHG-20261124-113809-agy-shell-c58464c9；记录：.codex/doc/change-history/CHG-20261124-113809-agy-shell-c58464c9.md
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import * as backend from 'dsh-plugin-subscriptions/antigravity-bridge'
import * as subscriptions from 'dsh-plugin-subscriptions'

test('both bundle entries mount with a single Google route and no Google credential lookup', async t => {
  const home = await mkdtemp(join(tmpdir(), 'agy-shell-bundle-'))
  const ctx = new Context()
  const routes = []
  ctx.provide('llm', {
    registerConfigurableProviders() {},
    registerAdapter(ids) { routes.push(...ids); return Object.assign(() => {}, { replace() {} }) },
  })
  ctx.provide('subprocess', { spawn() { throw new Error('unexpected CLI startup with warmup disabled') } })
  const bridge = ctx.plugin(backend, { home, warmup: false, accounts: [], configVersion: 2 })
  const shell = ctx.plugin(subscriptions, { providers: ['codex', 'claude', 'grok', 'copilot'], pool: { enabled: false } })
  t.after(async () => { await shell.dispose(); await bridge.dispose() })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(routes.sort(), ['antigravity', 'claude', 'codex', 'copilot', 'grok'])
  assert.deepEqual(ctx.get('antigravityAcp').status().accounts, [])
})

test('Google Manage writes only the bridge owner profile and reopens the effective catalog after restart', async t => {
  const home = await mkdtemp(join(tmpdir(), 'agy-managed-catalog-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const profile = join(home, 'profile.json')
  const owner = 'independent-bridge-fiber'
  const carbon = 'gemini-4-carbon'
  const argon = 'gemini-4-argon'
  const account = { id: 'alt', displayName: 'Preserved account', enabled: true, env: { TEST: 'preserved' } }
  const initial = { home, warmup: false, configVersion: 2, accounts: [account], visibleModels: [carbon, 'future-model'],
    hiddenModels: ['claude-*'], modelDisplayNames: { [carbon]: 'Carbon alias' }, defaultEffort: 'medium' }
  await writeFile(profile, JSON.stringify({ [owner]: initial, 'llm-subscriptions': { untouched: true } }))
  const load = async () => JSON.parse(await readFile(profile, 'utf8'))
  const ctx = new Context()
  const llm = new LlmRuntime(ctx)
  ctx.provide('subprocess', { spawn() { throw new Error('model management must not start a CLI') } })
  let rejectWrite = false
  const writes = []
  ctx.provide('settings', { writable: true, async update(ns, patch) {
    assert.equal(ns, owner)
    assert.ok(Object.keys(patch).every(key => key === 'visibleModels' || key === 'hiddenModels'))
    if (rejectWrite) throw new Error('Profile write denied')
    writes.push(patch)
    const config = await load()
    await writeFile(profile, JSON.stringify({ ...config, [ns]: { ...config[ns], ...patch } }))
  } })
  const routes = new Map()
  ctx.provide('connection', { fetch: { register(route) {
    routes.set(route.path, route)
    return async () => { routes.delete(route.path) }
  } } })
  const call = async (endpoint, payload = {}) => {
    const method = `subscriptions-auth.${endpoint}`
    const path = `/api/${method}`
    const response = await routes.get(path).fetch(new Request(`http://127.0.0.1${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'manage', method, payload }),
    }))
    return (await response.json()).result
  }
  const wrapper = { ...backend, apply(scope, config) {
    // Mirror Loader's profile entry id on this isolated plugin fiber.
    scope.fiber.entry = { options: { id: owner } }
    backend.apply(scope, config)
  } }
  let bridge = ctx.plugin(wrapper, (await load())[owner])
  const shell = ctx.plugin(subscriptions, { providers: [] })
  t.after(async () => { await shell.dispose(); await bridge.dispose() })
  await new Promise(resolve => setImmediate(resolve))
  const modelIds = async () => (await llm.listModels('antigravity')).map(row => row.id)
  const setModels = changes => call('setAntigravityModels', { changes })
  assert.deepEqual(await modelIds(), [carbon])
  const status = await call('antigravityModels')
  assert.ok(status.ok)
  assert.equal(status.value.models.find(row => row.id === argon).enabled, false)
  assert.ok(status.value.models.some(row => row.id.startsWith('claude-') && row.locked))
  assert.ok(!(await call('sessionAccount', { sessionId: 'other-host', read: 'setAntigravityModels' })).ok)
  const edits = [{ id: carbon, enabled: false }, { id: argon, enabled: true }]
  rejectWrite = true
  const failed = await setModels(edits)
  assert.equal(failed.error.message, 'Profile write denied')
  assert.equal(writes.length, 0)
  assert.deepEqual(await modelIds(), [carbon])
  rejectWrite = false
  const bridgeService = ctx.get('antigravityAcp')
  const configure = bridgeService.configure
  const rawConfigure = bridgeService[Symbol.for('cordis.original')]
  rawConfigure.configure = patch => patch.hiddenModels.includes(carbon) ? Promise.reject(new Error('Bridge apply denied')) : configure.call(bridgeService, patch)
  const applyFailed = await setModels(edits)
  assert.equal(applyFailed.error.message, 'Bridge apply denied')
  delete rawConfigure.configure
  assert.deepEqual(await modelIds(), [carbon])
  assert.deepEqual((await load())[owner].visibleModels, initial.visibleModels)
  assert.deepEqual((await load())[owner].hiddenModels, initial.hiddenModels)
  const success = await setModels(edits)
  assert.ok(success.ok, JSON.stringify(success))
  assert.deepEqual(await modelIds(), [argon])
  const persisted = await load()
  assert.deepEqual(persisted[owner], { ...initial, visibleModels: [carbon, 'future-model', argon], hiddenModels: ['claude-*', carbon] })
  assert.deepEqual(persisted['llm-subscriptions'], { untouched: true })
  await bridge.dispose()
  bridge = ctx.plugin(wrapper, persisted[owner])
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(await modelIds(), [argon])
  const reopened = await call('antigravityModels')
  assert.deepEqual(reopened, success)
})
