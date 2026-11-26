// 变更追溯：CHG-20261126-152200-quota-epoch-92b178e0；零时间戳不表示额度到期。
// 变更追溯：CHG-20261124-152158-preview-parity-2fdd82c1；记录：.codex/doc/change-history/CHG-20261124-152158-preview-parity-2fdd82c1.md
// 变更追溯：CHG-20261124-145318-quota-models-47c9e254；记录：.codex/doc/change-history/CHG-20261124-145318-quota-models-47c9e254.md
// 变更追溯：CHG-20261124-113809-agy-shell-c58464c9；记录：.codex/doc/change-history/CHG-20261124-113809-agy-shell-c58464c9.md
import { useCallback, useEffect, useState } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { AntigravityQuota, AntigravityStatus } from '../antigravity-bridge.js'
import { antigravityResetTime, antigravityUsedPercent, antigravityWindowLabel, AntigravityQuotaSummary } from './AntigravityQuotaSummary.js'
import type { SubscriptionsKey } from './locales.js'
import { ProviderRefreshButton } from './ProviderRefreshButton.js'
import { QuotaDetailNote, QuotaDetailRow } from './QuotaDetailTable.js'
import { UsageFreshness } from './quota-display.js'
import { callSubscriptionsAuth } from './subscriptions-rpc.js'
import type { QuotaDisplayMode } from './usage-badge-preferences.js'

type Translate = (key: SubscriptionsKey, params?: Record<string, unknown>) => string
type Rpc = ConnectionHandle['rpc']
type QuotaGroup = AntigravityQuota['groups'][number]
type QuotaBucket = QuotaGroup['buckets'][number]

function detailPeriod(bucket: QuotaBucket): 'short' | 'weekly' | 'other' {
  const label = `${bucket.window} ${bucket.id} ${bucket.name}`
  if (/week|7d/i.test(label)) return 'weekly'
  if (/5[\s_-]*h|five[\s_-]*hour/i.test(label)) return 'short'
  return 'other'
}

function detailGroupName(group: QuotaGroup): string {
  if (group.kind === 'argon' || /argon/i.test(group.name)) return 'Gemini 4 Argon'
  if (group.kind === 'claude' || /claude|gpt|3p/i.test(group.name)) return 'Claude/GPT'
  if (/gemini/i.test(group.name)) return 'Gemini'
  return group.name
}

export function useAntigravityStatus(rpc: Rpc | undefined) {
  const [status, setStatus] = useState<AntigravityStatus>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (!rpc) return
    let current = true
    void callSubscriptionsAuth<AntigravityStatus>(rpc, 'antigravityStatus', {}).then(value => {
      if (current) { setStatus(value); setError(undefined) }
    }, (failure: Error) => { if (current) setError(failure.message) })
    return () => { current = false }
  }, [rpc])
  return { status, error }
}

// 变更追溯：CHG-20261124-154130-quota-prefetch-d570c33d；按属主连接预读，关闭弹层不丢失快照。
export const BRIDGE_QUOTA_INTERVAL = 5 * 60_000
interface AccountSnapshot { quota?: AntigravityQuota; error?: string; loading: boolean }
export function useBridgeQuotaPrefetch(rpc: Rpc | undefined) {
  const [result, setResult] = useState<{ rpc: Rpc; status?: AntigravityStatus; error?: string; accounts: Map<string, AccountSnapshot> }>()
  useEffect(() => {
    if (!rpc) return
    const owner = rpc
    const abort = new AbortController()
    const { signal } = abort
    let timer: ReturnType<typeof setTimeout>
    let status: AntigravityStatus | undefined
    let accounts = new Map<string, AccountSnapshot>()
    async function poll() {
      try {
        const next = await callSubscriptionsAuth<AntigravityStatus>(owner, 'antigravityStatus', {}, signal)
        if (signal.aborted) return
        status = next
        accounts = new Map(next.accounts.map(({ id }) => [id, accounts.get(id) ?? { loading: true }]))
        setResult({ rpc: owner, status: next, accounts: new Map(accounts) })
        await Promise.all(next.accounts.map(async ({ id }) => {
          try {
            const quota = await callSubscriptionsAuth<AntigravityQuota>(owner, 'antigravityQuota', { accountId: id }, signal)
            if (quota.status !== 'ok') throw new Error(quota.error ?? '')
            accounts.set(id, { quota, loading: false })
          } catch (error) {
            accounts.set(id, { ...accounts.get(id), loading: false, error: (error as Error).message })
          }
          if (!signal.aborted) setResult({ rpc: owner, status: next, accounts: new Map(accounts) })
        }))
      } catch (error) {
        if (!signal.aborted) setResult({ rpc: owner, ...(status && { status }), error: (error as Error).message, accounts: new Map(accounts) })
      } finally {
        if (!signal.aborted) timer = setTimeout(() => { void poll() }, BRIDGE_QUOTA_INTERVAL)
      }
    }
    void poll()
    return () => { abort.abort(); clearTimeout(timer) }
  }, [rpc])
  return result?.rpc === rpc ? result : undefined
}

export function antigravityStatusText(t: Translate, status: AntigravityStatus | undefined, error: string | undefined): string {
  if (error || status?.state === 'error') return t('antigravityStatusUnavailable')
  if (!status || status.state === 'starting') return t('checking')
  return status.accounts.length > 0
    ? t('antigravityStatusAccounts', { count: status.accounts.length })
    : t('antigravityStatusNoAccounts')
}

