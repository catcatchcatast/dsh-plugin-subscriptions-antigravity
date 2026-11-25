// 变更追溯：CHG-20261124-152158-preview-parity-2fdd82c1；以用户确认的额度弹层样稿为准。
// 变更追溯：CHG-20261124-145318-quota-models-47c9e254；记录：.codex/doc/change-history/CHG-20261124-145318-quota-models-47c9e254.md
import { useId, useRef } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { SubscriptionsKey } from './locales.js'
import { quotaPercent, quotaText } from './quota-display.js'
import type { QuotaDisplayMode } from './usage-badge-preferences.js'

type Translate = (key: SubscriptionsKey, params?: Record<string, unknown>) => string

export function QuotaDetailTable({ children, mode, t }: { children: ReactNode; mode: QuotaDisplayMode; t: Translate }) {
  return <>
    <style>{css}</style>
    <table className="dsh-quota-detail">
      <colgroup><col style={{ width: '47%' }} /><col style={{ width: '20%' }} /><col /></colgroup>
      <thead><tr>
        <th scope="col">{t('quotaDetailItem')}</th>
        <th scope="col">{t(mode === 'used' ? 'quotaDetailUsed' : 'quotaRemaining')}</th>
        <th scope="col">{t('quotaDetailUntilReset')}</th>
      </tr></thead>
      {children}
    </table>
  </>
}

export function QuotaDetailNote({ children }: { children: ReactNode }) {
  return <tr className="dsh-quota-note"><td colSpan={3}>{children}</td></tr>
}

export function quotaResetCountdown(resetsAt: number, now: number, t: Translate): string {
  const total = Math.floor((resetsAt - now) / 60_000)
  const days = Math.floor(total / 1440)
  const hours = Math.floor(total / 60)
  if (total < 0 || resetsAt <= now) return t('quotaDetailResetPassed')
  if (days > 0) return t('quotaDetailDaysHours', { days, hours: hours % 24 })
  if (hours > 0) return total % 60 === 0 ? t('quotaDetailHours', { hours }) : t('quotaDetailHoursMinutes', { hours, minutes: total % 60 })
  if (total === 0) return t('quotaDetailUnderMinute')
  return t('quotaDetailMinutes', { minutes: total })
}

export function QuotaDetailRow({ label, used, resetsAt, inactive, mode, now, t }: {
  label: string; used: number; resetsAt?: number | undefined; inactive?: boolean | undefined; mode: QuotaDisplayMode; now: number; t: Translate
}) {
  const percent = inactive ? undefined : quotaPercent(used, mode)
  const level = used >= 95 ? 'high' : used >= 80 ? 'warn' : undefined
  return <tr className="dsh-quota-row">
    <th scope="row">{label}</th>
    <td>{percent === undefined
      ? <span className="dsh-quota-dash" title={t(inactive ? 'antigravityQuotaInactive' : 'quotaUnknown')}>{t(inactive ? 'antigravityQuotaInactive' : 'quotaUnknown')}</span>
      : <span className="dsh-quota-meter" data-level={level} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={percent} aria-valuetext={quotaText(used, mode, t)} style={{ '--quota-fill': `${percent}%` } as CSSProperties}>{percent}%</span>}
    </td>
    <td>{resetsAt !== undefined && Number.isFinite(resetsAt) && !inactive
      ? <ExactReset label={label} resetsAt={resetsAt} now={now} t={t} />
      : <span aria-label={t('quotaDetailResetUnknown')}>—</span>}
    </td>
  </tr>
}

function ExactReset({ label, resetsAt, now, t }: { label: string; resetsAt: number; now: number; t: Translate }) {
  const ref = useRef<HTMLDialogElement>(null)
  const id = useId()
  const date = new Date(resetsAt)
  const exact = date.toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' })
  const countdown = quotaResetCountdown(resetsAt, now, t)
  return <>
    <button type="button" className="dsh-quota-reset" title={`${label} · ${t('quotaDetailExactReset', { date: exact })}`}
      aria-label={`${countdown} · ${label} · ${t('quotaDetailExactReset', { date: exact })}`}
      aria-haspopup="dialog" aria-controls={id} onClick={() => ref.current?.showModal()}>{countdown}</button>
    <dialog id={id} ref={ref} className="dsh-quota-exact" aria-labelledby={`${id}-title`} aria-describedby={`${id}-time`}
      onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation() }}>
      <strong id={`${id}-title`}>{label}</strong>
      <p id={`${id}-time`}>{t('quotaDetailExactReset', { date: exact })}</p>
      {resetsAt <= now && <p>{t('quotaExpiredWindow')}</p>}
      <button type="button" autoFocus onClick={() => ref.current?.close()}>{t('quotaDetailClose')}</button>
    </dialog>
  </>
}

