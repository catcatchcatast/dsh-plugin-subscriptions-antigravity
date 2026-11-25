// 变更追溯：CHG-20261124-152158-preview-parity-2fdd82c1；记录：.codex/doc/change-history/CHG-20261124-152158-preview-parity-2fdd82c1.md
// 变更追溯：CHG-20261124-145318-quota-models-47c9e254；记录：.codex/doc/change-history/CHG-20261124-145318-quota-models-47c9e254.md
// 变更追溯：CHG-20261124-113809-agy-shell-c58464c9；记录：.codex/doc/change-history/CHG-20261124-113809-agy-shell-c58464c9.md
// 变更追溯：CHG-20261124-upstream-0914-b8023110；记录：.codex/doc/change-history/CHG-20261124-upstream-0914-b8023110.md
// 变更追溯：CHG-20261103-143200-subscription-account-audit-b8023110；记录：.codex/doc/change-history/CHG-20261103-143200-subscription-account-audit-b8023110.md
// 变更追溯：底栏所属电脑RPC；记录：.codex/doc/change-history/CHG-20261113-owner-quota-b8023110.md
// 变更追溯：底栏生命周期取消；记录：.codex/doc/change-history/CHG-20261114-badge-overlay-b8023110.md
import { createSessionSubscriptionsRpc, callSubscriptionsAuth } from '../src/client/subscriptions-rpc.js'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { registerHooks } from 'node:module'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
// The host primitives ship CSS modules; Node needs only their empty class map
// for these pure-logic / server-render tests, not a browser stylesheet loader.
const css = registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.css')
    ? { format: 'module', source: 'export default {}', shortCircuit: true }
    : nextLoad(url, context)
} })
const { AccountWindows, CodexExhaustionNotice, compactSegment, createCurrentModelReader, prioritizeWindows,
  collapsedDisplays, expandedDisplays, retainSubscriptionSelection, sessionAccountDisplay, actualAccountLabel, usageBadgeIcon } = await import('../src/client/SubscriptionUsageBadge.js')
const { ImageGenerateToolview } = await import('../src/client/ImageGenerateToolview.js')
const { VideoGenerateToolview } = await import('../src/client/VideoGenerateToolview.js')
css.deregister()
import type { ProviderUsageDisplay } from '../src/client/SubscriptionUsageBadge.js'
import type { UsageWindow } from '../src/client/SubscriptionsSection.js'
import { en, zh } from '../src/client/locales.js'

test('media tool views render the preparing phase before arguments are available', () => {
  for (const [Component, name] of [[ImageGenerateToolview, 'image_generate'], [VideoGenerateToolview, 'video_generate']] as const) {
    // `args` is required on every tool-call head since DSH 0.2.1-rc.2; EMPTY is
    // the honest view for a call whose arguments have not arrived yet.
    const block = {
      phase: 'preparing' as const, callId: 'media-call', name, turn: 0, step: 0, time: 0,
      subCalls: [], args: PartialArguments.EMPTY,
    }
    const html = renderToStaticMarkup(createElement(Component, { block }))
    assert.ok(html.includes(name))
  }
})

test('media views observe streaming prompt updates and settled arguments', () => {
  for (const [Component, name] of [[ImageGenerateToolview, 'image_generate'], [VideoGenerateToolview, 'video_generate']] as const) {
    const args = new PartialArguments()
    const block = { phase: 'preparing' as const, callId: 'media-call', name, turn: 0, step: 0, time: 0, subCalls: [], args }
    const render = () => renderToStaticMarkup(createElement(Component, { block }))
    assert.match(render(), new RegExp(name))
    args.append('{"prompt":"Hello')
    assert.equal(args.refresh(), true)
    assert.match(render(), /Hello/)
    args.append(' world","referenceImages":[{},{}]}')
    assert.equal(args.refresh(), true)
    assert.match(render(), /Hello world/)
    if (name === 'image_generate') assert.match(render(), /\(2 ref\)/)
    const settled = { kind: 'tool-result' as const, seq: 1, time: 0, callId: 'media-call', name,
      args: PartialArguments.fromObject({ prompt: 'Finished', referenceImages: [{}, {}] }),
      call: null, callTime: null, content: [], subCalls: [], isError: false }
    assert.match(renderToStaticMarkup(createElement(Component, { block: settled })), /Finished/)
  }
})

