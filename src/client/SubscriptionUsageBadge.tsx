// 变更追溯：CHG-20261124-152158-preview-parity-2fdd82c1；以用户确认的额度弹层样稿为准。
// 变更追溯：CHG-20261124-145318-quota-models-47c9e254；记录：.codex/doc/change-history/CHG-20261124-145318-quota-models-47c9e254.md
// 变更追溯：CHG-20261124-113809-agy-shell-c58464c9；记录：.codex/doc/change-history/CHG-20261124-113809-agy-shell-c58464c9.md
// 变更追溯：CHG-20261124-upstream-0914-b8023110；记录：.codex/doc/change-history/CHG-20261124-upstream-0914-b8023110.md
// 变更追溯：CHG-20261103-143200-subscription-account-audit-b8023110；记录：.codex/doc/change-history/CHG-20261103-143200-subscription-account-audit-b8023110.md
/**
 * Subscription usage badge: a stats pill in the composer's dock
 * (`conversation.composer.dock`), modelled on the host's own token-usage
 * pill. Collapsed, it shows the rate-limit windows of the provider behind the
 * session's CURRENT model (a GPT model → Codex usage, a Claude model → Claude
 * usage); clicking it opens a trigger-anchored dialog listing every logged-in
 * account of every provider, with all reported quota windows,
 * the current provider first and the default account (starred) first within
 * a provider. Model-scoped Antigravity usage follows the current model.
 *
 * Usage rides the `subscriptions-auth` `status` + `usage` endpoints on a slow
 * poll (the server shares its cache across UI surfaces); the current model
 * comes from ui-model-selection's `modelDirectories` service on a quicker
 * poll, since the host pushes nothing on a model switch. Renders nothing when
 * the selected provider has no logged-in accounts. Unknown quotas stay explicit.
 *
 * The collapsed pill reads the account observed on this session's generation
 * requests. Before a dispatch is observed it shows an unknown-account label;
 * the dialog continues to show all connected accounts.
 * Every color resolves through a `--dsw-*` design token and every
 * user-visible string goes through the locale `t` of the
 * 'settings.subscriptions' namespace.
 */
import { QuotaDetailNote, QuotaDetailRow, QuotaDetailTable } from './QuotaDetailTable.js'
import type { AntigravityQuota } from '../antigravity-bridge.js'
import { antigravityCompactQuota } from './AntigravityQuotaSummary.js'
import { AntigravityUsage, antigravityStatusText, useBridgeQuotaPrefetch, BRIDGE_QUOTA_INTERVAL } from './AntigravityUsage.js'
import { creditBalanceText, formatCreditBalance, quotaText, quotaUnavailableText, usageFreshnessText, useQuotaClock } from './quota-display.js'
import { readUsageCache, subscribeUsage, failUsage, publishUsage } from './usage-cache.js'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentType, CSSProperties } from 'react'
import { subscriptionChromeCss } from './provider-settings-styles.js'
import { createPortal } from 'react-dom'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { useBadgeDismiss } from './badge-popover.js'
import { useBadgePosition } from './use-badge-position.js'
import { callSubscriptionsAuth } from './SubscriptionsSection.js'
import type { AccountStatus, ProviderStatus, ProviderUsage, SubscriptionProvider, UsageWindow } from './SubscriptionsSection.js'
import type { ModelDirectoriesLike } from './SpeedSelect.js'
import { en } from './locales.js'
import type { SubscriptionsKey } from './locales.js'
import { hostIcon } from './host-icons.js'
import { useUsageBadgeMode, useQuotaDisplayMode, type QuotaDisplayMode } from './usage-badge-preferences.js'
import { DISPLAY_NAME_CHANGED, type DisplayNameChange } from './display-name-events.js'
import { createSessionSubscriptionsRpc } from './subscriptions-rpc.js'

/** DSH renamed the data icon in 0.1.7; retain older supported hosts too. */
export function usageBadgeIcon(icons: {
  IconDataOutlineRegular?: ComponentType
  IconDataOutline16?: ComponentType
}): ComponentType {
  return hostIcon(icons, 'DataOutline')
}
const UsageBadgeIcon = usageBadgeIcon(primitives)

/** How often the badge re-reads usage; the server also shares its own cache/negative-cache across UI surfaces. */
const USAGE_POLL_INTERVAL_MS = 15 * 60_000

/** How often the badge re-reads the session's current model (model switches arrive only by asking). */
const MODEL_POLL_INTERVAL_MS = 3000

/** Distance between the trigger's top edge and the dialog's bottom (host stat dialogs use the same). */
const PANEL_GAP = 8

/** Distance kept between the dialog and each viewport edge. */
const PANEL_MARGIN = 12

