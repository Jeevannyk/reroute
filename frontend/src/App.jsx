import { useEffect, useState } from 'react'

const pad = (n) => String(n).padStart(2, '0')
const hhmm = (m) => `${pad(Math.floor((m % 1440) / 60))}:${pad(m % 60)}`
const fmt = (m) => (m < 1440 ? 'today ' : 'tomorrow ') + hhmm(m)
const rupees = (n) => '₹' + n.toLocaleString('en-IN')
const pct = (p) => Math.round(p * 100) + '%'
const toMin = (stamp) => {
  const [day, clock] = stamp.slice(1).split('T')
  const [h, m] = clock.split(':')
  return (Number(day) - 1) * 1440 + Number(h) * 60 + Number(m)
}

// Timeline axis: today 16:00 to tomorrow 13:00
const AXIS_START = 16 * 60
const AXIS_END = 1440 + 13 * 60
const pos = (m) => (Math.min(Math.max(m, AXIS_START), AXIS_END) - AXIS_START) / (AXIS_END - AXIS_START) * 100

const STATUS_TEXT = {
  ok: 'on time', at_risk: 'at risk', broken: 'broken', cancelled: 'cancelled', delayed: 'delayed',
  kept: 'kept', changed: 'new time', new: 'new', held: 'backup seat', dropped: 'cancel',
}

const PROBLEMS = [
  { label: 'Delay flight 90 min', body: { type: 'delay', booking_id: 'F1', delay_min: 90, at: 'D1T18:00' } },
  { label: 'Delay flight 4 h', body: { type: 'delay', booking_id: 'F1', delay_min: 240, at: 'D1T18:00' } },
  { label: 'Cancel flight', body: { type: 'cancel', booking_id: 'F1', at: 'D1T18:40' } },
  { label: 'Cancel hotel', body: { type: 'cancel', booking_id: 'H1', at: 'D1T18:00' } },
  { label: 'Cancel train', body: { type: 'cancel', booking_id: 'T1', at: 'D1T18:00' } },
]

async function api(path, body) {
  const options = body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }
  const res = await fetch('/api' + path, options)
  if (!res.ok) {
    const text = await res.text()
    let detail = text
    try { detail = JSON.parse(text).detail } catch { /* not JSON */ }
    throw new Error(typeof detail === 'string' ? detail : `${res.status} ${text}`)
  }
  return res.json()
}

function Timeline({ rows }) {
  const ticks = []
  for (let m = AXIS_START; m <= AXIS_END; m += 180) ticks.push(m)
  return (
    <div className="timeline">
      <div className="row axis">
        <div className="label" />
        <div className="track">
          {ticks.map((m) => <span key={m} className="tick" style={{ left: pos(m) + '%' }}>{hhmm(m)}</span>)}
        </div>
      </div>
      {rows.map((r) => (
        <div className="row" key={r.id + r.status}>
          <div className="label">
            <span className={'badge ' + r.status}>{STATUS_TEXT[r.status] || r.status}</span> {r.name}
            <br /><small>{fmt(r.start)} · {r.reason}</small>
          </div>
          <div className="track">
            <div className={'bar ' + r.status} title={`${fmt(r.start)} → ${fmt(r.end)}`}
              style={{ left: pos(r.start) + '%', width: Math.max(pos(r.end) - pos(r.start), 1) + '%' }} />
          </div>
        </div>
      ))}
    </div>
  )
}

function RulesCard({ rules, onSave }) {
  const [cap, setCap] = useState(rules.extra_spend_cap)
  const [by, setBy] = useState(rules.reach_tour_by.slice(-5))
  const [night, setNight] = useState(rules.allow_night_road)
  return (
    <section className="card">
      <h2>Meera's rules</h2>
      <label>Spend at most ₹ <input type="number" min="0" step="500" value={cap} onChange={(e) => setCap(e.target.value)} /> extra</label>
      <label>Be at the palace tour by <input type="time" value={by} onChange={(e) => setBy(e.target.value)} /> tomorrow</label>
      <label><input type="checkbox" checked={night} onChange={(e) => setNight(e.target.checked)} /> Allow road travel after {rules.no_road_after}</label>
      <small>Backups: at most {rupees(rules.max_undo_cost)} to cancel each.</small>
      <div className="buttons">
        <button onClick={() => onSave({ extra_spend_cap: Number(cap), reach_tour_by: by, allow_night_road: night })}>Save rules</button>
      </div>
    </section>
  )
}

