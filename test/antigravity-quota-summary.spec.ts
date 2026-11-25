// 变更追溯：CHG-20261124-113809-agy-shell-c58464c9；记录：.codex/doc/change-history/CHG-20261124-113809-agy-shell-c58464c9.md
import './css-hook.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AntigravityQuota, AntigravityQuotaGroup } from '../src/antigravity-bridge.js'
const { AntigravityQuotaSummary, antigravityCompactQuota } = await import('../src/client/AntigravityQuotaSummary.js')
import { en, zh } from '../src/client/locales.js'

const generic = { id: 'rolling', name: '', window: '5h', remainingFraction: 0.93, resetTime: '' }
const gemini = { name: 'Gemini Models', description: '', buckets: [generic, { ...generic, id: 'gemini-7d', window: '', remainingFraction: 0.73 }] }
const argon = { name: 'Custom bridge group', description: '', buckets: [
  { ...generic, id: 'explicit', window: 'Daily', remainingFraction: 0.15 }, { ...generic, disabled: true },
] }
const groups = [gemini, argon] satisfies AntigravityQuotaGroup[]
const model = 'gemini-4-argon'
const quota = { status: 'ok', updatedAt: '', groups, accountId: 'account-a', accountLabel: 'Bridge account A', model,
  focus: { model, family: 'gemini', entitled: true, group: gemini },
} satisfies AntigravityQuota
const translate = (dictionary: typeof en) => (key: keyof typeof en, params?: Record<string, unknown>) =>
  dictionary[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))

test('bridge groups preserve active, inactive and explicit windows across quota display modes', () => {
  for (const dictionary of [en, zh]) {
    const t = translate(dictionary)
    const used = renderToStaticMarkup(createElement(AntigravityQuotaSummary, { groups, t, mode: 'used' }))
    const remaining = renderToStaticMarkup(createElement(AntigravityQuotaSummary, { groups, t, mode: 'remaining' }))
    assert.ok(used.includes('Custom bridge group') && used.includes('Daily'))
    assert.ok(used.includes(dictionary.antigravityQuotaInactive))
    assert.ok(used.includes('height:4px') && !used.includes('<svg'))
    assert.ok(used.includes('var(--dsw-alias-state-warn-label)') && remaining.includes('var(--dsw-alias-state-warn-label)'))
    assert.equal((used.match(/role="progressbar"/g) ?? []).length, 3)
    for (const percent of [27, 7, 85]) assert.ok(used.includes(t('quotaUsedPercent', { percent })))
    for (const percent of [73, 93, 15]) assert.ok(remaining.includes(t('quotaRemainingPercent', { percent })))
  }
})

test('the compact pill trusts bridge focus and cannot borrow quota for another account or model', () => {
  const t = translate(en)
  assert.equal(antigravityCompactQuota(quota, model, t, 'used'), '27% used · 7% used · Bridge account A')
  assert.equal(antigravityCompactQuota(quota, model, t, 'remaining'), '73% remaining · 93% remaining · Bridge account A')
  assert.equal(antigravityCompactQuota({ ...quota, focus: { ...quota.focus, group: argon } }, model, t, 'used'), '85% used · Bridge account A')
  const { accountId: _, ...withoutAccount } = quota
  assert.equal(antigravityCompactQuota(withoutAccount, model, t, 'used'), en.usageBadgeModelUnavailable)
  assert.equal(antigravityCompactQuota(quota, 'gemini-flash', t, 'used'), en.usageBadgeModelUnavailable)
  assert.equal(antigravityCompactQuota({ ...quota, focus: { ...quota.focus, entitled: false } }, model, t, 'used'), en.usageBadgeModelUnavailable)
})