/** Injected dependencies (slot `inject`, session-bound). */
export interface SubscriptionUsageBadgeInjected {
  /** Connection RPC caller to reach the `subscriptions-auth` endpoints. */
  rpc: ConnectionHandle['rpc']
  sessionId: string
  /** Resolve the session's effective provider and model together. */
  currentModel: () => Promise<{ provider: string; model: string } | undefined>
}

/** Props delivered by the slot outlet + inject + the locale seat. */
export type SubscriptionUsageBadgeProps = PropsRuntime<'conversation.composer.dock'>
  & Partial<SubscriptionUsageBadgeInjected>
  & Partial<PropsLocale<'settings.subscriptions'>>

/** One logged-in account's usage windows, as listed in the expanded dialog. */
export interface AccountUsageDisplay {
  /** Account key (the `usage` endpoint's `account` argument). */
  key: string
  /** Display handle (email / login), when the provider reports one. */
  account?: string
  plan?: string
  /** Configured default, not evidence of which account served a request. */
  isDefault: boolean
  windows: UsageWindow[]
  usage?: ProviderUsage
  loadFailed?: boolean
}

/** Every signed-in account, including those with unknown quota. */
export interface ProviderUsageDisplay {
  provider: SubscriptionProvider
  name: string
  /** Default account first, then the rest in the `status` endpoint's order. */
  accounts: AccountUsageDisplay[]
}

/** Display-only warning; does not infer model eligibility or uncached accounts. */
function accountWindowExhausted(account: AccountUsageDisplay): boolean {
  return account.windows.some(window =>
    window.scope === undefined && Number.isFinite(window.usedPercent) && window.usedPercent >= 100)
}

/** True when the displayed snapshot still has spendable Codex credits. */
export function accountHasSpendableCredits(account: AccountUsageDisplay): boolean {
  const credits = account.usage?.credits
  if (credits === undefined || credits.overageLimitReached === true) return false
  if (credits.unlimited) return true
  if (credits.balance !== undefined) {
    const balance = Number(credits.balance)
    return Number.isFinite(balance) && balance > 0
  }
  return credits.hasCredits
}

export function CodexExhaustionNotice({ display, translate }: {
  display: ProviderUsageDisplay
  translate: (key: SubscriptionsKey) => string
}) {
  if (display.provider !== 'codex' || display.accounts.length === 0
    || !display.accounts.every(accountWindowExhausted)) return null
  const key = display.accounts.some(accountHasSpendableCredits)
    ? 'usageBadgeCodexCreditsFallback'
    : 'usageBadgeAllCodexExhausted'
  return <p role="status">{translate(key)}</p>
}

/** The account the collapsed pill reads: the default one, else the first listed. */
export function pillAccountOf(d: ProviderUsageDisplay): AccountUsageDisplay {
  return d.accounts.find(a => a.isDefault) ?? d.accounts[0]!
}

/** The host reports only accounts observed on real generation requests. */
export interface SessionAccountState {
  state: 'active' | 'last' | 'unknown'
  account?: { key: string; label?: string; model: string; callId: string; startedAt: number }
}

/** Display only: preserve provider identities and audit labels unchanged. */
export function actualAccountLabel(label: string): string {
  return label.replace(/@[^\s@]+$/, '')
}

/** Never substitute the default account for an unknown session account. */
export function sessionAccountDisplay(
  display: ProviderUsageDisplay | undefined,
  state: SessionAccountState | undefined,
): ProviderUsageDisplay | undefined {
  if (!display || !state?.account || state.state === 'unknown') return undefined
  const account = display.accounts.find(row => row.key === state.account!.key)
  return account ? { ...display, accounts: [account] } : undefined
}

/** Brand display names (short form for the compact badge). */
const PROVIDER_NAMES: Record<SubscriptionProvider, string> = {
  codex: 'Codex',
  claude: 'Claude',
  grok: 'Grok',
  copilot: 'Copilot',
  antigravity: 'Antigravity',
}

/**
 * The `currentModel` half of the inject face: the session's effective
 * model selection through ui-model-selection's `modelDirectories` service,
 * resolved lazily per call (the service may register after this plugin, and
 * a shell without it reports "unknown"; an unknown model keeps whatever
 * subscription this view already showed, while a model that is known and is
 * not a subscription hides the badge).
 */
export function createCurrentModelReader(
  models: () => ModelDirectoriesLike | undefined,
  sessionId: string,
): SubscriptionUsageBadgeInjected['currentModel'] {
  return async () => {
    const directories = models()
    if (directories === undefined) return undefined
    const { current } = await directories.directoryFor(sessionId).load()
    return current ?? undefined
  }
}

/** Keep model quotas separate: matching percentages do not imply a shared pool. */
export function prioritizeWindows(windows: readonly UsageWindow[], model?: string): UsageWindow[] {
  return model === undefined ? [...windows] : [
    ...windows.filter(w => w.scope === model),
    ...windows.filter(w => w.scope !== model),
  ]
}