export function AntigravityUsage({ rpc, status, error, t, mode, refreshable, detailNow, snapshots }: {
  rpc: Rpc; status: AntigravityStatus | undefined; error: string | undefined; t: Translate; mode: QuotaDisplayMode; refreshable?: boolean; detailNow?: number; snapshots?: Map<string, AccountSnapshot> | undefined
}) {
  const failure = error || status?.error
  return <>
    {failure && (detailNow === undefined ? <p role="status">{t('usageError', { message: failure })}</p>
      : <QuotaDetailNote><p role="status">{t('usageError', { message: failure })}</p></QuotaDetailNote>)}
    {status?.accounts.map(account => {
      const label = account.label.trim()
      const placeholder = !label || label === 'This Mac'
      const duplicate = status.accounts.some(other => other.id !== account.id && other.label.trim() === label)
      const detail = detailNow === undefined ? undefined : { now: detailNow,
        label: placeholder ? (status.accounts.length === 1 ? undefined : account.id) : duplicate ? `${label} · ${account.id}` : label,
      }
      return <AntigravityAccountUsage key={account.id} rpc={rpc} account={account} t={t} mode={mode} refreshable={refreshable === true} detail={detail} snapshot={snapshots?.get(account.id)} />
    })}
  </>
}

function AntigravityAccountUsage({ rpc, account, t, mode, refreshable, detail, snapshot }: {
  rpc: Rpc; account: AntigravityStatus['accounts'][number]; t: Translate; mode: QuotaDisplayMode; refreshable: boolean; snapshot: AccountSnapshot | undefined; detail: { now: number; label: string | undefined } | undefined
}) {
  const [settingsQuota, setQuota] = useState<AntigravityQuota>()
  const [settingsError, setError] = useState<string>()
  const [settingsLoading, setLoading] = useState(true)
  const load = useCallback(async (force: boolean, isCurrent: () => boolean) => {
    setLoading(true)
    try {
      const result = await callSubscriptionsAuth<AntigravityQuota>(rpc, 'antigravityQuota', { accountId: account.id, ...(force ? { force } : {}) })
      if (!isCurrent()) return
      if (result.status === 'ok') { setQuota(result); setError(undefined) }
      else setError(result.error ?? '')
    } catch (failure) {
      if (isCurrent()) setError((failure as Error).message)
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [rpc, account.id])
  const isDetail = detail !== undefined
  useEffect(() => {
    let current = true
    if (!isDetail) void load(false, () => current)
    return () => { current = false }
  }, [load, isDetail])
  const quota = isDetail ? snapshot?.quota : settingsQuota
  const error = isDetail ? snapshot?.error : settingsError
  const loading = isDetail ? snapshot?.loading ?? true : settingsLoading
  const plan = quota?.subscriptionName ?? quota?.subscriptionTier ?? account.subscriptionName ?? account.subscriptionTier
  const fetchedAt = quota === undefined ? undefined : Date.parse(quota.updatedAt)
  const freshness = (!loading || quota) && <UsageFreshness t={t} compact={detail !== undefined} failed={error !== undefined} usage={quota && {
    supported: true, ...(fetchedAt === undefined ? {} : { fetchedAt }),
    windows: quota.groups.flatMap(group => group.buckets.filter(bucket => !bucket.disabled)
      .map(bucket => ({ kind: 'other' as const, usedPercent: antigravityUsedPercent(bucket) }))),
  }} />
  if (detail) return <>
    {detail.label ? <tr className="dsh-quota-account"><td colSpan={3}>
      {detail.label}{!account.enabled && <small>{` · ${t('antigravityAccountDisabled')}`}</small>}
    </td></tr> : !account.enabled && <QuotaDetailNote>{t('antigravityAccountDisabled')}</QuotaDetailNote>}
    {loading && !quota && <QuotaDetailNote>{t('usageLoading')}</QuotaDetailNote>}
    {(error || account.error) && <QuotaDetailNote><p role="status">{t('usageError', { message: error || account.error })}</p></QuotaDetailNote>}
    {(error !== undefined || (!loading && !quota?.groups.some(group => group.buckets.length))) && freshness
      && <QuotaDetailNote>{freshness}</QuotaDetailNote>}
    {quota?.groups.flatMap((group, groupIndex) => {
      const order = { short: 0, weekly: 1, other: 2 }
      return [...group.buckets].sort((a, b) => order[detailPeriod(a)] - order[detailPeriod(b)]).map(bucket => {
        const period = detailPeriod(bucket)
        const label = period === 'short' ? t('quotaDetailFiveHours') : period === 'weekly' ? t('usageWeekly') : antigravityWindowLabel(bucket, t)
        return <QuotaDetailRow key={`${groupIndex}:${bucket.id}`} label={`${detailGroupName(group)} · ${label}`}
          used={antigravityUsedPercent(bucket)} resetsAt={antigravityResetTime(bucket.resetTime)} inactive={bucket.disabled} mode={mode} now={detail.now} t={t} />
      })
    })}
  </>
  return <div style={{ marginTop: 12, borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 8 }}>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <strong>{account.label || account.id}</strong>
      {plan && <span>{t('usagePlan', { plan })}</span>}
      {!account.enabled && <span>{t('antigravityAccountDisabled')}</span>}
      {refreshable && <ProviderRefreshButton label={t('usageRefresh')} disabled={loading}
        onClick={() => { void load(true, () => true) }} />}
    </div>
    {loading && !quota && <p>{t('usageLoading')}</p>}
    {error !== undefined && error !== '' && <p role="status">{t('usageError', { message: error })}</p>}
    {freshness}
    {quota && <AntigravityQuotaSummary groups={quota.groups} t={t} mode={mode} />}
  </div>
}