test('media views support legacy calls without argument views', () => {
  for (const [Component, name] of [[ImageGenerateToolview, 'image_generate'], [VideoGenerateToolview, 'video_generate']] as const) {
    const raw = JSON.stringify({ prompt: 'Legacy prompt', referenceImages: [{}, {}] })
    const start = { phase: 'start', callId: 'legacy', name, turn: 0, step: 0, time: 0, subCalls: [], argsRaw: raw }
    const result = { kind: 'tool-result', seq: 1, time: 0, callId: 'legacy', name,
      call: { name, argsRaw: raw }, callTime: 0, content: [], subCalls: [], isError: false }
    for (const legacy of [start, result]) {
      const block = legacy as unknown as NonNullable<Parameters<typeof ImageGenerateToolview>[0]['block']>
      const html = renderToStaticMarkup(createElement(Component, { block }))
      assert.match(html, /Legacy prompt/)
      if (name === 'image_generate') assert.match(html, /\(2 ref\)/)
    }
    const malformed = { ...start, argsRaw: 'invalid raw\nsecond line' } as unknown as NonNullable<Parameters<typeof ImageGenerateToolview>[0]['block']>
    assert.match(renderToStaticMarkup(createElement(Component, { block: malformed })), /invalid raw/)
  }
})

test('actual account label hides only the email domain without changing identity', () => {
  assert.equal(actualAccountLabel('user.name+tag@example.com'), 'user.name+tag')
  assert.equal(actualAccountLabel('plain-handle'), 'plain-handle')
})

test('all badge reads follow the session owner without local fallback or writes', async () => {
  const calls: unknown[][] = []
  const ownerData = { providers: {}, supported: true }
  const raw = { call: async (...args: unknown[]) => { calls.push(args); return { ok: true, value: ownerData } } } as ConnectionHandle['rpc']
  const id = 'rh1.bGFwdG9w.c2Vzc2lvbi1vd25lcg'
  const rpc = createSessionSubscriptionsRpc(raw, id)
  const signal = new AbortController().signal
  for (const read of ['status', 'usage', 'sessionAccount']) {
    const payload = { provider: 'codex', model: 'm', account: 'owner-account', sessionId: 'wrong' }
    const value = await callSubscriptionsAuth<Record<string, unknown>>(rpc, read, payload)
    assert.deepEqual({ ...value, receivedAt: undefined }, { ...ownerData, receivedAt: undefined })
    const [channel, endpoint, translated] = calls.at(-1)!
    assert.equal(channel, '/api'); assert.equal(endpoint, 'subscriptions-auth.sessionAccount')
    assert.deepEqual(translated, { ...payload, sessionId: id, ...(read === 'sessionAccount' ? {} : { read }) })
  }
  await callSubscriptionsAuth(rpc, 'antigravityQuota', { model: 'gemini-4-argon' })
  assert.equal(calls.at(-1)![1], 'subscriptions-auth.sessionAccount')
  assert.deepEqual(calls.at(-1)![2], { model: 'gemini-4-argon', sessionId: id, read: 'antigravityQuota' })
  await rpc.call('/api', 'subscriptions-auth.status', {}, signal)
  const bounded = calls.at(-1)![3] as AbortSignal
  assert.equal(bounded.aborted, false)
  const lifetime = new AbortController()
  const scoped = createSessionSubscriptionsRpc(raw, id, lifetime.signal)
  await scoped.call('/api', 'subscriptions-auth.status', {})
  const scopedSignal = calls.at(-1)![3] as AbortSignal
  lifetime.abort()
  assert.equal(scopedSignal.aborted, true)
  assert.throws(() => scoped.call('/api', 'subscriptions-auth.status', {}), /abort/i)
  assert.throws(() => rpc.call('/api', 'subscriptions-auth.logout', {}), /only supports badge reads/)
  const offline = createSessionSubscriptionsRpc({ call: async () => { throw new Error('owner offline') } }, id)
  await assert.rejects(callSubscriptionsAuth(offline, 'status', {}), /owner offline/)
  assert.equal(calls.length, 6, 'no retry through the local machine')
})

const windows: UsageWindow[] = Array.from({ length: 60 }, (_, i) => ({
  kind: 'other', scope: `gemini-model-${i}`, usedPercent: i,
}))
function display(provider: ProviderUsageDisplay['provider'] = 'antigravity', values = windows): ProviderUsageDisplay {
  return { provider, name: provider === 'antigravity' ? 'Antigravity' : 'Codex', accounts: [
    { key: 'default', isDefault: true, windows: values },
  ] }
}