/**
 * Order the pill's percentages by how soon they bind: the rolling session
 * window first, then the weekly window, then anything else. Catalog order holds
 * within a rank.
 */
function compactWindows(windows: readonly UsageWindow[]): UsageWindow[] {
  const rank = (w: UsageWindow): number => w.kind === 'session' ? 0 : w.kind === 'weekly' ? 1 : 2
  return [...windows].sort((a, b) => rank(a) - rank(b))
}

/** At most two percentages, session window first; the rest of the readout lives in the dialog. */
function compactPercentages(windows: readonly UsageWindow[], t: Translate, mode: QuotaDisplayMode): string {
  return compactWindows(windows).slice(0, 2).map(w => quotaText(w.usedPercent, mode, t)).join(' / ')
}

/**
 * Bounded readout; Antigravity quotas belong to individual models, not the
 * account. The composer stats row is narrow, so the pill carries only the
 * provider name and at most two percentages ("Gemini · 13% used / 15% used"):
 * the default/listed source, the window labels, the freshness note and the
 * remaining windows are all one click away in the dialog.
 */
export function compactSegment(d: ProviderUsageDisplay, _model?: string, t: Translate = fallbackTranslate, mode: QuotaDisplayMode = 'used'): string {
  if (d.accounts.length > 1) return `${d.name} · ${t('quotaSignedIn', { count: d.accounts.length })}`
  const account = pillAccountOf(d)
  if (!account) return `${d.name} · ${t('quotaUnknown')}`
  const windows = account.windows
  if (windows.length === 0) return `${d.name} · ${quotaUnavailableText(account.usage, account.loadFailed === true, t) ?? t('usageNoVisibleModels')}`
  return `${d.name} · ${compactPercentages(windows, t, mode)}`
}

type ModelSelection = { provider: string; model: string }

/**
 * Remember the most recent subscription in this view, including its model
 * scope, and drop it as soon as the session settles on a provider that is not
 * a subscription: a pill naming a provider the session stopped using is noise,
 * not history. An unknown current model (the shell may not report one yet)
 * keeps the last known selection so the pill does not flicker between polls.
 */
export function retainSubscriptionSelection(
  previous: ModelSelection | undefined,
  current: ModelSelection | undefined,
): ModelSelection | undefined {
  if (current === undefined) return previous
  return Object.hasOwn(PROVIDER_NAMES, current.provider) ? current : undefined
}

/** At most one provider; no known selection or no usage means no badge. */
export function collapsedDisplays(
  displays: readonly ProviderUsageDisplay[],
  current: string | undefined,
): readonly ProviderUsageDisplay[] {
  const match = displays.find(d => d.provider === current)
  return match === undefined ? [] : [match]
}

/** Order for the expanded dialog: the current provider first, the rest in poll order. */
export function expandedDisplays(
  displays: readonly ProviderUsageDisplay[],
  current: string | undefined,
): readonly ProviderUsageDisplay[] {
  const match = displays.find(d => d.provider === current)
  return match === undefined ? displays : [match, ...displays.filter(d => d !== match)]
}

/**
 * A provider's logged-in accounts, configured default first. Do not invent a
 * default flag when the server does not report one.
 */
function accountsOf(status: ProviderStatus | undefined): AccountStatus[] {
  if (status === undefined || status.accounts.length === 0) return []
  return [...status.accounts]
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
}

/** English-dictionary fallback for a missing inject `t` (standalone renders). */
function fallbackTranslate(key: SubscriptionsKey, params?: Record<string, unknown>): string {
  return en[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''))
}

type Translate = (key: SubscriptionsKey, params?: Record<string, unknown>) => string

/** Localized label of one usage window (kind, plus the model scope when named). */
function usageWindowLabel(t: Translate, window: UsageWindow): string {
  const base = window.kind === 'session'
    ? t('usageSession')
    : window.kind === 'weekly' ? t('usageWeekly') : t('usageWindow')
  return window.scope !== undefined && window.scope !== '' ? `${base} · ${window.scope}` : base
}

/**
 * The composer subscription-usage badge: a pill reading e.g. `Codex · 13% used / 25% used`
 * for the current model's provider, opening a dialog with every provider's
 * accounts and their windows, including unavailable telemetry.
 */
export function SubscriptionUsageBadge(props: SubscriptionUsageBadgeProps) {
  // Remount per owner/session so cached identities and late reads never cross hosts.
  return <SessionSubscriptionUsageBadge key={props.sessionId} {...props} />
}