function BackupCard({ hold, chance, trip, disruption, onKeep, onCancel }) {
  const flight = trip.bookings.find((b) => b.id === hold.target)
  if (hold.status !== 'held') {
    const text = {
      kept: `You kept the backup: ${hold.name} (${rupees(hold.price)} paid).`,
      used: `Your backup seat on the ${hold.name} is in your new plan.`,
      cancelled: `Backup ${hold.name} cancelled. Lost ${rupees(hold.lost)}.`,
      expired: `Backup ${hold.name} expired: it has left.`,
    }[hold.status]
    return <div className="card muted">{text}</div>
  }
  const free = hold.free_cancel_until !== null ? `Free to cancel until ${hhmm(hold.free_cancel_until)}, then at most` : 'If you cancel, you lose at most'
  let text
  if (disruption?.type === 'cancel' && disruption.booking_id === hold.target) {
    text = <>Your flight is cancelled. Your backup seat on the <b>{hold.name}</b> is ready.</>
  } else if (disruption) {
    text = <>We are still holding a seat for you on the <b>{hold.name}</b>.</>
  } else {
    text = <>{pct(chance)} chance your {hhmm(toMin(flight.start))} flight gets cancelled. We are holding a seat for
      you on the <b>{hold.name}</b>.</>
  }
  return (
    <div className="card backup">
      {text} You have paid ₹0. {free} {rupees(hold.cancel_fee)}.
      <div className="buttons">
        <button onClick={onKeep}>KEEP</button>
        <button onClick={onCancel}>CANCEL</button>
      </div>
    </div>
  )
}

function AgentCard({ s, busy, onAsk }) {
  const [message, setMessage] = useState('')
  const a = s.agent
  return (
    <section className="card agent">
      <h2>AI agent</h2>
      <p className="hint">The agent picks which tools to call (domino check, plan search, what-ifs, rules) and drafts messages.
        Prices and times always come from our code.</p>
      <div className="ask">
        <input value={message} onChange={(e) => setMessage(e.target.value)} maxLength={300}
          placeholder="Optional: e.g. I can only spend ₹2,000 extra" disabled={!s.disruption || busy} />
        <button onClick={() => onAsk(message)} disabled={!s.disruption || busy}>
          {busy ? 'Agent working…' : 'Ask AI agent'}
        </button>
      </div>
      {!s.disruption && <small>Break something first.</small>}
      {a && (
        <>
          <p className="source">
            {a.source.startsWith('rule-based') ? 'Rule-based fallback (AI unavailable)' : `Gemini (${a.source})`}
            {a.note && <small> · {a.note}</small>}
          </p>
          <ol className="steps">
            {a.steps.map((st, i) => <li key={i}><code>{st.tool}</code> {st.summary}</li>)}
          </ol>
          <p className="reply">{a.reply}</p>
          {a.messages.length > 0 && (
            <>
              <h3>Drafted messages</h3>
              <ul>{a.messages.map((m, i) => <li key={i}><b>To {m.to}:</b> {m.text}</li>)}</ul>
            </>
          )}
        </>
      )}
    </section>
  )
}

