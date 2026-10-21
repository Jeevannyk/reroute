import { useEffect, useRef, useState } from 'react'

/* ───────────── helpers ───────────── */
const pad = (n) => String(n).padStart(2, '0')
const fmt = (m) => `D${Math.floor(m / 1440) + 1} ${pad(Math.floor((m % 1440) / 60))}:${pad(m % 60)}`
const rupees = (n) => '₹' + n.toLocaleString('en-IN')
const pct = (p) => Math.round(p * 100) + '%'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function toMin(stamp) {
  const [day, clock] = stamp.slice(1).split('T')
  const [h, m] = clock.split(':')
  return (Number(day) - 1) * 1440 + Number(h) * 60 + Number(m)
}

// Timeline axis: day 1 16:00 to day 2 13:00
const AXIS_START = 16 * 60
const AXIS_END = 1440 + 13 * 60
const pos = (m) => (Math.min(Math.max(m, AXIS_START), AXIS_END) - AXIS_START) / (AXIS_END - AXIS_START) * 100

const PROBLEMS = [
  { label: 'Delay flight 4 h', body: { type: 'delay', booking_id: 'F1', delay_min: 240, at: 'D1T18:00' } },
  { label: 'Cancel flight', body: { type: 'cancel', booking_id: 'F1', at: 'D1T18:40' } },
  { label: 'Cancel train', body: { type: 'cancel', booking_id: 'T1', at: 'D1T18:00' } },
]

// Timing of the "computational" feel (ms)
const ANALYZE_STEPS = [
  'Detecting affected segments',
  'Running domino check on dependent bookings',
  'Searching alternative routes',
  'Scoring candidate plans against rules',
]
const STEP_MS = 650
const REVEAL_MS = 1900

async function api(path, body) {
  const options = body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }
  const res = await fetch('/api' + path, options)
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.json()
}

function logTag(t) {
  if (/^\[/.test(t)) return null
  if (/Backup rule|%\s*×/.test(t)) return 'PROBABILITY'
  if (/auto-cancel/i.test(t)) return 'RESOLVE'
  if (/applied/i.test(t)) return 'AUTO-ACTION'
  if (/(kept|cancelled) the backup|Meera/i.test(t)) return 'POLICY'
  if (/Warning sign/i.test(t)) return 'WARNING'
  if (/delayed|Domino|cancelled/i.test(t)) return 'TRIGGER'
  if (/Incoming|telemetry|Chance back|lands/i.test(t)) return 'TELEMETRY'
  return 'SYSTEM'
}

/* ───────────── small UI pieces ───────────── */
const C = 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z'
const ICONS = {
  logo: ['M8 19h8a3 3 0 0 0 0-6H8a3 3 0 0 1 0-6h8', 'M4 19a2 2 0 1 0 4 0 2 2 0 0 0-4 0z', 'M16 7a2 2 0 1 0 4 0 2 2 0 0 0-4 0z'],
  clock: [C, 'M12 7v5l3 2'],
  wallet: ['M3 7h15a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7z', 'M3 7l12-3v3', 'M17 14h.01'],
  shield: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z'],
  layers: ['M12 3l9 5-9 5-9-5 9-5z', 'M3 13l9 5 9-5'],
  sliders: ['M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6'],
  activity: ['M3 12h4l3-8 4 16 3-8h4'],
  play: ['M7 4l13 8-13 8V4z'],
  ban: [C, 'M5.6 5.6l12.8 12.8'],
  plus: [C, 'M12 8v8M8 12h8'],
  xc: [C, 'M15 9l-6 6M9 9l6 6'],
  checkc: [C, 'M8 12l3 3 5-6'],
  check: ['M5 13l4 4L19 7'],
  alert: ['M12 3l10 18H2L12 3z', 'M12 10v5M12 18h.01'],
  compass: [C, 'M15.5 8.5l-2 5-5 2 2-5 5-2z'],
  terminal: ['M4 17l6-6-6-6M12 19h8'],
  phone: ['M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z'],
  refresh: ['M21 12a9 9 0 1 1-3-6.7M21 4v5h-5'],
  bus: ['M5 5h14a1 1 0 0 1 1 1v10H4V6a1 1 0 0 1 1-1z', 'M4 11h16M7 19v-3M17 19v-3'],
  dot: ['M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z'],
}
function Icon({ name, size = 16, className = '' }) {
  return (
    <svg className={'ic ' + className} width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name].map((d, i) => <path key={i} d={d} />)}
    </svg>
  )
}