test('Codex exhaustion notice renders localized credits and reset guidance only for all displayed exhausted accounts', () => {
  const d = display('codex', [{ kind: 'weekly', usedPercent: 100 }])
  d.accounts.push({ key: 'second', isDefault: false, windows: [{ kind: 'session', usedPercent: 105 }] })
  for (const dictionary of [en, zh]) {
    const translate = (key: keyof typeof en) => dictionary[key]
    const render = () => renderToStaticMarkup(createElement(CodexExhaustionNotice, { display: d, translate }))
    assert.match(render(), /role="status"/)
    assert.ok(render().includes(dictionary.usageBadgeAllCodexExhausted))
    d.accounts[0]!.usage = { supported: true, credits: { hasCredits: true, unlimited: false, balance: '12.5' } }
    assert.ok(render().includes(dictionary.usageBadgeCodexCreditsFallback))
    assert.ok(!render().includes(dictionary.usageBadgeAllCodexExhausted))
    d.accounts[0]!.usage = { supported: true, credits: { hasCredits: true, unlimited: false, balance: '0' } }
    assert.ok(render().includes(dictionary.usageBadgeAllCodexExhausted))
    delete d.accounts[0]!.usage
    d.accounts[1]!.windows[0]!.usedPercent = 99.99
    assert.equal(render(), '', 'do not treat rounded 100% as exhaustion')
    d.accounts[1]!.windows[0]!.usedPercent = Infinity
    assert.equal(render(), '', 'non-finite telemetry is unknown, not exhaustion')
    d.accounts[1]!.windows = []
    assert.equal(render(), '', 'unknown usage is not known exhaustion')
    d.accounts[1]!.windows = [{ kind: 'session', usedPercent: 105 }]
  }
  assert.equal(renderToStaticMarkup(createElement(CodexExhaustionNotice, {
    display: display('claude', [{ kind: 'weekly', usedPercent: 100 }]), translate: key => en[key],
  })), '')
})

test('the compact readout drops window labels, freshness, overflow and credits', () => {
  const d = display('codex', [{ kind: 'session', usedPercent: 13 }, { kind: 'weekly', usedPercent: 25 }])
  d.accounts[0]!.usage = { supported: true, stale: true, fetchedAt: 1, credits: { hasCredits: true, unlimited: false, balance: '12.5' } }
  const label = compactSegment(d)
  assert.equal(label, 'Codex · 13% used / 25% used')
  assert.doesNotMatch(label, /Default account|Listed account|stale|credits|\+/)
  assert.ok(compactSegment(display('codex')).length < 40, 'a long catalogue never widens the pill')
})

test('compact summary counts signed-in accounts without aggregating their percentages', () => {
  const d = display('codex', [{ kind: 'session', usedPercent: 13 }, { kind: 'weekly', usedPercent: 25 }])
  d.accounts.unshift({ key: 'other', isDefault: false, windows: [{ kind: 'session', usedPercent: 99 }] })
  assert.equal(compactSegment(d), 'Codex · 2 signed-in accounts')
  assert.equal(compactSegment(display('codex', [
    { kind: 'session', usedPercent: 13 }, { kind: 'weekly', usedPercent: 25 }, { kind: 'weekly', usedPercent: 40 },
  ])), 'Codex · 13% used / 25% used', 'extra windows are counted in the dialog, never on the pill')
})

