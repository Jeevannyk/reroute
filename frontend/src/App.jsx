import { useEffect, useState } from 'react'

const pad = (n) => String(n).padStart(2, '0')
const fmt = (m) => `D${Math.floor(m / 1440) + 1} ${pad(Math.floor((m % 1440) / 60))}:${pad(m % 60)}`
const rupees = (n) => '₹' + n.toLocaleString('en-IN')
const pct = (p) => Math.round(p * 100) + '%'

// Timeline axis: day 1 16:00 to day 2 13:00
const AXIS_START = 16 * 60
const AXIS_END = 1440 + 13 * 60
const pos = (m) => (Math.min(Math.max(m, AXIS_START), AXIS_END) - AXIS_START) / (AXIS_END - AXIS_START) * 100

const PROBLEMS = [
  { label: 'Delay flight 4 h', body: { type: 'delay', booking_id: 'F1', delay_min: 240, at: 'D1T18:00' } },
  { label: 'Cancel flight', body: { type: 'cancel', booking_id: 'F1', at: 'D1T18:40' } },
  { label: 'Cancel train', body: { type: 'cancel', booking_id: 'T1', at: 'D1T18:00' } },
]

async function api(path, body) {
  const options = body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }
  const res = await fetch('/api' + path, options)
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
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
          {ticks.map((m) => <span key={m} className="tick" style={{ left: pos(m) + '%' }}>{fmt(m)}</span>)}
        </div>
      </div>
      {rows.map((r) => (
        <div className="row" key={r.id + r.status}>
          <div className="label"><b>{r.id}</b> {r.name}<br /><small>{r.reason}</small></div>
          <div className="track">
            <div className={'bar ' + r.status}
              style={{ left: pos(r.start) + '%', width: Math.max(pos(r.end) - pos(r.start), 1) + '%' }}
              title={`${fmt(r.start)} → ${fmt(r.end)}`}>
              {r.status}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function BackupCard({ hold, chance, onKeep, onCancel }) {
  if (hold.status !== 'held') {
    const lost = hold.status === 'cancelled' ? `, lost ${rupees(hold.lost)}` : ''
    return <div className="card muted">Backup {hold.name}: <b>{hold.status}</b>{lost}</div>
  }
  return (
    <div className="card backup">
      Your 18:30 flight will probably be cancelled ({pct(chance)} chance). We are holding a seat for you
      on the <b>{hold.name}</b>. You have paid ₹0. If you cancel, you lose at most {rupees(hold.cancel_fee)}.
      <div className="buttons">
        <button onClick={onKeep}>KEEP</button>
        <button onClick={onCancel}>CANCEL</button>
      </div>
    </div>
  )
}

function PlanCard({ plan, explanation, onApply, applied }) {
  return (
    <div className={'card plan' + (plan.violations.length ? ' bad' : ' good')}>
      <h3>Plan {plan.id}: {plan.title}</h3>
      <div>Arrive Mysuru <b>{fmt(plan.arrival)}</b> · extra cost <b>{rupees(plan.extra_cost)}</b> ·
        {' '}{plan.changes} change(s) · score {plan.score}</div>
      {plan.violations.length > 0 && <div className="warn">Breaks rule: {plan.violations.join('; ')}</div>}
      <ul>{plan.actions.map((a) => <li key={a}>{a}</li>)}</ul>
      {explanation && <p className="explain"><i>{explanation.text}</i> <small>({explanation.source})</small></p>}
      <button onClick={onApply} disabled={applied}>{applied ? 'Applied' : 'Use this plan'}</button>
    </div>
  )
}

export default function App() {
  const [s, setS] = useState(null)
  const [explanation, setExplanation] = useState(null)
  const [error, setError] = useState('')

  async function run(path, body) {
    setError('')
    try {
      setS(await api(path, body))
    } catch (e) {
      setError(e.message)
    }
  }

  async function disrupt(body) {
    setExplanation(null)
    await run('/disrupt', body)
    try {
      setExplanation(await api('/explain'))
    } catch (e) {
      setError(e.message)
    }
  }

  useEffect(() => { run('/trip') }, [])

  if (!s) return <p style={{ padding: 20 }}>Loading… is the backend running on port 8000? {error}</p>
  const rules = s.trip.rules

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
          <section className="card">
            <h2>{s.trip.traveller}'s rules</h2>
            <ul>
              <li>Reach {rules.must_arrive.place} by {fmt(toMin(rules.must_arrive.by))}</li>
              <li>Spend at most {rupees(rules.extra_spend_cap)} extra</li>
              <li>No road travel after {rules.no_road_after}</li>
              <li>Backup: max {rupees(rules.max_undo_cost)} to cancel each, {rupees(rules.hold_budget)} total</li>
            </ul>
          </section>

          <section className="card">
            <h2>Warning signs</h2>
            <div className="meter"><div style={{ width: pct(s.chance) }} /></div>
            <p>Chance flight F1 fails: <b>{pct(s.chance)}</b> · Airline board: <b>{s.chance >= 1 ? 'Cancelled' : 'On Time'}</b></p>
            <div className="buttons">
              <button onClick={() => run('/signals/play', {})} disabled={!s.signals_left || !!s.disruption}>
                Play warning sign ({s.signals_left} left)
              </button>
              <button onClick={() => run('/false-alarm', {})} disabled={!!s.disruption}>False alarm</button>
            </div>
            <ol>{s.signals.map((g) => <li key={g.at}>{fmt(toMin(g.at))} {g.text}</li>)}</ol>
          </section>

          {s.holds.map((h) => (
            <BackupCard key={h.id} hold={h} chance={s.chance}
              onKeep={() => run(`/holds/${h.id}/keep`, {})} onCancel={() => run(`/holds/${h.id}/cancel`, {})} />
          ))}

          <section className="card">
            <h2>Break something</h2>
            <div className="buttons">
              {PROBLEMS.map((p) => <button key={p.label} onClick={() => disrupt(p.body)}>{p.label}</button>)}
              <button className="reset" onClick={() => { setExplanation(null); run('/reset', {}) }}>Reset</button>
            </div>
          </section>
        </aside>

        <main>
          <section className="card">
            <h2>{s.applied ? `New plan (Plan ${s.applied.id})` : 'Trip'}</h2>
            <Timeline rows={s.timeline} />
          </section>

          {s.plans.length > 0 && (
            <section>
              <h2>Top plans</h2>
              {s.plans.map((p, i) => (
                <PlanCard key={p.id} plan={p} explanation={i === 0 ? explanation : null}
                  applied={s.applied?.id === p.id} onApply={() => run(`/plans/${p.id}/apply`, {})} />
              ))}
            </section>
          )}

          <section className="card">
            <h2>Log</h2>
            <ul className="log">{[...s.log].reverse().map((l, i) => <li key={i}><b>{fmt(l.at)}</b> {l.text}</li>)}</ul>
          </section>
        </main>
      </div>
    </div>
  )
}

function toMin(stamp) {
  const [day, clock] = stamp.slice(1).split('T')
  const [h, m] = clock.split(':')
  return (Number(day) - 1) * 1440 + Number(h) * 60 + Number(m)
}
