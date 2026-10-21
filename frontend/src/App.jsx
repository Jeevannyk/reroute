import { useEffect, useState } from 'react'

const pad = (n) => String(n).padStart(2, '0')
const fmt = (m) => `D${Math.floor(m / 1440) + 1} ${pad(Math.floor((m % 1440) / 60))}:${pad(m % 60)}`
const rupees = (n) => '₹' + Number(n || 0).toLocaleString('en-IN')
const pct = (p) => Math.round(p * 100) + '%'

const PROBLEMS = [
  { label: 'Delay flight · 4h', body: { type: 'delay', booking_id: 'F1', delay_min: 240, at: 'D1T18:00' } },
  { label: 'Cancel flight', body: { type: 'cancel', booking_id: 'F1', at: 'D1T18:40' } },
  { label: 'Cancel train', body: { type: 'cancel', booking_id: 'T1', at: 'D1T18:00' } },
]

const STATUS_LABELS = {
  ok: 'On time',
  kept: 'On time',
  changed: 'Updated',
  new: 'New',
  held: 'Held',
  used: 'Used',
  at_risk: 'At risk',
  delayed: 'Delayed',
  broken: 'Broken',
  cancelled: 'Cancelled',
  dropped: 'To cancel',
}

const TYPE_LABELS = {
  flight: 'Flight',
  cab: 'Ground transfer',
  hotel: 'Hotel',
  train: 'Train',
  tour: 'Activity',
  bus: 'Bus',
}

async function api(path, body) {
  const options = body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }
  const res = await fetch('/api' + path, options)
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.json()
}

function Icon({ children, className = '' }) {
  return <span aria-hidden="true" className={`icon ${className}`}>{children}</span>
}

function StatusPill({ status }) {
  return <span className={`status-pill status-${status}`}>{STATUS_LABELS[status] || status.replaceAll('_', ' ')}</span>
}

function SectionHeading({ eyebrow, title, aside }) {
  return (
    <div className="section-heading">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h2>{title}</h2>
      </div>
      {aside && <div className="section-aside">{aside}</div>}
    </div>
  )
}

function BookingCard({ row, index }) {
  return (
    <article className={`booking-card booking-${row.status}`} style={{ '--item-index': index }}>
      <span className={`booking-marker marker-${row.status}`} aria-hidden="true">
        {row.type?.slice(0, 1)?.toUpperCase() || '•'}
      </span>
      <div className="booking-content">
        <div className="booking-title-line">
          <h3>{row.name}</h3>
          <StatusPill status={row.status} />
        </div>
        <p className="booking-meta">
          {TYPE_LABELS[row.type] || row.type} <span className="meta-dot">·</span> {fmt(row.start)} – {fmt(row.end)}
        </p>
        {row.reason && row.reason !== 'On time' && (
          <p className={`booking-reason reason-${row.status}`}>
            <Icon>{row.status === 'broken' || row.status === 'cancelled' ? '!' : 'i'}</Icon>
            {row.reason}
          </p>
        )}
      </div>
    </article>
  )
}

function BackupCard({ hold, chance, onKeep, onCancel, busy }) {
  const held = hold.status === 'held'
  const canceled = hold.status === 'cancelled'
  return (
    <section className={`backup-card ${held ? 'is-held' : 'is-inactive'}`}>
      <div className="backup-icon"><Icon>{held ? '↗' : '✓'}</Icon></div>
      <div className="backup-main">
        <div className="backup-title-line">
          <div>
            <p className="eyebrow">SMART BACKUP</p>
            <h2>{held ? 'A seat is being held for you' : `Backup ${canceled ? 'released' : hold.status}`}</h2>
          </div>
          <StatusPill status={hold.status === 'held' ? 'held' : hold.status === 'cancelled' ? 'dropped' : hold.status} />
        </div>
        <p className="backup-description">
          {held
            ? `${hold.name} · ${pct(chance)} chance of disruption · cancel fee capped at ${rupees(hold.cancel_fee)}.`
            : `${hold.name}${canceled ? ` · ${rupees(hold.lost)} cancellation cost` : ''}.`}
        </p>
        {held && <p className="backup-footnote">You stay in control. Reroute will never purchase or cancel a booking without your approval.</p>}
      </div>
      {held && (
        <div className="backup-actions">
          <button className="button button-secondary button-small" onClick={onCancel} disabled={busy}>Release</button>
          <button className="button button-primary button-small" onClick={onKeep} disabled={busy}>Keep this seat</button>
        </div>
      )}
    </section>
  )
}