const css = `
body[data-ds-dark-theme] .dsh-subscription-usage-panel { --dsw-specific-menu: #262629; --dsw-alias-border-l2: #424245; --dsw-alias-label-primary: #ededee; --dsw-alias-label-secondary: #ededee; --dsw-alias-label-tertiary: #a9a9af; --dsw-elevation-prominent: 0 6px 18px #0003; backdrop-filter: none; }
body[data-ds-dark-theme] .dsh-quota-detail .dsh-quota-account td { color: #bcbcc2; }
body[data-ds-dark-theme] .dsh-quota-detail .dsh-quota-account small { color: #9c9ca4; }
body[data-ds-dark-theme] .dsh-quota-detail .dsh-quota-row td:last-child { color: #c0c0c5; }
.dsh-quota-detail { border-collapse: collapse; width: 100%; table-layout: fixed; font-variant-numeric: tabular-nums; }
.dsh-quota-detail :is(th, td) { text-align: left; padding: 3px 0; font-weight: normal; overflow-wrap: anywhere; }
.dsh-quota-detail :is(thead > tr, .dsh-quota-row) > :nth-child(2) { text-align: center; }
.dsh-quota-detail :is(thead > tr, .dsh-quota-row) > :nth-child(3) { text-align: right; }
.dsh-quota-detail thead th { font-size: 12px; padding-bottom: 7px; color: var(--dsw-alias-label-tertiary); }
.dsh-quota-detail .dsh-quota-provider th { border-top: 1px solid var(--dsw-alias-border-l2); padding-top: 9px; color: var(--dsw-alias-label-primary); font-weight: 680; }
.dsh-quota-detail tbody+tbody::before { display: table-row; content: ''; height: 7px; }
.dsh-quota-detail .dsh-quota-account td { font-size: 12px; padding-top: 7px; }
.dsh-quota-detail .dsh-quota-account small, .dsh-quota-detail .dsh-quota-note { color: var(--dsw-alias-label-tertiary); }
.dsh-quota-detail small { font: inherit; }
.dsh-quota-detail .dsh-quota-row th { padding-left: 8px; padding-right: 4px; }
.dsh-quota-note :is(p, div[role=status]) { margin: 0; }
.dsh-quota-meter { display: block; line-height: 18px; font-size: 12px; font-weight: 600; position: relative; isolation: isolate; color: var(--dsw-alias-label-primary); }
.dsh-quota-meter::before,.dsh-quota-meter::after { content: ''; position: absolute; left: 0; top: 50%; transform: translateY(-50%); height: 9px; border-radius: 99px; pointer-events: none; }
.dsh-quota-meter::before { z-index: -2; width: 100%; background: linear-gradient(#e4e6df,#c6c9bc); box-shadow: inset 0 1px 2px #24282033, 0 1px 0 #ffffff12; }
.dsh-quota-meter::after { z-index: -1; width: var(--quota-fill); background: repeating-linear-gradient(120deg,transparent 0 3px,#ffffff18 3px 4px),linear-gradient(var(--quota-gradient,#d9eb9c,#a8ca5d 43%,#86ad44)); box-shadow: inset 0 1px 0 #ffffff61,inset 0 -1px 0 #24282044; }
.dsh-quota-meter[data-level=warn] { --quota-gradient: #ffe0a0,#e9b054 43%,#bd7e39; }
.dsh-quota-meter[data-level=high] { --quota-gradient: #ffc0b2,#ec826b 43%,#b65243; }
body[data-ds-dark-theme] .dsh-quota-meter { color: #fff; text-shadow: 0 1px 2px #111,0 0 2px #232620; }
body[data-ds-dark-theme] .dsh-quota-meter::before { background: linear-gradient(#31332f,#484a44); box-shadow: inset 0 1px 2px #181a17,0 1px 0 #ffffff12; }
.dsh-quota-dash { color: var(--dsw-alias-label-tertiary); }
.dsh-quota-detail .dsh-quota-reset, .dsh-quota-detail .dsh-quota-exact button { font: inherit; border: 0; background: transparent; color: inherit; padding: 0; cursor: pointer; text-decoration: underline dotted; text-underline-offset: 4px; }
.dsh-quota-detail .dsh-quota-reset:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, currentColor); outline-offset: 2px; }
.dsh-quota-detail .dsh-quota-exact { max-width: min(90vw, 380px); text-align: left; background: var(--dsw-specific-menu); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 15px; box-shadow: var(--dsw-elevation-prominent); }
.dsh-quota-detail .dsh-quota-exact button { float: right; }
`