function Btn({ loading, children, className = '', ...rest }) {
  return (
    <button className={'btn ' + className} {...rest}>
      {loading && <span className="spinner" />}
      {children}
    </button>
  )
}

// Smoothly counts a number towards its target
function useCount(target, ms = 700) {
  const [v, setV] = useState(target)
  const from = useRef(target)
  useEffect(() => {
    const start = performance.now()
    const a = from.current
    let raf
    const tick = (t) => {
      const k = Math.min((t - start) / ms, 1)
      const val = a + (target - a) * (1 - Math.pow(1 - k, 3))
      from.current = val
      setV(val)
      if (k < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, ms])
  return v
}

// Typewriter text
function Typed({ text }) {
  const [n, setN] = useState(0)
  useEffect(() => {
    setN(0)
    const id = setInterval(() => setN((v) => (v >= text.length ? (clearInterval(id), v) : v + 2)), 16)
    return () => clearInterval(id)
  }, [text])
  return <>{text.slice(0, n)}</>
}

/* ───────────── timeline ───────────── */
function Timeline({ rows, recomputing }) {
  const ticks = []
  for (let m = AXIS_START; m <= AXIS_END; m += 180) ticks.push(m)
  return (
    <div className={'timeline' + (recomputing ? ' recomputing' : '')}>
      <div className="tl-scroll">
        <div className="tl-row tl-head">
          <div className="tl-label">Segment &amp; Cancellation Penalty</div>
          <div className="tl-track">
            {ticks.map((m) => <span key={m} className="tick" style={{ left: pos(m) + '%' }}>{fmt(m)}</span>)}
          </div>
        </div>
        {rows.map((r, i) => {
          const neg = /lose|cancel/i.test(r.reason || '')
          const left = pos(r.start)
          const width = Math.max(pos(r.end) - left, 1)
          return (
            <div className={'tl-row st-' + r.status} key={r.id + r.status} style={{ animationDelay: i * 70 + 'ms' }}>
              <div className="tl-label">
                <div className="seg-name">
                  {r.status === 'new' && <span className="new-dot" />}
                  <b>{r.id}</b> {r.name}
                </div>
                <div className={'seg-sub' + (neg ? ' neg' : '')}>{r.reason}</div>
              </div>
              <div className="tl-track">
                {ticks.map((m) => <i key={m} className="gridline" style={{ left: pos(m) + '%' }} />)}
                <div className={'bar ' + r.status}
                  style={{ left: `min(${left}%, calc(100% - 58px))`, width: width + '%', animationDelay: 150 + i * 70 + 'ms' }}
                  title={`${fmt(r.start)} → ${fmt(r.end)}`}>
                  {r.status === 'new'
                    ? <><Icon name="bus" size={13} /> New segment <span className="pill-new">NEW</span></>
                    : r.status}
                </div>
              </div>
            </div>
          )
        })}
      </div>
      {recomputing && <div className="tl-overlay"><span className="spinner lg" /> Re-aligning timeline…</div>}
    </div>
  )
}

/* ───────────── backup reservations ───────────── */
function BackupCard({ hold, chance, onKeep, onCancel, locked, busyKey }) {
  const cost = hold.cost ?? hold.price
  if (hold.status === 'held') {
    return (
      <div className="backup held">
        <div className="backup-title"><Icon name="layers" size={15} /> <b>{hold.name}</b></div>
        <p>
          Your 18:30 flight will probably be cancelled (<b>{pct(chance)}</b> chance). We are holding a seat for you
          on this route. You have paid ₹0. If you cancel, you lose at most <b>{rupees(hold.cancel_fee)}</b>.
        </p>
        <div className="buttons">
          <Btn className="primary" disabled={locked} loading={busyKey === 'keep' + hold.id} onClick={onKeep}>Keep</Btn>
          <Btn disabled={locked} loading={busyKey === 'cancel' + hold.id} onClick={onCancel}>Cancel</Btn>
        </div>
      </div>
    )
  }
  if (hold.status === 'kept') {
    return (
      <div className="backup kept">
        <Icon name="checkc" size={18} className="green" />
        <div className="grow">
          <b>{hold.name}</b>
          <small>Designated primary escape path</small>
        </div>
        <span className="chip green">KEPT</span>
      </div>
    )
  }
  return (
    <div className="backup done">
      <div className="grow">
        <b>{hold.name}</b>
        <small>{cost != null ? `Cost: ${rupees(cost)} · ` : ''}Hedge status resolved</small>
      </div>
      <span className="chip gray">{String(hold.status).toUpperCase()}, LOST {rupees(hold.lost ?? 0)}</span>
    </div>
  )
}

/* ───────────── plans ───────────── */
function actionIcon(a) {
  if (/^book/i.test(a)) return ['plus', 'blue']
  if (/^cancel/i.test(a)) return ['xc', 'red']
  if (/^(tell|call|inform|notify)/i.test(a)) return ['phone', 'red']
  if (/stays|kept|keep/i.test(a)) return ['checkc', 'green']
  return ['dot', 'gray']
}

function PlanCard({ plan, explanation, onApply, applied, applying, locked }) {
  const bad = plan.violations.length > 0
  return (
    <div className={'plan' + (bad ? ' bad' : '') + (applied ? ' applied' : '')}>
      {applied && <span className="applied-badge"><Icon name="check" size={11} /> CURRENTLY APPLIED</span>}
      <div className="plan-top">
        <div>
          <h3>Plan {plan.id}: {plan.title} <code className="score">Score {plan.score}</code></h3>
          <div className="plan-meta">
            Arrive Mysuru <code>{fmt(plan.arrival)}</code> · Extra cost <b>{rupees(plan.extra_cost)}</b> · {plan.changes} changes
          </div>
        </div>
        <Btn className={applied ? 'applied-btn' : ''} disabled={applied || locked} loading={applying} onClick={onApply}>
          {applied ? 'Applied' : applying ? 'Applying…' : 'Use this plan'}
        </Btn>
      </div>
      {bad && <div className="warn"><Icon name="alert" size={14} /> Breaks rule: {plan.violations.join('; ')}</div>}
      <ul className="actions">
        {plan.actions.map((a, i) => {
          const [ic, tone] = actionIcon(a)
          return <li key={a} style={{ animationDelay: 120 + i * 90 + 'ms' }}><Icon name={ic} size={15} className={tone} /> {a}</li>
        })}
      </ul>
      {explanation && (
        <p className="explain"><i><Typed text={explanation.text} /></i> <small>({explanation.source})</small></p>
      )}
    </div>
  )
}

function Analyzer() {
  const [i, setI] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setI((v) => Math.min(v + 1, ANALYZE_STEPS.length)), STEP_MS)
    return () => clearInterval(id)
  }, [])
  return (
    <div className="analyzer">
      <div className="an-head">
        <span className="spinner lg" />
        <div><b>Recomputing itinerary</b><small>Constraint solver is checking every booking against Meera’s rules</small></div>
      </div>
      <div className="an-bar"><i style={{ width: (i / ANALYZE_STEPS.length) * 100 + '%' }} /></div>
      <ul>
        {ANALYZE_STEPS.map((t, k) => (
          <li key={t} className={k < i ? 'done' : k === i ? 'active' : ''}>
            {k < i ? <Icon name="check" size={14} className="green" /> : k === i ? <span className="spinner" /> : <span className="pending-dot" />}
            {t}
          </li>
        ))}
      </ul>
    </div>
  )
}

