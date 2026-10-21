import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

/* ════════════════════════════════════════════════════════════
   helpers
   ════════════════════════════════════════════════════════════ */
const pad = (n) => String(n).padStart(2, '0')
const fmt = (m) => `D${Math.floor(m / 1440) + 1} ${pad(Math.floor((m % 1440) / 60))}:${pad(m % 60)}`
const rupees = (n) => '₹' + Number(n || 0).toLocaleString('en-IN')
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

// The backup seat Reroute holds, Meera kept, or the applied plan rides on
const activeBackup = (s) => s.holds.find((h) => ['held', 'kept', 'used'].includes(h.status))
const riskHot = (s) => !!activeBackup(s) || s.board !== 'On Time'

const ANALYZE_STEPS = [
  'Detecting affected segments',
  'Running domino check on dependent bookings',
  'Searching alternative routes',
  'Scoring candidate plans against rules',
]
const STEP_MS = 650
const REVEAL_MS = 1900

const SCENARIOS = [
  { label: 'Delay flight 4 h', icon: 'clock', tone: 'amber', text: 'Flight F1 slips by four hours at 18:00. Tests the domino effect on the cab, hotel and tour.',
    body: { type: 'delay', booking_id: 'F1', delay_min: 240, at: 'D1T18:00' } },
  { label: 'Cancel flight', icon: 'xc', tone: 'red', text: 'Airline cancels F1 at 18:40. The solver must find a new way to Mysuru before the tour.',
    body: { type: 'cancel', booking_id: 'F1', at: 'D1T18:40' } },
  { label: 'Cancel train', icon: 'bus', tone: 'blue', text: 'Train T1 to Mysuru is cancelled at 18:00. Tests the last leg of the journey.',
    body: { type: 'cancel', booking_id: 'T1', at: 'D1T18:00' } },
]

async function api(path, body) {
  const options = body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }
  const res = await fetch('/api' + path, options)
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.json()
}