test('all reported windows stay visible, with current model first and unchanged source data', () => {
  const original = structuredClone(windows)
  const ordered = prioritizeWindows(windows, 'gemini-model-59')
  assert.equal(ordered[0]?.scope, 'gemini-model-59')
  assert.equal(new Set(ordered).size, 60)
  assert.deepEqual(windows, original)
  for (const dictionary of [en, zh]) {
    const translate = (key: keyof typeof en, params?: Record<string, unknown>) =>
      dictionary[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
    const html = renderToStaticMarkup(createElement(AccountWindows, { windows, model: 'gemini-model-59', translate, mode: 'used', now: 0 }))
    assert.equal((html.match(/role="progressbar"/g) ?? []).length, windows.length)
    assert.ok(!html.includes('<details'))
    assert.ok(html.indexOf('gemini-model-59') < html.indexOf('gemini-model-0'))
    assert.ok(!html.includes(` · ${translate('usageBadgeCurrent')}`))
  }
})

test('provider ordering stays independent from model-window filtering', () => {
  const all = [display('codex'), display()]
  assert.deepEqual(collapsedDisplays(all, 'antigravity'), [all[1]])
  assert.deepEqual(expandedDisplays(all, 'antigravity'), [all[1], all[0]])
  assert.deepEqual(collapsedDisplays(all, undefined), [])
  assert.deepEqual(collapsedDisplays(all, 'deepseek'), [])
  assert.deepEqual(collapsedDisplays(all, 'grok'), [])
})

test('a non-subscription model clears the badge instead of keeping the last subscription', () => {
  const codex = { provider: 'codex', model: 'gpt-test' }
  const anti = { provider: 'antigravity', model: 'gemini-model-59' }
  const api = { provider: 'deepseek', model: 'deepseek-chat' }
  assert.equal(retainSubscriptionSelection(undefined, api), undefined)
  assert.equal(retainSubscriptionSelection(undefined, undefined), undefined)
  assert.equal(retainSubscriptionSelection(undefined, codex), codex)
  assert.equal(retainSubscriptionSelection(codex, api), undefined, 'an API model drops the pill')
  assert.equal(retainSubscriptionSelection(codex, anti), anti)
  assert.equal(retainSubscriptionSelection(anti, api), undefined, 'switching away from a subscription drops the pill')
  assert.equal(retainSubscriptionSelection(anti, undefined), anti, 'an unreadable model keeps the pill instead of flickering')
  assert.deepEqual(collapsedDisplays([display('codex'), display()], retainSubscriptionSelection(anti, api)?.provider).map(d => d.provider), [])
  assert.deepEqual(collapsedDisplays([display('codex')], anti.provider), [])
  assert.deepEqual(collapsedDisplays([display('codex'), display('antigravity')], retainSubscriptionSelection(anti, undefined)?.provider).map(d => d.provider), ['antigravity'])
})

test('data icon supports both DSH export names without requiring either named import', () => {
  const modern = () => createElement('svg', { 'data-version': 'modern' })
  const legacy = () => createElement('svg', { 'data-version': 'legacy' })
  assert.equal(usageBadgeIcon({ IconDataOutlineRegular: modern, IconDataOutline16: legacy }), modern)
  assert.equal(usageBadgeIcon({ IconDataOutlineRegular: modern }), modern)
  assert.equal(usageBadgeIcon({ IconDataOutline16: legacy }), legacy)
  assert.match(renderToStaticMarkup(createElement(usageBadgeIcon({ IconDataOutlineRegular: modern }))), /data-version="modern"/)
  assert.equal(renderToStaticMarkup(createElement(usageBadgeIcon({}))), '')
})

test('model reader observes switches within the same provider and handles missing directories', async () => {
  let model = 'one'
  const read = createCurrentModelReader(() => ({ directoryFor: sessionId => {
    assert.equal(sessionId, 'session')
    return { load: async () => ({ current: { provider: 'antigravity', model } }) }
  } }), 'session')
  assert.deepEqual(await read(), { provider: 'antigravity', model: 'one' })
  model = 'two'
  assert.deepEqual(await read(), { provider: 'antigravity', model: 'two' })
  assert.equal(await createCurrentModelReader(() => undefined, 'session')(), undefined)
  assert.equal(await createCurrentModelReader(() => ({ directoryFor: () => ({ load: async () => ({ current: null }) }) }), 'session')(), undefined)
})

test('the compact readout keeps the percentage mode and unknown values, and leaves source detail to the dialog', () => {
  const d = display('claude', [{ kind: 'weekly', scope: 'Opus', usedPercent: 28 }])
  d.name = 'Claude'
  d.accounts[0]!.isDefault = false
  d.accounts[0]!.usage = { supported: true, stale: true, fetchedAt: 1 }
  assert.equal(compactSegment(d, undefined, undefined, 'remaining'), 'Claude · 72% remaining')
  d.accounts[0]!.windows[0]!.usedPercent = NaN
  assert.equal(compactSegment(d, undefined, undefined, 'remaining'), 'Claude · Unknown quota')
  assert.doesNotMatch(compactSegment(d, undefined, undefined, 'remaining'), /100%/)
  d.accounts.push({ key: 'unknown', isDefault: false, windows: [] })
  assert.match(compactSegment(d), /2 signed-in accounts/)
  assert.doesNotMatch(compactSegment(d), /%/)
})

test('session badge uses the observed account rather than the default and never guesses', () => {
  const d = display('codex', [{ kind: 'session', usedPercent: 13 }])
  d.accounts.push({ key: 'serving', account: 'serving@example.test', isDefault: false,
    windows: [{ kind: 'session', usedPercent: 71 }] })
  const account = { key: 'serving', label: 'serving@example.test', model: 'gpt-test', callId: 'call-1', startedAt: 1 }
  for (const state of ['active', 'last'] as const) {
    const selected = sessionAccountDisplay(d, { state, account })!
    assert.equal(compactSegment(selected), 'Codex · 71% used')
    assert.equal(selected.accounts[0]?.key, 'serving')
  }
  assert.equal(sessionAccountDisplay(d, { state: 'unknown' }), undefined)
  assert.equal(sessionAccountDisplay(d, undefined), undefined)
  assert.equal(sessionAccountDisplay(d, { state: 'last', account: { ...account, key: 'logged-out' } }), undefined)
  assert.equal(d.accounts.length, 2)
})