function PlanCard({ plan, explanation, onApply, applied, recommended, busy }) {
  const noViolations = plan.violations.length === 0
  return (
    <article className={`plan-card ${recommended ? 'plan-recommended' : ''} ${noViolations ? '' : 'plan-warning'}`}>
      <div className="plan-topline">
        <div className="plan-tags">
          <span className={`plan-tag ${recommended ? 'tag-featured' : ''}`}>
            {recommended ? 'BEST MATCH' : `OPTION ${plan.id}`}
          </span>
          {noViolations
            ? <span className="plan-tag tag-safe">Within your rules</span>
            : <span className="plan-tag tag-warning">{plan.violations.length} trade-off{plan.violations.length > 1 ? 's' : ''}</span>}
        </div>
        <strong className="plan-price">{rupees(plan.extra_cost)}<small> extra</small></strong>
      </div>

      <div className="plan-title-block">
        <h3>{plan.title}</h3>
        <p>Arrive in Mysuru at {fmt(plan.arrival)}</p>
      </div>

      <div className="plan-metrics">
        <div><span>Arrival</span><strong>{plan.late_min ? `${Math.round(plan.late_min / 60)}h ${plan.late_min % 60}m late` : 'On time'}</strong></div>
        <div><span>Changes</span><strong>{plan.changes} {plan.changes === 1 ? 'change' : 'changes'}</strong></div>
        <div><span>Road travel at night</span><strong>{plan.night ? `${plan.night} leg${plan.night > 1 ? 's' : ''}` : 'None'}</strong></div>
      </div>

      {explanation && (
        <div className="explanation">
          <span className="explanation-mark"><Icon>✦</Icon></span>
          <div><b>Why this plan</b><p>{explanation.text}</p><small>{explanation.source}</small></div>
        </div>
      )}

      <details className="plan-details">
        <summary>View itinerary changes <span>{plan.actions.length} steps</span></summary>
        <ul className="action-list">
          {plan.actions.map((action, i) => <li key={`${plan.id}-${i}`}><Icon>✓</Icon>{action}</li>)}
          {plan.violations.map((violation) => <li className="action-warning" key={violation}><Icon>!</Icon>{violation}</li>)}
        </ul>
      </details>

      <button className={`button plan-apply ${applied ? 'button-applied' : 'button-primary'}`}
        onClick={onApply} disabled={applied || busy}>
        {applied ? 'Plan applied' : `Apply Plan ${plan.id}`} <span aria-hidden="true">{applied ? '✓' : '→'}</span>
      </button>
    </article>
  )
}

function Timeline({ rows }) {
  return (
    <div className="booking-list">
      {rows.map((row, index) => <BookingCard key={`${row.id}-${row.status}`} row={row} index={index} />)}
    </div>
  )
}

