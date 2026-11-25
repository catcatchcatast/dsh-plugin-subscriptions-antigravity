// 变更追溯：CHG-20261124-113809-agy-shell-c58464c9；记录：.codex/doc/change-history/CHG-20261124-113809-agy-shell-c58464c9.md
import React from 'react'
import { createRoot } from 'react-dom/client'
import { SubscriptionsSection, type SubscriptionsSectionInjected } from '../src/client/SubscriptionsSection.js'

const calls: { endpoint: string; payload: unknown }[] = []
const group = { name: 'Gemini weekly pool', description: '', buckets: [
  { id: 'gemini-weekly', name: 'Weekly', window: 'weekly', remainingFraction: .67, resetTime: '' },
  { id: 'gemini-5h', name: '5-hour', window: '5h', remainingFraction: 0, resetTime: '', disabled: true },
] }
const rpc = { call: async (_channel, method, payload) => {
  const endpoint = method.split('.').at(-1)!
  calls.push({ endpoint, payload })
  document.documentElement.dataset.calls = JSON.stringify(calls)
  switch (endpoint) {
    case 'status': return { ok: true, value: { providers: Object.fromEntries(['codex', 'claude', 'grok', 'copilot', 'antigravity'].map(id => [id, {
      busy: false, accounts: id === 'antigravity' ? [{ key: 'legacy-account', isDefault: true }] : [],
    }])) } }
    case 'antigravityStatus': return { ok: true, value: { state: 'ready', displayName: 'Google Antigravity', accounts: location.search ? [] : [
      { id: 'bridge-account', label: 'Bridge account', enabled: true, state: 'ready' },
    ] } }
    case 'antigravityQuota': return { ok: true, value: { status: 'ok', updatedAt: new Date().toISOString(), subscriptionName: 'Google AI Pro', groups: [group] } }
    case 'proxyGet': return { ok: true, value: { enabled: false, url: '', bypass: [], passwordSet: false } }
    default: throw new Error(`Unexpected endpoint: ${endpoint}`)
  }
} } satisfies SubscriptionsSectionInjected['rpc']
createRoot(document.getElementById('root')!).render(<SubscriptionsSection rpc={rpc} />)