function logTag(t) {
  if (/^\[/.test(t)) return 'SYSTEM'
  if (/Backup rule|%\s*×/.test(t)) return 'PROBABILITY'
  if (/auto-cancel/i.test(t)) return 'RESOLVE'
  if (/^Plan \w+ applied/.test(t)) return 'AUTO-ACTION'
  if (/(kept|cancelled) the backup|Meera|no longer applied/i.test(t)) return 'POLICY'
  if (/Warning sign/i.test(t)) return 'WARNING'
  if (/delayed|Domino|cancelled/i.test(t)) return 'TRIGGER'
  if (/Incoming|telemetry|Chance back|lands/i.test(t)) return 'TELEMETRY'
  return 'SYSTEM'
}
const tagClass = (t) => t.toLowerCase().replace(/[^a-z]/g, '')

/* ── tiny hash router (no dependency) ── */
const ROUTES = [
  { path: '/', label: 'Trip', icon: 'home', title: 'Trip overview', sub: 'Live itinerary, spend and risk at a glance' },
  { path: '/plans', label: 'Plans', icon: 'compass', title: 'Alternative plans', sub: 'Recovery options ranked by operational disruption' },
  { path: '/risk', label: 'Risk', icon: 'activity', title: 'Warning signs & risk', sub: 'Replay telemetry and watch the failure chance move' },
  { path: '/backups', label: 'Backups', icon: 'shield', title: 'Backup reservations', sub: 'Seats held on your behalf, with capped downside' },
  { path: '/simulator', label: 'Simulator', icon: 'flask', title: 'Disruption simulator', sub: 'Break something and watch the engine recover' },
  { path: '/log', label: 'Log', icon: 'terminal', title: 'Decision trail', sub: 'Every action and policy decision, in order' },
]
const go = (p) => { window.location.hash = p }
function useHash() {
  const get = () => window.location.hash.replace(/^#/, '') || '/'
  const [p, setP] = useState(get)
  useEffect(() => {
    const f = () => setP(get())
    window.addEventListener('hashchange', f)
    return () => window.removeEventListener('hashchange', f)
  }, [])
  return p
}

/* ════════════════════════════════════════════════════════════
   icons & small widgets
   ════════════════════════════════════════════════════════════ */
const C = 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z'
const ICONS = {
  logo: ['M8 19h8a3 3 0 0 0 0-6H8a3 3 0 0 1 0-6h8', 'M4 19a2 2 0 1 0 4 0 2 2 0 0 0-4 0z', 'M16 7a2 2 0 1 0 4 0 2 2 0 0 0-4 0z'],
  home: ['M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1v-9z'],
  flask: ['M9 3h6M10 3v6L4 19a2 2 0 0 0 2 3h12a2 2 0 0 0 2-3l-6-10V3'],
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
  x: ['M18 6L6 18M6 6l12 12'],
  checkc: [C, 'M8 12l3 3 5-6'],
  check: ['M5 13l4 4L19 7'],
  alert: ['M12 3l10 18H2L12 3z', 'M12 10v5M12 18h.01'],
  compass: [C, 'M15.5 8.5l-2 5-5 2 2-5 5-2z'],
  terminal: ['M4 17l6-6-6-6M12 19h8'],
  phone: ['M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z'],
  refresh: ['M21 12a9 9 0 1 1-3-6.7M21 4v5h-5'],
  bus: ['M5 5h14a1 1 0 0 1 1 1v10H4V6a1 1 0 0 1 1-1z', 'M4 11h16M7 19v-3M17 19v-3'],
  search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M21 21l-4.3-4.3'],
  arrow: ['M5 12h14M13 6l6 6-6 6'],
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

function Typed({ text }) {
  const [n, setN] = useState(0)
  useEffect(() => {
    setN(0)
    const id = setInterval(() => setN((v) => (v >= text.length ? (clearInterval(id), v) : v + 2)), 16)
    return () => clearInterval(id)
  }, [text])
  return <>{text.slice(0, n)}</>
}

function Empty({ icon, title, text, action }) {
  return (
    <div className="empty-state">
      <span className="empty-ic"><Icon name={icon} size={22} /></span>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  )
}

/* ════════════════════════════════════════════════════════════
   shared state (context)
   ════════════════════════════════════════════════════════════ */
const Ctx = createContext(null)
const useR = () => useContext(Ctx)

function RerouteProvider({ children }) {
  const [s, setS] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [phase, setPhase] = useState('idle')       // idle | analyzing | revealing
  const [revealed, setRevealed] = useState(999)
  const [scanning, setScanning] = useState(false)
  const [toasts, setToasts] = useState([])
  const token = useRef(0)

  const toast = useCallback((text, tone = 'ok') => {
    const id = Math.random().toString(36).slice(2)
    setToasts((t) => [...t, { id, text, tone }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3400)
  }, [])

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
      toast('Something went wrong. Check the backend and try again.', 'err')
      return null
    }
  }

  async function act(key, path, body, okMsg, minMs = 900) {
    setBusy(key)
    const r = await run(path, body, minMs)
    setBusy('')
    if (r && okMsg) toast(okMsg)
  }

  async function disrupt(body, key) {
    const my = ++token.current
    setError(''); setBusy(key)
    setPhase('analyzing'); setScanning(false); setRevealed(0)
    go('/plans')
    const t0 = Date.now()
    try {
      const next = await api('/disrupt', body)
      const wait = ANALYZE_STEPS.length * STEP_MS + 450 - (Date.now() - t0)
      if (wait > 0) await sleep(wait)
      if (token.current !== my) return
      setS(next); setPhase('revealing')
      for (let i = 1; i <= next.plans.length; i++) {
        setScanning(true)
        await sleep(REVEAL_MS)
        if (token.current !== my) return
        setScanning(false); setRevealed(i)
        await sleep(350)
        if (token.current !== my) return
      }
      toast(`${next.plans.length} plan${next.plans.length === 1 ? '' : 's'} ranked`)
    } catch (e) {
      if (token.current === my) { setError(e.message); toast('Could not compute plans.', 'err') }
    } finally {
      if (token.current === my) { setPhase('idle'); setBusy(''); setScanning(false); setRevealed(999) }
    }
  }

  async function applyPlan(id) {
    setBusy('apply' + id)
    const r = await run(`/plans/${id}/apply`, {}, 1200)
    setBusy('')
    if (r) toast(`Plan ${id} applied. Itinerary updated.`)
  }

  async function reset() {
    token.current++
    setPhase('idle'); setScanning(false); setRevealed(999)
    setBusy('reset')
    const r = await run('/reset', {}, 700)
    setBusy('')
    if (r) { toast('Replay reset'); go('/') }
  }

  const load = () => run('/trip')
  useEffect(() => { load() }, [])

  const value = {
    s, error, busy, phase, revealed, scanning, toasts,
    locked: phase !== 'idle' || !!busy,
    clearError: () => setError(''),
    load, act, disrupt, applyPlan, reset,
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/* ════════════════════════════════════════════════════════════
   shared components
   ════════════════════════════════════════════════════════════ */
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

function RecoveryPanel() {
  const { s, phase } = useR()
  const analyzing = phase === 'analyzing'
  const recovering = !!(s.applied || s.disruption)
  return (
    <section className="panel recovery">
      <div className="rec-head">
        <div>
          <div className="rec-title">
            <span className={'tag ' + (recovering ? 'blue' : 'gray')}>
              {analyzing ? 'RECOMPUTING' : recovering ? 'ACTIVE RECOVERY' : 'ITINERARY'}
            </span>
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
  )
}

function RulesPanel() {
  const { s } = useR()
  const rules = s.trip.rules
  return (
    <section className="panel">
      <div className="panel-head">
        <h2><Icon name="sliders" size={15} /> {s.trip.traveller}’s rules</h2>
        <span className="badge green">4 Active Policy Caps</span>
      </div>
      <div className="rule"><Icon name="clock" size={16} className="blue" />
        <div>Reach {rules.goal} by <code className="red">{fmt(toMin(rules.reach_tour_by))}</code>
          <small>Hard constraint · {rules.goal} Palace Tour booking</small></div></div>
      <div className="rule"><Icon name="wallet" size={16} className="blue" />
        <div>Spend at most <code>{rupees(rules.extra_spend_cap)}</code> extra
          <small>Out-of-pocket tolerance buffer</small></div></div>
      <div className="rule"><Icon name="shield" size={16} className="blue" />
        <div>{rules.allow_night_road ? 'Road travel allowed' : 'No road travel'} after <code>{rules.no_road_after}</code>
          <small>Western Ghats hazard prevention policy</small></div></div>
      <div className="rule"><Icon name="layers" size={16} className="blue" />
        <div>Backup Hedge: max <code>{rupees(rules.max_undo_cost)}</code> cancellation risk
          <small>Pooled protection cap: {rupees(rules.hold_budget)} total reserve</small></div></div>
      <RulesForm key={JSON.stringify(rules)} rules={rules} />
    </section>
  )
}

function RulesForm({ rules }) {
  const { busy, locked, act } = useR()
  const [cap, setCap] = useState(rules.extra_spend_cap)
  const [by, setBy] = useState(rules.reach_tour_by.slice(-5))
  const [night, setNight] = useState(rules.allow_night_road)
  const save = () => act('rules', '/rules', { extra_spend_cap: Number(cap), reach_tour_by: by, allow_night_road: night }, 'Rules saved')
  return (
    <div className="rule-form">
      <label>Spend at most ₹ <input type="number" min="0" step="500" value={cap} onChange={(e) => setCap(e.target.value)} /> extra</label>
      <label>Be at the palace tour by <input type="time" value={by} onChange={(e) => setBy(e.target.value)} /> tomorrow</label>
      <label><input type="checkbox" checked={night} onChange={(e) => setNight(e.target.checked)} /> Allow road travel after {rules.no_road_after}</label>
      <div><Btn className="soft" loading={busy === 'rules'} disabled={locked} onClick={save}>Save rules</Btn></div>
    </div>
  )
}

function actionIcon(a) {
  if (/^book/i.test(a)) return ['plus', 'blue']
  if (/^cancel/i.test(a)) return ['xc', 'red']
  if (/^(tell|call|inform|notify)/i.test(a)) return ['phone', 'red']
  if (/stays|kept|keep/i.test(a)) return ['checkc', 'green']
  return ['dot', 'gray']
}

function PlanCard({ plan }) {
  const { s, busy, locked, applyPlan } = useR()
  const applied = s.applied?.id === plan.id
  const applying = busy === 'apply' + plan.id
  const bad = plan.violations.length > 0
  return (
    <div className={'plan' + (bad ? ' bad' : '') + (applied ? ' applied' : '')}>
      {applied && <span className="applied-badge"><Icon name="check" size={11} /> CURRENTLY APPLIED</span>}
      <div className="plan-top">
        <div>
          <h3>Plan {plan.id}: {plan.title} <code className="score">Score {plan.score}</code>
            {s.agent?.recommended === plan.id && <span className="pick">AI pick</span>}</h3>
          <div className="plan-meta">
            Arrive Mysuru <code>{fmt(plan.arrival)}</code> · Extra cost <b>{rupees(plan.extra_cost)}</b> · {plan.changes} changes
          </div>
        </div>
        <Btn className={applied ? 'applied-btn' : ''} disabled={applied || locked} loading={applying} onClick={() => applyPlan(plan.id)}>
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
    </div>
  )
}

function AgentPanel() {
  const { s, busy, locked, act } = useR()
  const [message, setMessage] = useState('')
  const a = s.agent
  const working = busy === 'agent'
  return (
    <section className="panel">
      <div className="panel-head">
        <h2><Icon name="terminal" size={15} className="blue" /> AI agent</h2>
        {a && !a.source.startsWith('rule-based') && <span className="badge green">Gemini · {a.source}</span>}
      </div>
      <p className="muted-text">The agent picks which tools to call (domino check, plan search, what-ifs, rules) and drafts messages.
        Prices and times always come from our code.</p>
      <div className="ask">
        <input value={message} onChange={(e) => setMessage(e.target.value)} maxLength={300} disabled={locked}
          placeholder="Optional: e.g. I can only spend ₹2,000 extra" aria-label="Message to the AI agent" />
        <Btn className="primary" loading={working} disabled={locked}
          onClick={() => act('agent', '/agent', { message }, 'AI agent finished', 0)}>
          {working ? 'Agent working…' : 'Ask AI agent'}
        </Btn>
      </div>
      {a && (
        <>
          <ol className="steps">
            {a.steps.map((st, i) => <li key={i}><code>{st.tool}</code> {st.summary}</li>)}
          </ol>
          <p className="explain"><Typed text={a.reply} /></p>
          {a.messages.length > 0 && (
            <ul className="steps">
              {a.messages.map((m, i) => <li key={i}><b>Draft to {m.to}:</b> {m.text}</li>)}
            </ul>
          )}
        </>
      )}
    </section>
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
        <div><b>Recomputing itinerary</b><small>Constraint solver is checking every booking against the rules</small></div>
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

function BackupCard({ hold }) {
  const { s, locked, busy, act } = useR()
  const cost = hold.cost ?? hold.price
  if (hold.status === 'held') {
    const flightAt = fmt(toMin(s.trip.bookings.find((b) => b.id === hold.target).start)).slice(3)
    const hit = s.disruption?.booking_id === hold.target ? s.disruption : null
    return (
      <div className="backup held">
        <div className="backup-title"><Icon name="layers" size={15} /> <b>{hold.name}</b><span className="chip blue">HELD</span></div>
        <p>
          {!hit ? <>Your {flightAt} flight may be cancelled (<b>{pct(s.chance)}</b> chance). We are holding a seat for you on this route.</>
            : hit.type === 'cancel' ? <>Your {flightAt} flight was cancelled. Your backup seat on this route is ready: pick the plan that uses it.</>
            : <>Your {flightAt} flight is now {s.board.toLowerCase()}. We are still holding a seat for you on this route.</>}
          {' '}You have paid ₹0. {hold.free_cancel_until != null
            ? <>Cancel before {fmt(hold.free_cancel_until).slice(3)} and you lose ₹0; after that, at most <b>{rupees(hold.cancel_fee)}</b>.</>
            : <>If you cancel, you lose at most <b>{rupees(hold.cancel_fee)}</b>.</>}
        </p>
        <div className="buttons">
          <Btn className="primary" disabled={locked} loading={busy === 'keep' + hold.id}
            onClick={() => act('keep' + hold.id, `/holds/${hold.id}/keep`, {}, 'Backup kept as your escape path')}>Keep</Btn>
          <Btn disabled={locked} loading={busy === 'cancel' + hold.id}
            onClick={() => act('cancel' + hold.id, `/holds/${hold.id}/cancel`, {}, 'Backup cancelled')}>Cancel</Btn>
        </div>
      </div>
    )
  }
  if (hold.status === 'kept') {
    return (
      <div className="backup kept">
        <Icon name="checkc" size={18} className="green" />
        <div className="grow"><b>{hold.name}</b><small>Designated primary escape path</small></div>
        <span className="chip green">KEPT</span>
      </div>
    )
  }
  return (
    <div className="backup done">
      <div className="grow"><b>{hold.name}</b><small>{cost != null ? `Cost: ${rupees(cost)} · ` : ''}Hedge status resolved</small></div>
      <span className="chip gray">{String(hold.status).toUpperCase()}, LOST {rupees(hold.lost ?? 0)}</span>
    </div>
  )
}

/* ════════════════════════════════════════════════════════════
   pages
   ════════════════════════════════════════════════════════════ */
function Kpi({ icon, tone, label, children, sub, bar }) {
  return (
    <div className="kpi">
      <div className="kpi-top"><span className={'kpi-ic ' + tone}><Icon name={icon} size={15} /></span><span>{label}</span></div>
      <div className="kpi-val">{children}</div>
      <div className="kpi-sub">{sub}</div>
      {bar != null && <div className="kpi-bar"><i style={{ width: Math.min(bar, 100) + '%' }} /></div>}
    </div>
  )
}

function TripPage() {
  const { s } = useR()
  const rules = s.trip.rules
  const chanceNow = Math.round(useCount(s.chance * 100))
  const appliedPlan = s.plans.find((p) => p.id === s.applied?.id) || null
  const spend = appliedPlan ? appliedPlan.extra_cost : 0
  const held = s.holds.filter((h) => h.status === 'held').length
  const recent = [...s.log].reverse().slice(0, 4)
  return (
    <>
      <div className="kpis">
        <Kpi icon="clock" tone="blue" label="Arrival deadline" sub={`Reach ${rules.goal}`}>
          <code>{fmt(toMin(rules.reach_tour_by))}</code>
        </Kpi>
        <Kpi icon="wallet" tone="green" label="Extra spend" sub={`of ${rupees(rules.extra_spend_cap)} cap`}
          bar={(spend / rules.extra_spend_cap) * 100}>{rupees(spend)}</Kpi>
        <Kpi icon="activity" tone={riskHot(s) ? 'red' : 'amber'} label="Flight F1 failure risk"
          sub={`Airline: ${s.board}`} bar={s.chance * 100}>{chanceNow}%</Kpi>
        <Kpi icon="shield" tone="blue" label="Backups held" sub={`${s.holds.length} reservation${s.holds.length === 1 ? '' : 's'} total`}>{held}</Kpi>
      </div>

      <RecoveryPanel />

      <div className="cols2">
        <RulesPanel />
        <div className="stack">
          <section className="panel">
            <div className="panel-head">
              <h2><Icon name="compass" size={15} className="blue" /> Recovery status</h2>
              <a className="link" href="#/plans">View plans <Icon name="arrow" size={13} /></a>
            </div>
            {appliedPlan ? (
              <div className="applied-sum">
                <b>Plan {appliedPlan.id}: {appliedPlan.title}</b>
                <div className="plan-meta">Arrive Mysuru <code>{fmt(appliedPlan.arrival)}</code> · Extra cost <b>{rupees(appliedPlan.extra_cost)}</b> · {appliedPlan.changes} changes</div>
              </div>
            ) : s.disruption ? (
              <p className="muted-text">{s.plans.length ? 'Disruption detected — choose a plan on the Plans page.' : 'Disruption detected — nothing to re-plan, refund due.'}</p>
            ) : (
              <p className="muted-text">Running on the original itinerary. Inject a disruption in the simulator to see recovery plans.</p>
            )}
          </section>
          <section className="panel">
            <div className="panel-head">
              <h2><Icon name="terminal" size={15} /> Latest activity</h2>
              <a className="link" href="#/log">Full log <Icon name="arrow" size={13} /></a>
            </div>
            {recent.length === 0 ? <p className="muted-text">Nothing has happened yet.</p> : (
              <ul className="log compact">
                {recent.map((l, i) => {
                  const tag = logTag(l.text)
                  return <li key={i}><b>{fmt(l.at)}</b> <span className={'ltag ' + tagClass(tag)}>[{tag}]</span> {l.text}</li>
                })}
              </ul>
            )}
          </section>
        </div>
      </div>
    </>
  )
}

function PlansPage() {
  const { s, phase, revealed, scanning } = useR()
  const analyzing = phase === 'analyzing'
  const shown = analyzing ? [] : s.plans.slice(0, revealed)
  if (!analyzing && s.plans.length === 0) {
    return (
      <div className="panel">
        <Empty icon="compass" title="No recovery plans yet"
          text="Plans appear here after a disruption. Head to the simulator and break something."
          action={<a className="btn primary" href="#/simulator">Open simulator</a>} />
      </div>
    )
  }
  return (
    <div className="plans">
      <div className="plans-head">
        <h2><Icon name="compass" size={16} className="blue" /> Top alternative plans</h2>
        <span>Ranked by score (lower score = less operational disruption)</span>
      </div>
      {analyzing && <Analyzer />}
      {!analyzing && s.disruption && <AgentPanel />}
      {shown.map((p) => <PlanCard key={p.id} plan={p} />)}
      {scanning && <Skeleton n={revealed + 1} total={s.plans.length} />}
    </div>
  )
}

function RiskPage() {
  const { s, busy, locked, act } = useR()
  const chanceNow = Math.round(useCount(s.chance * 100))
  const onTime = s.board === 'On Time'
  const hot = riskHot(s)
  const backup = activeBackup(s)
  return (
    <div className="cols2 even">
      <section className="panel">
        <div className="panel-head">
          <h2><Icon name="activity" size={15} className="amber" /> Failure chance</h2>
          <span className={'badge ' + (onTime ? 'green' : 'red')}><i className="bdot" /> Airline: {s.board}</span>
        </div>
        <div className="big-risk">
          <span className={'big-num' + (hot ? ' hot' : '')}>{chanceNow}<small>%</small></span>
          <span className="big-cap">Chance flight <b>F1</b> fails</span>
        </div>
        <div className="meter">
          <div className="fill" style={{ width: pct(s.chance) }} />
        </div>
        <div className="meter-labels"><span>0%</span><span>100%</span></div>
        <p className={'risk-note ' + (backup ? 'hot' : '')}>
          Backup rule (chance × money lost if we wait vs worst-case cancel cost): {s.rule.maths
            ? <>{s.rule.maths} → <b>{s.rule.decision}</b>.</>
            : 'no backup seat fits the rules.'}
          {backup ? ` Seat held: ${backup.name}.` : ' No seat held.'}
        </p>
        <div className="buttons two">
          <Btn className="soft" loading={busy === 'signal'} disabled={locked || !s.signals_left || !!s.disruption}
            onClick={() => act('signal', '/signals/play', {}, 'Warning sign played', 1000)}>
            {busy !== 'signal' && <Icon name="play" size={12} />} Play sign ({s.signals_left} left)
          </Btn>
          <Btn loading={busy === 'alarm'} disabled={locked || !!s.disruption}
            onClick={() => act('alarm', '/false-alarm', {}, 'False alarm. Risk drops back down', 1000)}>
            {busy !== 'alarm' && <Icon name="ban" size={14} />} False alarm
          </Btn>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2><Icon name="terminal" size={15} /> Incoming telemetry stream</h2>
          <span className="live"><i className="pulse green" /> Live</span>
        </div>
        {s.signals.length === 0 && (
          <Empty icon="activity" title="No signals yet" text="Play a warning sign to start the replay." />
        )}
        <ol className="telemetry">
          {s.signals.map((g, i) => (
            <li key={g.at} className={i === s.signals.length - 1 && hot ? 'hot' : 'warm'}>
              {i + 1}. {fmt(toMin(g.at))} {g.text}
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}

function BackupsPage() {
  const { s } = useR()
  const rules = s.trip.rules
  const exposure = s.holds.filter((h) => h.status === 'held').reduce((a, h) => a + (h.cancel_fee || 0), 0)
  return (
    <div className="cols2 even">
      <section className="panel">
        <div className="panel-head"><h2><Icon name="shield" size={15} /> Autonomous backup reservations</h2></div>
        {s.holds.length === 0
          ? <Empty icon="shield" title="No backups yet" text={s.rule.maths
            ? `Reroute holds a seat when chance × money lost if we wait beats the worst-case cancel cost. Now: ${s.rule.maths} → ${s.rule.decision}.`
            : 'No backup seat fits the rules.'} />
          : s.holds.map((h) => <BackupCard key={h.id + h.status} hold={h} />)}
      </section>
      <div className="stack">
        <section className="panel">
          <div className="panel-head"><h2><Icon name="layers" size={15} /> Hedge budget</h2></div>
          <div className="kpi-val"><code>{rupees(exposure)}</code> <small className="muted-text">at risk of {rupees(rules.hold_budget)} reserve</small></div>
          <div className="kpi-bar tall"><i style={{ width: Math.min((exposure / rules.hold_budget) * 100, 100) + '%' }} /></div>
          <p className="muted-text">The most you can lose on a single backup is capped at {rupees(rules.max_undo_cost)}.</p>
        </section>
        <section className="panel">
          <div className="panel-head"><h2><Icon name="sliders" size={15} /> How it decides</h2></div>
          <p className="muted-text">When the chance of failure times the cost of being stranded beats the fee to cancel, the engine holds a backup for you at no charge. You decide to keep it or cancel it.</p>
        </section>
      </div>
    </div>
  )
}

function SimulatorPage() {
  const { s, busy, locked, disrupt, reset } = useR()
  return (
    <>
      {s.disruption && <p className="muted-text">One disruption per run. Reset the replay to try another scenario.</p>}
      <div className="scenarios">
        {SCENARIOS.map((c) => (
          <section className="panel scenario" key={c.label}>
            <span className={'kpi-ic ' + c.tone}><Icon name={c.icon} size={17} /></span>
            <h3>{c.label}</h3>
            <p className="muted-text">{c.text}</p>
            <Btn className="soft" loading={busy === c.label} disabled={locked || !!s.disruption} onClick={() => disrupt(c.body, c.label)}>
              Run scenario
            </Btn>
          </section>
        ))}
      </div>
      <section className="panel reset-panel">
        <div>
          <h3>Start over</h3>
          <p className="muted-text">Clears every disruption, plan and backup and rewinds the clock to the start of the replay.</p>
        </div>
        <Btn disabled={busy === 'reset'} loading={busy === 'reset'} onClick={reset}>
          {busy !== 'reset' && <Icon name="refresh" size={14} />} Reset replay
        </Btn>
      </section>
    </>
  )
}

function LogPage() {
  const { s } = useR()
  const [tag, setTag] = useState('ALL')
  const [q, setQ] = useState('')
  const all = s.log.map((l, i) => ({ ...l, i, tag: logTag(l.text) })).reverse()
  const tags = ['ALL', ...Array.from(new Set(all.map((e) => e.tag)))]
  const rows = all.filter((e) => (tag === 'ALL' || e.tag === tag) && e.text.toLowerCase().includes(q.toLowerCase()))
  return (
    <section className="panel logpanel">
      <div className="log-tools">
        <div className="filters">
          {tags.map((t) => (
            <button key={t} className={'fchip' + (tag === t ? ' on' : '')} onClick={() => setTag(t)}>{t}</button>
          ))}
        </div>
        <label className="search">
          <Icon name="search" size={14} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the log" aria-label="Search the log" />
        </label>
      </div>
      {rows.length === 0 ? (
        <Empty icon="terminal" title="No matching entries" text="Try a different filter or search term." />
      ) : (
        <ul className="log">
          {rows.map((e, k) => (
            <li key={e.i} className={k > 6 && tag === 'ALL' && !q ? 'old' : ''}>
              <b>{fmt(e.at)}</b> <span className={'ltag ' + tagClass(e.tag)}>[{e.tag}]</span> {e.text}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

const PAGES = { '/': TripPage, '/plans': PlansPage, '/risk': RiskPage, '/backups': BackupsPage, '/simulator': SimulatorPage, '/log': LogPage }

/* ════════════════════════════════════════════════════════════
   shell
   ════════════════════════════════════════════════════════════ */
function Boot() {
  const { error, load } = useR()
  return (
    <div className="boot">
      <div className="boot-card">
        <span className="logo big"><Icon name="logo" size={24} /></span>
        {error ? (
          <>
            <h2>Can’t reach the routing engine</h2>
            <p className="muted-text">Make sure the backend is running on port 8000, then try again.</p>
            <code className="boot-err">{error}</code>
            <Btn className="primary" onClick={load}>Retry</Btn>
          </>
        ) : (
          <>
            <h2>Connecting to the routing engine</h2>
            <p className="muted-text">Loading your trip…</p>
            <span className="spinner lg" />
          </>
        )}
      </div>
    </div>
  )
}

function Toasts() {
  const { toasts } = useR()
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={'toast ' + t.tone}>
          <Icon name={t.tone === 'err' ? 'alert' : 'checkc'} size={16} /> {t.text}
        </div>
      ))}
    </div>
  )
}

function Shell() {
  const { s, error, clearError, reset, busy, phase } = useR()
  const path = useHash()
  useEffect(() => { window.scrollTo(0, 0) }, [path])
  if (!s) return <Boot />

  const route = ROUTES.find((r) => r.path === path) || ROUTES[0]
  const Page = PAGES[route.path]
  const name = s.trip.traveller
  const initials = (name + ' V').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()
  const pnr = s.trip.pnr || 'IXE-MYQ-89F'
  const held = s.holds.filter((h) => h.status === 'held').length
  const badge = {
    '/plans': phase === 'analyzing' ? '…' : s.plans.length || null,
    '/risk': riskHot(s) ? '!' : null,
    '/backups': held || null,
  }

  return (
    <div className="app">
      <aside className="side">
        <div className="brand">
          <span className="logo"><Icon name="logo" size={18} /></span>
          <h1>Reroute</h1>
          <span className="engine">V2.4</span>
        </div>
        <nav className="nav" aria-label="Main">
          {ROUTES.map((r) => (
            <a key={r.path} href={'#' + r.path} className={'nav-item' + (r.path === route.path ? ' on' : '')}
              aria-current={r.path === route.path ? 'page' : undefined}>
              <Icon name={r.icon} size={17} />
              <span>{r.label}</span>
              {badge[r.path] != null && <em className={'nav-badge' + (badge[r.path] === '!' ? ' red' : '')}>{badge[r.path]}</em>}
            </a>
          ))}
        </nav>
        <div className="side-foot">
          <div className="user">
            <span className="avatar">{initials}</span>
            <div><b>{name} V.</b><small>PNR: {pnr}</small></div>
            <span className="tier">Business</span>
          </div>
          <div className="engine-ok"><i className="pulse green" /> Rule engine OK</div>
        </div>
      </aside>

      <div className="main-col">
        <header className="topbar">
          <div className="page-title">
            <h2>{route.title}</h2>
            <p>{route.sub}</p>
          </div>
          <div className="top-right">
            <span className="clock"><span className="pulse" /> Simulated Clock: <b>{fmt(s.now)}</b></span>
            <span className="note"><Icon name="refresh" size={13} /> Pretend data. Warning signs are a prepared replay.</span>
            <Btn disabled={busy === 'reset'} loading={busy === 'reset'} onClick={reset}>
              {busy !== 'reset' && <Icon name="refresh" size={14} />} Reset Replay
            </Btn>
          </div>
        </header>

        {error && (
          <div className="error" role="alert">
            <Icon name="alert" size={15} /> <span>{error}</span>
            <button className="x" onClick={clearError} aria-label="Dismiss"><Icon name="x" size={14} /></button>
          </div>
        )}

        <main className="page" key={route.path}>
          <Page />
        </main>

        <footer className="foot">
          <span><i className="pulse green" /> Autonomous Travel Rerouting Engine active · Safeguarding PNR {pnr}</span>
          <span className="mono">Rule Engine: OK &nbsp; Live Hedging: ENABLED &nbsp; Loss Aversion Index: 98.4%</span>
        </footer>
      </div>
      <Toasts />
    </div>
  )
}


export default function App() {
  return (
    <RerouteProvider>
      <Shell />
    </RerouteProvider>
  )
}