function Skeleton({ n, total }) {
  return (
    <div className="plan skeleton">
      <div className="sk-head"><span className="spinner" /> Evaluating candidate {n} of {total}…</div>
      <div className="sk-line w60" /><div className="sk-line w90" /><div className="sk-line w75" />
    </div>
  )
}

/* ───────────── app ───────────── */
export default function App() {
  const [s, setS] = useState(null)
  const [explanation, setExplanation] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')            // key of the action currently running
  const [phase, setPhase] = useState('idle')      // idle | analyzing | revealing
  const [revealed, setRevealed] = useState(999)   // how many plans are visible
  const [scanning, setScanning] = useState(false) // "evaluating next candidate" loader
  const token = useRef(0)

  const chanceNow = Math.round(useCount(s ? s.chance * 100 : 0))

  async function run(path, body, minMs = 0) {
    setError('')
    const t0 = Date.now()
    try {
      const next = await api(path, body)
      const wait = minMs - (Date.now() - t0)
      if (wait > 0) await sleep(wait)
      setS(next)
      return next
    } catch (e) {
      setError(e.message)
    }
  }

  async function act(key, path, body, minMs = 800) {
    setBusy(key)
    await run(path, body, minMs)
    setBusy('')
  }

  async function disrupt(body, key) {
    const my = ++token.current
    setError('')
    setExplanation(null)
    setBusy(key)
    setPhase('analyzing')
    setScanning(false)
    setRevealed(0)
    const t0 = Date.now()
    try {
      const next = await api('/disrupt', body)
      const exp = await api('/explain').catch(() => null)
      const wait = ANALYZE_STEPS.length * STEP_MS + 450 - (Date.now() - t0)
      if (wait > 0) await sleep(wait)
      if (token.current !== my) return
      setS(next)
      setExplanation(exp)
      setPhase('revealing')
      // reveal plans one by one, with a loader between each
      for (let i = 1; i <= next.plans.length; i++) {
        setScanning(true)
        await sleep(REVEAL_MS)
        if (token.current !== my) return
        setScanning(false)
        setRevealed(i)
        await sleep(350)
        if (token.current !== my) return
      }
    } catch (e) {
      if (token.current === my) setError(e.message)
    } finally {
      if (token.current === my) {
        setPhase('idle'); setBusy(''); setScanning(false); setRevealed(999)
      }
    }
  }

  async function applyPlan(id) {
    setBusy('apply' + id)
    await run(`/plans/${id}/apply`, {}, 1200)
    setBusy('')
  }

  async function reset() {
    token.current++
    setPhase('idle'); setScanning(false); setRevealed(999); setExplanation(null)
    setBusy('reset')
    await run('/reset', {}, 700)
    setBusy('')
  }

  useEffect(() => { run('/trip') }, [])

  if (!s) return <p className="loading">Loading… is the backend running on port 8000? {error}</p>

  const rules = s.trip.rules
  const name = s.trip.traveller
  const initials = (name + ' V').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()
  const locked = phase !== 'idle' || !!busy
  const analyzing = phase === 'analyzing'
  const shownPlans = analyzing ? [] : s.plans.slice(0, revealed)
  const failed = s.chance >= 1
  const hot = s.chance >= 0.35
  const recovering = !!(s.applied || s.disruption)

  return (
    <div className="shell">
      {/* top bar */}
      <header className="topbar">
        <div className="brand">
          <span className="logo"><Icon name="logo" size={18} /></span>
          <h1>Reroute</h1>
          <span className="engine">ENGINE V2.4</span>
        </div>
        <div className="top-mid">
          <span className="clock"><span className="pulse" /> Simulated Clock: <b>{fmt(s.now)}</b></span>
          <span className="note"><Icon name="refresh" size={13} /> Pretend data. Warning signs are a prepared replay.</span>
        </div>
        <div className="top-right">
          <div className="user">
            <span className="avatar">{initials}</span>
            <div><b>{name} V.</b><small>PNR: {s.trip.pnr || 'IXE-MYQ-89F'}</small></div>
            <span className="tier">Business</span>
          </div>
          <Btn disabled={busy === 'reset'} loading={busy === 'reset'} onClick={reset}>
            {busy !== 'reset' && <Icon name="refresh" size={14} />} Reset Replay
          </Btn>
        </div>
      </header>

      {error && <div className="error">{error}</div>}

      <div className="grid">
        <aside>
          {/* rules */}
          <section className="panel">
            <div className="panel-head">
              <h2><Icon name="sliders" size={15} /> {name}’s rules</h2>
              <span className="badge green">4 Active Policy Caps</span>
            </div>
            <div className="rule"><Icon name="clock" size={16} className="blue" />
              <div>Reach {rules.must_arrive.place} by <code className="red">{fmt(toMin(rules.must_arrive.by))}</code>
                <small>Hard constraint · {rules.must_arrive.place} Palace Tour booking</small></div></div>
            <div className="rule"><Icon name="wallet" size={16} className="blue" />
              <div>Spend at most <code>{rupees(rules.extra_spend_cap)}</code> extra
                <small>Out-of-pocket tolerance buffer</small></div></div>
            <div className="rule"><Icon name="shield" size={16} className="blue" />
              <div>No road travel after <code>{rules.no_road_after}</code>
                <small>Western Ghats hazard prevention policy</small></div></div>
            <div className="rule"><Icon name="layers" size={16} className="blue" />
              <div>Backup Hedge: max <code>{rupees(rules.max_undo_cost)}</code> cancellation risk
                <small>Pooled protection cap: {rupees(rules.hold_budget)} total reserve</small></div></div>
          </section>

          {/* warning signs */}
          <section className="panel">
            <div className="panel-head">
              <h2><Icon name="activity" size={15} className="amber" /> Warning signs &amp; risk</h2>
              <span className={'badge ' + (failed ? 'red' : 'green')}><i className="bdot" /> Airline: {failed ? 'Cancelled' : 'On Time'}</span>
            </div>
            <div className="risk-row">
              <span>Chance flight <b>F1</b> fails</span>
              <b className={'risk-val' + (hot ? ' hot' : '')}>{chanceNow}%</b>
            </div>
            <div className="meter">
              <div className="fill" style={{ width: pct(s.chance) }} />
              <i className="threshold" style={{ left: '35%' }} />
            </div>
            <div className="meter-labels"><span>0% baseline</span><span className="th">35% trigger threshold</span><span>100%</span></div>
            <div className="buttons two">
              <Btn className="soft" loading={busy === 'signal'} disabled={locked || !s.signals_left || !!s.disruption}
                onClick={() => act('signal', '/signals/play', {}, 1000)}>
                {busy !== 'signal' && <Icon name="play" size={12} />} Play sign ({s.signals_left} left)
              </Btn>
              <Btn loading={busy === 'alarm'} disabled={locked || !!s.disruption}
                onClick={() => act('alarm', '/false-alarm', {}, 1000)}>
                {busy !== 'alarm' && <Icon name="ban" size={14} />} False alarm
              </Btn>
            </div>
            <h4>Incoming telemetry stream</h4>
            {s.signals.length === 0 && <p className="empty">No signals yet. Play a warning sign to start the replay.</p>}
            <ol className="telemetry">
              {s.signals.map((g, i) => (
                <li key={g.at} className={i === s.signals.length - 1 && hot ? 'hot' : 'warm'}>
                  {i + 1}. {fmt(toMin(g.at))} {g.text}
                </li>
              ))}
            </ol>
          </section>

          {/* backups */}
          {s.holds.length > 0 && (
            <section className="panel">
              <h4 className="first">Autonomous backup reservations</h4>
              {s.holds.map((h) => (
                <BackupCard key={h.id + h.status} hold={h} chance={s.chance} locked={locked} busyKey={busy}
                  onKeep={() => act('keep' + h.id, `/holds/${h.id}/keep`, {})}
                  onCancel={() => act('cancel' + h.id, `/holds/${h.id}/cancel`, {})} />
              ))}
            </section>
          )}

          {/* chaos */}
          <section className="panel">
            <div className="panel-head">
              <h2><Icon name="alert" size={15} className="red" /> Break something (inject chaos)</h2>
              <span className="sandbox">Sandbox</span>
            </div>
            <div className="chaos">
              {PROBLEMS.map((p) => (
                <Btn key={p.label} className="soft" loading={busy === p.label} disabled={locked}
                  onClick={() => disrupt(p.body, p.label)}>{p.label}</Btn>
              ))}
              <Btn className="reset" disabled={busy === 'reset'} onClick={reset}>Reset</Btn>
            </div>
          </section>
        </aside>

        <main>
          {/* timeline */}
          <section className="panel recovery">
            <div className="rec-head">
              <div>
                <div className="rec-title">
                  <span className={'tag ' + (recovering ? 'blue' : 'gray')}>{analyzing ? 'RECOMPUTING' : recovering ? 'ACTIVE RECOVERY' : 'ITINERARY'}</span>
                  <h2>{s.applied ? `New Plan (Plan ${s.applied.id} Execution Track)` : 'Trip'}</h2>
                </div>
                <p className="sub">Timeline re-alignment across multi-modal assets</p>
              </div>
              <div className="legend">
                <span><i className="sq new" /> New</span>
                <span><i className="sq dropped" /> Dropped</span>
                <span><i className="sq kept" /> Kept / Protected</span>
              </div>
            </div>
            <Timeline rows={s.timeline} recomputing={analyzing} />
          </section>

          {/* plans */}
          {(analyzing || s.plans.length > 0) && (
            <section className="plans">
              <div className="plans-head">
                <h2><Icon name="compass" size={16} className="blue" /> Top alternative plans</h2>
                <span>Ranked by score (lower score = less operational disruption)</span>
              </div>
              {analyzing && <Analyzer />}
              {shownPlans.map((p, i) => (
                <PlanCard key={p.id} plan={p} explanation={i === 0 ? explanation : null}
                  applied={s.applied?.id === p.id} applying={busy === 'apply' + p.id} locked={locked}
                  onApply={() => applyPlan(p.id)} />
              ))}
              {scanning && <Skeleton n={revealed + 1} total={s.plans.length} />}
            </section>
          )}

          {/* log */}
          <section className="panel logpanel">
            <div className="panel-head">
              <h2><Icon name="terminal" size={15} /> Operational log &amp; decision trail</h2>
              <span className="live"><i className="pulse green" /> Live telemetry sync</span>
            </div>
            <ul className="log">
              {s.log.map((l, i) => ({ l, i })).reverse().map(({ l, i }, k) => {
                const tag = logTag(l.text)
                return (
                  <li key={i} className={k > 4 ? 'old' : ''}>
                    <b>{fmt(l.at)}</b>{' '}
                    {tag && <span className={'ltag ' + tag.toLowerCase().replace(/[^a-z]/g, '')}>[{tag}]</span>} {l.text}
                  </li>
                )
              })}
            </ul>
          </section>
        </main>
      </div>

      <footer className="foot">
        <span><i className="pulse green" /> Autonomous Travel Rerouting Engine active · Safeguarding PNR {s.trip.pnr || 'IXE-MYQ-89F'}</span>
        <span className="mono">Rule Engine: OK &nbsp; Live Hedging: ENABLED &nbsp; Loss Aversion Index: 98.4%</span>
      </footer>
    </div>
  )
}