function PlanCard({ plan, picked, applied, onApply }) {
  return (
    <div className={'card plan' + (plan.violations.length ? ' bad' : ' good')}>
      <h3>Plan {plan.id}: {plan.title} {picked && <span className="pick">AI pick</span>}</h3>
      <div>Mysuru <b>{fmt(plan.arrival)}</b> · palace <b>{hhmm(plan.at_tour)}</b> · extra <b>{rupees(plan.extra_cost)}</b> ·
        {' '}{plan.changes} change(s) · score {plan.score} <small>(lower = better)</small></div>
      {plan.violations.length > 0 && <div className="warn">Breaks rule: {plan.violations.join('; ')}</div>}
      <ul>{plan.actions.map((a) => <li key={a}>{a}</li>)}</ul>
      <button onClick={onApply} disabled={applied}>{applied ? 'Applied' : 'Use this plan'}</button>
    </div>
  )
}

export default function App() {
  const [s, setS] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function run(path, body) {
    setError('')
    try {
      setS(await api(path, body))
    } catch (e) {
      setError(e.message)
    }
  }

  async function ask(message) {
    setBusy(true)
    await run('/agent', { message })
    setBusy(false)
  }

  useEffect(() => { run('/trip') }, [])

  if (!s) return <p style={{ padding: 20 }}>Loading… is the backend running on port 8000? {error}</p>
  const flightCancelled = s.chance >= 1

  return (
    <div className="page">
      <header>
        <h1>Reroute</h1>
        <span>Now: <b>{fmt(s.now)}</b></span>
        <span className="note">Pretend data. Warning signs are a prepared replay.</span>
      </header>
      {error && <div className="error">{error}</div>}

      <div className="grid">
        <aside>
          <RulesCard key={JSON.stringify(s.trip.rules)} rules={s.trip.rules} onSave={(r) => run('/rules', r)} />

          <section className="card">
            <h2>Warning signs</h2>
            <div className="meter"><div style={{ width: pct(s.chance) }} /></div>
            <p>Chance your flight is cancelled: <b>{pct(s.chance)}</b> · Airline board: <b>{flightCancelled ? 'Cancelled' : 'On Time'}</b></p>
            <div className="buttons">
              <button onClick={() => run('/signals/play', {})} disabled={!s.signals_left || !!s.disruption}>
                Play warning sign ({s.signals_left} left)
              </button>
              <button onClick={() => run('/false-alarm', {})} disabled={!!s.disruption || s.replay_over}>False alarm</button>
            </div>
            <ol>{s.signals.map((g) => <li key={g.at}>{hhmm(toMin(g.at))} {g.text}</li>)}</ol>
          </section>

          {s.holds.map((h) => (
            <BackupCard key={h.id} hold={h} chance={s.chance} trip={s.trip} disruption={s.disruption}
              onKeep={() => run(`/holds/${h.id}/keep`, {})} onCancel={() => run(`/holds/${h.id}/cancel`, {})} />
          ))}

          <section className="card">
            <h2>Break something</h2>
            <div className="buttons">
              {PROBLEMS.map((p) => (
                <button key={p.label} onClick={() => run('/disrupt', p.body)} disabled={!!s.disruption}>{p.label}</button>
              ))}
            </div>
            <div className="buttons">
              <button className="reset" onClick={() => run('/reset', {})}>Reset demo</button>
            </div>
          </section>
        </aside>

        <main>
          <section className="card">
            <h2>{s.applied ? `New trip (Plan ${s.applied.id})` : 'Trip'}</h2>
            <Timeline rows={s.timeline} />
          </section>

          {s.disruption && <AgentCard s={s} busy={busy} onAsk={ask} />}

          {s.disruption && (
            <section>
              <h2>Top plans</h2>
              {s.plans.length === 0 && <div className="card muted">Nothing to re-plan: the rest of the trip is fine. Refund due.</div>}
              {s.plans.map((p) => (
                <PlanCard key={p.id} plan={p} picked={s.agent?.recommended === p.id}
                  applied={s.applied?.id === p.id} onApply={() => run(`/plans/${p.id}/apply`, {})} />
              ))}
            </section>
          )}

          <section className="card">
            <h2>Log</h2>
            <ul className="log">{[...s.log].reverse().map((l, i) => <li key={i}><b>{hhmm(l.at)}</b> {l.text}</li>)}</ul>
          </section>
        </main>
      </div>
    </div>
  )
}