function SessionSubscriptionUsageBadge({ rpc: connectionRpc, sessionId, currentModel, t }: SubscriptionUsageBadgeProps) {
  const [rpc, setRpc] = useState<ConnectionHandle['rpc']>()
  const activeRpc = useRef<ConnectionHandle['rpc']>()
  const translate: Translate = t ?? fallbackTranslate
  const [displays, setDisplays] = useState<ProviderUsageDisplay[]>([])
  const [selection, setSelection] = useState<ModelSelection | undefined>(undefined)
  const [lastSubscription, setLastSubscription] = useState<ModelSelection | undefined>(undefined)
  const [observed, setObserved] = useState<{ sessionId: string; selection: ModelSelection; value: SessionAccountState }>()
  const [bridgeRead, setBridgeRead] = useState<{ rpc: ConnectionHandle['rpc']; model: string; quota?: AntigravityQuota; failed: boolean }>()
  const [sessionQuota, setSessionQuota] = useState<{ provider: string; key: string; usage: ProviderUsage }>()
  const sessionQuotaCache = useRef(new Map<string, { at: number; usage: ProviderUsage }>())
  const displayMode = useUsageBadgeMode()
  const quotaMode = useQuotaDisplayMode()
  const quotaNow = useQuotaClock()
  useEffect(() => {
    if (!connectionRpc || !sessionId || displayMode === 'hidden') { setRpc(undefined); return }
    const lifetime = new AbortController()
    const next = createSessionSubscriptionsRpc(connectionRpc, sessionId, lifetime.signal)
    activeRpc.current = next
    setRpc(next)
    return () => { activeRpc.current = undefined; lifetime.abort() }
  }, [connectionRpc, sessionId, displayMode])
  const current = selection?.provider
  const badgeSelection = retainSubscriptionSelection(lastSubscription, selection)
  const [open, setOpen] = useState(false)
  // 变更追溯：CHG-20261124-154130-quota-prefetch-d570c33d。预读与弹层开关无关。
  const bridgeSnapshot = useBridgeQuotaPrefetch(displayMode !== 'hidden' && badgeSelection ? rpc : undefined)
  const bridge = bridgeSnapshot?.status
  const bridgeError = bridgeSnapshot?.error
  const [hover, setHover] = useState(false)
  const requestState = useMemo(() => ({ inflight: false, failed: false, cacheSync: false }), [rpc])
  const mountedRef = useRef(true)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  // Always-rendered, invisible marker in the dock: locates the composer bar
  // (and the host stats row inside it) even while the pill itself is portaled.
  const seatRef = useRef<HTMLSpanElement | null>(null)
  // The inject face may be re-evaluated (new callback identities) on
  // re-render; the model poll mounts once and reads through this ref.
  const currentRef = useRef(currentModel)
  currentRef.current = currentModel
  // Last-known usage and freshness per account (keyed `provider:accountKey`), kept
  // across a failed poll (e.g. a 429 during the server's own negative-cache
  // cooldown) so a row doesn't flicker away — it only disappears once the
  // account logs out. A successful unsupported response replaces old windows.
  const lastKnownRef = useRef(new Map<string, ProviderUsage>())
  const failedAccountsRef = useRef(new Set<string>())
  const namesRevision = useRef(0)
  const recentNames = useRef(new Map<SubscriptionProvider, { revision: number; name: string }>())

  const statusRef = useRef<{ providers: Record<SubscriptionProvider, ProviderStatus> }>()
  const refresh = useCallback(async (cacheOnly = false): Promise<void> => {
    if (!rpc || activeRpc.current !== rpc) return
    if (requestState.inflight) { if (cacheOnly) requestState.cacheSync = true; return }
    requestState.inflight = true
    const revision = namesRevision.current
    if (!cacheOnly) requestState.failed = false
    try {
      const statusResp = cacheOnly ? statusRef.current : await callSubscriptionsAuth<{
        providers: Record<SubscriptionProvider, ProviderStatus>
      }>(rpc, 'status', {})
      if (!statusResp || !mountedRef.current || activeRpc.current !== rpc) return
      statusRef.current = statusResp

      // Every logged-in account of every provider, in a stable order (the
      // `status` provider order, default account first) so rows don't jump
      // around as polls settle at different times.
      const roster: { provider: SubscriptionProvider; account: AccountStatus }[] = []
      for (const provider of Object.keys(statusResp.providers) as SubscriptionProvider[]) {
        if (provider === 'antigravity') continue
        for (const account of accountsOf(statusResp.providers[provider])) roster.push({ provider, account })
      }
      const keyOf = (provider: SubscriptionProvider, account: AccountStatus): string => `${provider}:${account.key}`

      const lastKnown = lastKnownRef.current
      const failedAccounts = failedAccountsRef.current
      // Drop last-known state for anything no longer logged in — that is a
      // real signal, unlike a fetch failure.
      const live = new Set(roster.map(({ provider, account }) => keyOf(provider, account)))
      for (const key of failedAccounts) if (!live.has(key)) failedAccounts.delete(key)
      for (const key of lastKnown.keys()) {
        if (!live.has(key)) lastKnown.delete(key)
      }

      if (roster.length === 0) {
        setDisplays([])
        return
      }

      const results = await Promise.allSettled(
        roster.map(async ({ provider, account }) => {
          const usage = cacheOnly ? readUsageCache(rpc, keyOf(provider, account))
            : await callSubscriptionsAuth<ProviderUsage>(rpc, 'usage', { provider, account: account.key })
          if (!usage) throw new Error('No cached quota')
          return { provider, account, usage }
        }),
      )
      if (!mountedRef.current || activeRpc.current !== rpc) return
      if (!cacheOnly) requestState.failed = results.some(result => result.status === 'rejected')

      for (const [index, result] of results.entries()) {
        const { provider, account } = roster[index]!
        const key = keyOf(provider, account)
        if (result.status === 'fulfilled') {
          lastKnown.set(key, result.value.usage)
          failedAccounts.delete(key)
        } else {
          if (!cacheOnly) failedAccounts.add(key)
          const previous = lastKnown.get(key)
          if (previous) lastKnown.set(key, { ...previous, stale: true, refreshFailed: true })
        }
      }

      const byProvider = new Map<SubscriptionProvider, ProviderUsageDisplay>()
      for (const { provider, account } of roster) {
        const key = keyOf(provider, account)
        const usage = lastKnown.get(key)
        const windows = usage?.windows ?? []
        const plan = usage?.plan ?? account.plan
        const row: AccountUsageDisplay = {
          key: account.key,
          loadFailed: failedAccounts.has(key),
          ...usage === undefined ? {} : { usage },
          isDefault: account.isDefault,
          ...account.account === undefined ? {} : { account: account.account },
          ...plan === undefined ? {} : { plan },
          // Filter only the display row, not lastKnown: restoring visibility
          // must also work when the next usage request fails and uses the cache.
          windows,
        }
        const display = byProvider.get(provider)
        if (display === undefined) byProvider.set(provider, { provider, name: statusResp.providers[provider]?.displayName || PROVIDER_NAMES[provider], accounts: [row] })
        else display.accounts.push(row)
      }
      // A save during a slow quota poll wins over that poll's old status snapshot.
      setDisplays([...byProvider.values()].map(row => {
        const saved = recentNames.current.get(row.provider)
        return saved && saved.revision > revision ? { ...row, name: saved.name } : row
      }))
    } catch {
      requestState.failed = true
      if (activeRpc.current !== rpc) return
      for (const key of lastKnownRef.current.keys()) failUsage(rpc, key)
      // A failed status read retains values but must not present them as fresh.
      if (mountedRef.current) setDisplays(previous => previous.map(display => ({ ...display,
        accounts: display.accounts.map(account => ({ ...account,
          ...(account.usage ? { usage: { ...account.usage, stale: true, refreshFailed: true } } : {}),
        })),
      })))
    } finally {
      requestState.inflight = false
      if (requestState.cacheSync && mountedRef.current && activeRpc.current === rpc) {
        requestState.cacheSync = false
        queueMicrotask(() => { void refresh(true) })
      }
    }
  }, [rpc, requestState])

  useEffect(() => {
    if (!rpc || displayMode === 'hidden') return
    const sync = () => { void refresh(true) }
    const unsubscribe = subscribeUsage(rpc, sync)
    // Local settings may publish on the original connection; never bridge remote-owner caches.
    const unsubscribeSettings = !sessionId?.startsWith('rh1.') && connectionRpc
      ? subscribeUsage(connectionRpc, (key, usage) => { publishUsage(rpc, key, usage) }) : undefined
    window.addEventListener('focus', sync)
    return () => { unsubscribe(); unsubscribeSettings?.(); window.removeEventListener('focus', sync) }
  }, [rpc, connectionRpc, sessionId, displayMode, refresh])

  useEffect(() => {
    // Settings events carry no host identity; qualified sessions read owner names via RPC.
    if (sessionId?.startsWith('rh1.')) return
    const update = (event: Event) => {
      const { provider, displayName } = (event as CustomEvent<DisplayNameChange>).detail
      recentNames.current.set(provider, { revision: ++namesRevision.current, name: displayName || PROVIDER_NAMES[provider] })
      setDisplays(current => current.map(row => row.provider === provider
        ? { ...row, name: displayName || PROVIDER_NAMES[provider] } : row))
    }
    window.addEventListener(DISPLAY_NAME_CHANGED, update)
    return () => { window.removeEventListener(DISPLAY_NAME_CHANGED, update) }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // Hidden renders nothing, so it polls nothing; showing it again refreshes at once.
  useEffect(() => {
    if (displayMode === 'hidden' || !rpc) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      await refresh()
      if (!stopped) timer = setTimeout(() => { void poll() }, requestState.failed ? 10_000 : USAGE_POLL_INTERVAL_MS)
    }
    void poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, [refresh, displayMode, rpc, requestState])

  // Refresh the observed account independently from the slow all-account quota poll.
  // A late result from the previous model cannot be attached to a new model.
  useEffect(() => {
    if (currentRef.current === undefined) return
    let cancelled = false
    let inflight = false
    let lastSelection: ModelSelection | undefined
    const reload = async (): Promise<void> => {
      const read = currentRef.current
      if (read === undefined || inflight) return
      inflight = true
      try {
        const model = await read()
        if (cancelled) return
        lastSelection = retainSubscriptionSelection(lastSelection, model)
        setLastSubscription(lastSelection)
        setSelection(model)
        if (displayMode === 'hidden' || !rpc || !sessionId || !lastSelection) {
          setObserved(undefined)
          setSessionQuota(undefined)
          return
        }
        const target = lastSelection
        if (target.provider === 'antigravity') return
        const value = await callSubscriptionsAuth<SessionAccountState>(rpc, 'sessionAccount', {
          sessionId, provider: target.provider, model: target.model,
        })
        if (cancelled) return
        setObserved({ sessionId, selection: target, value })
        if (!value.account || value.state === 'unknown') {
          setSessionQuota(undefined)
          return
        }
        const account = value.account
        try {
          // Account identity follows dispatches every tick; quota snapshots stay
          // bounded to five minutes even when server-side pooling is disabled.
          const key = `${target.provider}:${account.key}`
          const cached = sessionQuotaCache.current.get(key)
          const usage = cached && Date.now() - cached.at < 5 * 60_000 ? cached.usage
            : await callSubscriptionsAuth<ProviderUsage>(rpc, 'usage', {
              provider: target.provider, account: account.key,
            })
          if (!cached || cached.usage !== usage) sessionQuotaCache.current.set(key, { at: Date.now(), usage })
          if (!cancelled) setSessionQuota({ provider: target.provider, key: account.key, usage })
        } catch {
          if (!cancelled) setSessionQuota(previous => previous?.provider === target.provider
            && previous.key === account.key ? previous : undefined)
        }
      } catch {
        // Keep this session's last successful identity/quota during transport loss.
        // The next model tick retries; session remounts still clear all old state.
      } finally { inflight = false }
    }
    void reload()
    const timer = setInterval(() => { void reload() }, MODEL_POLL_INTERVAL_MS)
    return () => { cancelled = true; clearInterval(timer) }
  }, [rpc, sessionId, displayMode])

  const bridgeModel = badgeSelection?.provider === 'antigravity' ? badgeSelection.model : undefined
  useEffect(() => {
    setBridgeRead(undefined)
    if (!rpc || bridgeModel === undefined || displayMode === 'hidden') return
    const lifetime = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    let lastGood: AntigravityQuota | undefined
    const load = async () => {
      let failed = true
      try {
        const quota = await callSubscriptionsAuth<AntigravityQuota>(rpc, 'antigravityQuota', { model: bridgeModel }, lifetime.signal)
        if (quota.model === bridgeModel && quota.status === 'ok') { lastGood = quota; failed = false }
      } catch { /* Keep only this model's last successful snapshot. */ }
      if (lifetime.signal.aborted) return
      setBridgeRead({ rpc, model: bridgeModel, ...(lastGood === undefined ? {} : { quota: lastGood }), failed })
      timer = setTimeout(() => { void load() }, BRIDGE_QUOTA_INTERVAL)
    }
    void load()
    return () => { lifetime.abort(); clearTimeout(timer) }
  }, [rpc, bridgeModel, displayMode])

  const pos = useBadgePosition(open, rootRef, panelRef, PANEL_GAP, PANEL_MARGIN)
  useBadgeDismiss(rootRef, open, setOpen, panelRef)
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !(event.target instanceof Element && event.target.closest('dialog[open]'))) setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open])

  // Sit on the host's stats row when there is one. Every dock entry is its
  // own row in the composer bar, so a badge rendered in place lands under the
  // shipped time/token pills; the host marks its pill row with
  // `data-composer-stats`, and rendering into it makes the badge a third pill
  // on that line. The marker is watched (the row mounts only once the session
  // has steps or tokens, and unmounts with them) and older hosts without it
  // keep the in-place row.
  const [statsRow, setStatsRow] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const seat = seatRef.current
    if (seat === null) return
    const scope = statsScopeOf(seat)
    if (scope === null) return
    const find = (): HTMLElement | null => scope.querySelector<HTMLElement>('[data-composer-stats]')
    setStatsRow(find())
    const observer = new MutationObserver(() => { setStatsRow(find()) })
    observer.observe(scope, { childList: true, subtree: true })
    return () => { observer.disconnect() }
  }, [])

  const seat = <span ref={seatRef} style={styles.seat} aria-hidden />
  const collapsed = collapsedDisplays(displays, badgeSelection?.provider)
  const visible = displayMode !== 'hidden' && badgeSelection !== undefined
  useEffect(() => { if (!visible) setOpen(false) }, [visible])
  const bridgeName = bridge?.displayName || PROVIDER_NAMES.antigravity
  const providerName = (bridgeModel !== undefined ? bridgeName : collapsed[0]?.name) ?? (badgeSelection ? PROVIDER_NAMES[badgeSelection.provider as SubscriptionProvider] : undefined)
  if (!visible || providerName === undefined) return seat

  const sessionState = observed && observed.sessionId === sessionId && observed.selection.provider === badgeSelection?.provider
    && observed.selection.model === badgeSelection?.model ? observed.value : undefined
  const selectedAccount = sessionState?.state !== 'unknown' ? sessionState?.account : undefined
  const quota = selectedAccount && rpc
    ? readUsageCache(rpc, `${badgeSelection?.provider}:${selectedAccount.key}`)
      ?? (sessionQuota?.provider === badgeSelection?.provider && sessionQuota?.key === selectedAccount.key ? sessionQuota.usage : undefined)
    : undefined
  const recordedDisplay = sessionAccountDisplay(collapsed[0], sessionState)
  const actualDisplay: ProviderUsageDisplay | undefined = selectedAccount && quota?.supported && quota.windows?.length
    ? { provider: badgeSelection!.provider as SubscriptionProvider, name: providerName, accounts: [{
      key: selectedAccount.key, ...(selectedAccount.label === undefined ? {} : { account: selectedAccount.label }),
      isDefault: false, windows: quota.windows, usage: quota,
    }] }
    : recordedDisplay
  const accountLabel = selectedAccount ? actualAccountLabel(selectedAccount.label ?? selectedAccount.key) : undefined
  const accountState = translate(sessionState?.state === 'active' ? 'usageBadgeServing' : 'usageBadgeLastAccount')
  const currentBridgeRead = bridgeRead?.rpc === rpc && bridgeRead?.model === bridgeModel ? bridgeRead : undefined
  const label = bridgeModel !== undefined
    ? `${bridgeName} · ${antigravityCompactQuota(currentBridgeRead?.quota, bridgeModel, translate, quotaMode)}${currentBridgeRead?.failed && currentBridgeRead.quota ? ` · ${translate('quotaRefreshFailed')}` : ''}`
    : selectedAccount
    ? `${actualDisplay ? compactSegment(actualDisplay, selectedAccount.model, translate, quotaMode) : `${providerName} ${translate('usageBadgeModelUnavailable')}`} · ${accountLabel} · ${accountState}`
    : `${providerName} · ${translate('usageBadgeAccountUnknown')}`
  const expanded = expandedDisplays(displays, badgeSelection?.provider)
  const bridgeSection = rpc && (bridgeModel !== undefined || !!bridge?.accounts.length) ? (
    <tbody key="antigravity">
      <tr className="dsh-quota-provider"><th scope="rowgroup" colSpan={3}>
        {bridgeName}
      </th></tr>
      {!bridge?.accounts.length && <QuotaDetailNote>{antigravityStatusText(translate, bridge, bridgeError)}</QuotaDetailNote>}
      <AntigravityUsage rpc={rpc} status={bridge} error={bridgeError} t={translate} mode={quotaMode} detailNow={quotaNow} snapshots={bridgeSnapshot?.accounts} />
    </tbody>
  ) : null
  const title = translate('usageBadgeTitle')

  const toggle = (): void => {
    const next = !open
    setOpen(next)
    if (next) void refresh()
  }

  const pill = (
    <span ref={rootRef} style={styles.anchor}>
      <style>{subscriptionChromeCss}</style>
      <button
        type="button"
        className="dsh-subscription-usage-pill"
        style={{ ...styles.pill, ...(hover || open ? styles.pillActive : {}) }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${title} · ${label}`}
        title={title}
        onMouseEnter={() => { setHover(true) }}
        onMouseLeave={() => { setHover(false) }}
        onClick={toggle}
      >
        <UsageBadgeIcon />
        <span style={styles.label}>{label}</span>
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label={title}
          className="dsh-subscription-usage-panel"
          style={{ ...styles.panel, ...(pos ?? MEASURE_STYLE) }}
        >
          <div style={styles.title}>
            {translate('quotaDetailTitle')}
          </div>
          <QuotaDetailTable mode={quotaMode} t={translate}>
            {bridgeModel !== undefined && bridgeSection}
            {expanded.map(d => (
              <tbody key={d.provider}>
                <tr className="dsh-quota-provider"><th scope="rowgroup" colSpan={3}>
                  {d.name}
                </th></tr>
                {d.provider === 'codex' && d.accounts.length > 0 && d.accounts.every(accountWindowExhausted)
                  && <QuotaDetailNote><CodexExhaustionNotice display={d} translate={translate} /></QuotaDetailNote>}
                {d.accounts.map(account => {
                   const note = usageFreshnessText(account.usage, account.loadFailed === true, translate, quotaNow, true)
                   return (
                  <Fragment key={account.key}>
                    <tr className="dsh-quota-account"><td colSpan={3}>
                      <AccountMeta account={account} translate={translate} />
                      {d.provider === badgeSelection?.provider && account.key === selectedAccount?.key
                        && <span style={styles.currentTag}>{accountState}</span>}
                    </td></tr>
                    {note && <QuotaDetailNote>{note}</QuotaDetailNote>}
                    <AccountWindows windows={account.windows} model={d.provider === badgeSelection?.provider ? badgeSelection.model : undefined}
                      translate={translate} mode={quotaMode} now={quotaNow} />
                  </Fragment>
                )})}
              </tbody>
            ))}
            {bridgeModel === undefined && bridgeSection}
          </QuotaDetailTable>
        </div>,
        document.body,
      )}
    </span>
  )

  return (
    <>
      {seat}
      {statsRow !== null && statsRow.isConnected ? createPortal(pill, statsRow) : pill}
    </>
  )
}

/**
 * Nearest ancestor of the dock seat that can contain the host's stats row:
 * the composer bar. Bounded so a badge in an unfamiliar layout never adopts
 * some other composer's pills.
 */
function statsScopeOf(seat: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = seat.parentElement
  for (let depth = 0; node !== null && depth < 4; depth++) {
    if (node.querySelector('[data-composer-stats]') !== null) return node
    node = node.parentElement
  }
  return seat.parentElement
}

/** Preview uses a short account handle; retain the full identity on hover. */
function AccountMeta({ account, translate }: { account: AccountUsageDisplay; translate: Translate }) {
  const name = account.account || account.key
  const short = actualAccountLabel(name)
  const credits = account.usage?.credits
  const balance = credits?.balance !== undefined && !credits.unlimited && !credits.overageLimitReached
    ? translate('quotaDetailPoints', { balance: formatCreditBalance(credits.balance) }) : creditBalanceText(credits, translate)
  return <><span title={name}>{short.slice(0, 16)}{short !== name || short.length > 16 ? '…' : ''}</span>{balance && <small>{` · ${balance}`}</small>}</>
}

/** The current-model windows lead, without collapsing unrelated quota windows. */
export function AccountWindows({ windows, model, translate, mode, now }: {
  windows: readonly UsageWindow[]; model: string | undefined; translate: Translate; mode: QuotaDisplayMode; now: number
}) {
  return prioritizeWindows(windows, model).map((window, index) => (
    <QuotaDetailRow key={index} label={usageWindowLabel(translate, window)}
      used={window.usedPercent} resetsAt={window.resetsAt} mode={mode} now={now} t={translate} />
  ))
}

/**
 * Unplaced portal panel: hidden but laid out so the clamp measures real
 * dimensions before placement.
 */
const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

const styles: Record<string, CSSProperties> = {
  seat: { display: 'none' },
  anchor: { minWidth: 0, maxWidth: '100%', display: 'inline-flex' },
  // Mirrors the host StatsPills pill so the badge reads as a sibling of the
  // shipped time/token pills.
  pill: {
    boxSizing: 'border-box', maxWidth: '100%',
    color: 'var(--dsw-alias-label-tertiary)',
    font: 'inherit', fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
    fontVariantNumeric: 'tabular-nums', lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))', whiteSpace: 'nowrap',
    background: 'transparent', border: 'none', borderRadius: 999,
    alignItems: 'center', gap: 6, padding: '1px 8px', display: 'inline-flex', cursor: 'pointer',
  },
  pillActive: {
    background: 'var(--dsw-alias-interactive-bg-hover)',
    color: 'var(--dsw-alias-label-secondary)',
  },
  label: { textOverflow: 'ellipsis', minWidth: 0, overflow: 'hidden' },
  // Mirrors the host stat-dialog panel.
  panel: {
    position: 'fixed', zIndex: 1100, boxSizing: 'border-box',
    background: 'var(--dsw-specific-menu)',
    width: 'min(362px, 100vw - 24px)',
    maxHeight: 'min(560px, 100dvh - 24px)', overflowY: 'auto', overscrollBehavior: 'contain',
    boxShadow: 'var(--dsw-elevation-prominent)',
    color: 'var(--dsw-alias-label-secondary)', cursor: 'default',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, padding: '15px 14px 12px', font: '14px/1.45 system-ui, sans-serif',
  },
  title: {
    color: 'var(--dsw-alias-label-primary)', display: 'flex',
    justifyContent: 'space-between', gap: 16, marginBottom: 12, fontSize: 16, fontWeight: 700,
  },
  titleLabel: { alignItems: 'center', gap: 6, minWidth: 0, display: 'inline-flex' },
  currentTag: {
    fontSize: 10, lineHeight: '14px', fontWeight: 400, padding: '1px 4px', borderRadius: 3, marginLeft: 5,
    color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-interactive-bg-hover)',
  },
  defaultStar: { color: 'var(--dsw-alias-state-warn-label)' },
}