export default function App() {
  const [s, setS] = useState(null)
  const [explanation, setExplanation] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [showLog, setShowLog] = useState(false)

  async function run(path, body) {
    setError('')
    setBusy(true)
    try {
      const next = await api(path, body)
      setS(next)
      return next
    } catch (e) {
      setError(e.message)
      return null
    } finally {
      setBusy(false)
    }
  }

  async function disrupt(body) {
    setExplanation(null)
    const next = await run('/disrupt', body)
    if (!next?.plans.length) return
    try {
      setExplanation(await api('/explain'))
    } catch (e) {
      setError(e.message)
    }
  }

  async function reset() {
    setExplanation(null)
    await run('/reset', {})
  }

  useEffect(() => { run('/trip') }, [])

  if (!s) {
    return (
      <main className="loading-page">
        <div className="brand-mark"><Icon>↗</Icon></div>
        <p className="eyebrow">REROUTE TRAVEL ASSISTANT</p>
        <h1>Getting your trip ready…</h1>
        <p>Connecting to your live trip details.</p>
        {error && <div className="error-banner">{error} <span>Check that the backend is running on port 8000.</span></div>}
      </main>
    )
  }

  const rules = s.trip.rules
  const affected = s.timeline.filter((row) => row.id !== s.disruption?.booking_id &&
    ['broken', 'cancelled', 'delayed', 'at_risk'].includes(row.status))
  const needsAttention = s.timeline.filter((row) =>
    ['broken', 'cancelled', 'delayed', 'at_risk', 'dropped'].includes(row.status))
  const disrupted = Boolean(s.disruption)
  const isCancelled = s.disruption?.type === 'cancel'
  const route = `${s.trip.start_place} → ${rules.must_arrive.place}`
  const primaryHold = s.holds.find((hold) => hold.status === 'held') || s.holds[s.holds.length - 1]
  const arrivalDeadline = fmt(toMin(rules.must_arrive.by))
  const incidentBooking = s.trip.bookings.find((booking) => booking.id === s.disruption?.booking_id)
  const incidentTitle = incidentBooking?.type === 'flight' ? 'Flight' : TYPE_LABELS[incidentBooking?.type] || incidentBooking?.type

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Reroute home">
          <span className="brand-mark"><Icon>↗</Icon></span>
          <span className="brand-copy"><b>Reroute</b><small>TRAVEL, BACK ON TRACK</small></span>
        </a>
        <div className="trip-context">
          <span className="live-dot" />
          <span>LIVE DEMO</span><i />
          <span>{s.trip.traveller}'s trip</span><b>{route}</b>
        </div>
        <div className="topbar-actions">
          <span className="clock-label">Current time <b>{fmt(s.now)}</b></span>
          <button className="button button-quiet" onClick={reset} disabled={busy}><Icon>↻</Icon> Reset demo</button>
          <div className="avatar" title={s.trip.traveller}>{s.trip.traveller.slice(0, 1)}</div>
        </div>
      </header>

      <main className="dashboard" id="top">
        <div className="route-strip">
          <div className="route-chip"><Icon>⌖</Icon>{route}<span className="route-arrow">⌄</span></div>
          <span className="watch-label"><span className="watch-dot" /> {disrupted ? 'Recovery in progress' : 'Trip watch is active'}</span>
        </div>

        {error && <div className="error-banner"><b>Something went wrong.</b> {error}</div>}

        <section className={`incident-banner ${disrupted ? 'incident-danger' : 'incident-calm'}`}>
          <div className="incident-copy">
            <span className="incident-label"><span className="incident-dot" />{disrupted ? (isCancelled ? 'FLIGHT CANCELLED' : 'TRIP UPDATE') : 'TRIP STATUS'}</span>
            <h1>{s.applied
              ? `Plan ${s.applied.id} is now active`
              : disrupted
              ? `${incidentTitle} ${isCancelled ? 'cancelled' : 'delayed'}${affected.length ? ` · ${affected.length} bookings affected` : ''}`
              : s.chance >= 0.5 ? 'Disruption risk is rising' : 'Your trip is on track'}</h1>
            <p>{disrupted
              ? 'We checked every connected booking and found the recovery options below.'
              : 'Reroute is monitoring warning signs and checking your backup options automatically.'}</p>
          </div>
          <div className="risk-widget" aria-label={`${pct(s.chance)} disruption risk`}>
            <span className="risk-number">{pct(s.chance)}</span>
            <span>disruption risk</span>
            <div className="risk-track"><span style={{ width: pct(s.chance) }} /></div>
          </div>
          <div className="airline-status">
            <span>Airline board</span>
            <b className={s.chance >= 1 ? 'board-cancelled' : ''}>{s.chance >= 1 ? 'Cancelled' : 'On time'}</b>
            <span className="auto-detected"><Icon>✦</Icon> Auto-detected</span>
          </div>
        </section>

        {primaryHold && <BackupCard hold={primaryHold} chance={s.chance}
          onKeep={() => run(`/holds/${primaryHold.id}/keep`, {})}
          onCancel={() => run(`/holds/${primaryHold.id}/cancel`, {})} busy={busy} />}

        <section className="content-section impact-section">
          <SectionHeading eyebrow="YOUR ITINERARY" title={disrupted ? 'Bookings & trip impact' : 'Your upcoming bookings'}
            aside={            <span className={`impact-count ${needsAttention.length ? 'count-danger' : ''}`}>
              {needsAttention.length ? `${needsAttention.length} need attention` : `${s.timeline.length} bookings · all clear`}
            </span>} />
          <Timeline rows={s.timeline} />
        </section>

        {s.plans.length > 0 && (
          <section className="content-section recovery-section">
            <SectionHeading eyebrow="PERSONALIZED FOR YOUR RULES" title="Recovery options"
              aside={<span className="results-note">{s.plans.length} plans ranked by cost, time & comfort</span>} />
            {s.plans[0] && <p className="recovery-intro">We found the best way to keep your trip moving. Compare the trade-offs, then choose what works for you.</p>}
            <div className="plans-grid">
              {s.plans.map((plan, i) => (
                <PlanCard key={plan.id} plan={plan} explanation={i === 0 ? explanation : null}
                  recommended={i === 0 && plan.violations.length === 0}
                  applied={s.applied?.id === plan.id} onApply={() => run(`/plans/${plan.id}/apply`, {})} busy={busy} />
              ))}
            </div>
          </section>
        )}

        <section className="content-section rules-section">
          <SectionHeading eyebrow="YOUR PREFERENCES" title="The rules we’re protecting" />
          <div className="rules-grid">
            <div className="rule-card"><span className="rule-icon">⌖</span><div><span>Arrive in {rules.must_arrive.place}</span><b>By {arrivalDeadline}</b></div></div>
            <div className="rule-card"><span className="rule-icon">₹</span><div><span>Extra spend limit</span><b>Up to {rupees(rules.extra_spend_cap)}</b></div></div>
            <div className="rule-card"><span className="rule-icon">◷</span><div><span>Late-night road travel</span><b>Avoid after {rules.no_road_after}</b></div></div>
            <div className="rule-card"><span className="rule-icon">✓</span><div><span>Flexible backup</span><b>Cancel fee ≤ {rupees(rules.max_undo_cost)}</b></div></div>
          </div>
        </section>

        <section className={`content-section telemetry ${showLog ? 'telemetry-open' : ''}`}>
          <button className="telemetry-toggle" onClick={() => setShowLog((visible) => !visible)} aria-expanded={showLog}>
            <span><Icon>◷</Icon><b>Incident activity</b><small>{s.log.length} updates</small></span>
            <Icon>{showLog ? '⌃' : '⌄'}</Icon>
          </button>
          {showLog && (
            <ol className="activity-list">
              {[...s.log].reverse().map((item, i) => (
                <li key={`${item.at}-${i}`}><time>{fmt(item.at)}</time><span>{item.text}</span></li>
              ))}
              {!s.log.length && <li className="empty-log">No activity yet. Your trip is being monitored.</li>}
            </ol>
          )}
        </section>

        <footer className="page-footer">
          <span>Reroute explains and recommends. You stay in control of every booking.</span>
          <span>DEMO DATA · NO PURCHASES ARE MADE</span>
        </footer>
      </main>

      <nav className="demo-dock" aria-label="Demo controls">
        <span className="dock-label"><span className="live-dot" /> DEMO CONTROLS</span>
        <button className="dock-warning" onClick={() => run('/signals/play', {})} disabled={!s.signals_left || disrupted || busy}>
          <Icon>◉</Icon>Warning sign{ s.signals_left ? ` · ${s.signals_left} left` : ''}
        </button>
        {PROBLEMS.map((problem) => (
          <button className={problem.body.type === 'cancel' ? 'dock-danger' : ''} key={problem.label}
            onClick={() => disrupt(problem.body)} disabled={disrupted || busy}>
            {problem.body.type === 'cancel' ? <Icon>!</Icon> : <Icon>◷</Icon>}{problem.label}
          </button>
        ))}
        <button className="dock-false-alarm" onClick={() => run('/false-alarm', {})} disabled={!s.holds.some((hold) => hold.status === 'held') || busy}>
          False alarm
        </button>
      </nav>
    </div>
  )
}

function toMin(stamp) {
  const [day, clock] = stamp.slice(1).split('T')
  const [h, m] = clock.split(':')
  return (Number(day) - 1) * 1440 + Number(h) * 60 + Number(m)
}
