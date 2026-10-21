# Reroute

AI agent for travel disruption recovery. DevHost 2026, Problem Statement **PS 4.1**.

When a flight is cancelled, the cab, hotel, train and tour that depend on it break too. Reroute finds every booking that breaks (the domino check), searches other options, scores plans against the traveller's rules (budget, time to reach the tour, no road travel at night) and shows a new itinerary. The website has six pages: Trip, Plans, Risk, Backups, Simulator and Log.

**The AI agent** (Gemini) decides which of our tools to call: check the domino effect, search plans, run what-if searches ("what if she spends ₹1,000 more?"), change the rules when the traveller types them ("I can only spend ₹2,000"), recommend a plan and draft messages to the hotel, cab and family. The tools are plain code, so every price and time comes from data, never from the AI. If there is no key, or Gemini fails or takes more than about 15 seconds in total, a rule-based run of the same tools takes over. It still applies what the traveller typed: a ₹ amount becomes the budget, "by HH:MM" becomes the time to reach the tour, and "no night travel" / "night travel ok" sets the night rule. When Gemini fails, the screen says "Gemini busy — used rule-based agent" and the raw error goes only to the server log.

**It also acts early.** Warning signs (the incoming plane fails to land, heavy rain) raise the chance the flight is cancelled. When

```
chance it breaks × money lost if we wait  >  cost to cancel the backup
```

Reroute holds a backup seat that is free or cheap to cancel. "Money lost if we wait" comes from our own planner: the best plan if the seat sells out minus the best plan if we hold it (₹3,910 − ₹2,310 = ₹1,600 in the demo). "Cost to cancel" is the worst case, the ₹100 fee after the free-cancel time (20:20). The rule is checked at the start and the log shows it waiting on a normal day (5% × ₹1,600 = ₹80 ≤ ₹100 → wait). It holds after the first warning sign (19% × ₹1,600 = ₹305 > ₹100). If the flight goes fine, the backup is cancelled before 20:20 and nothing is lost.

See [Reroute-Project-Plan.md](Reroute-Project-Plan.md) for the full idea, demo script and Q&A.

## Run it

Needs Python 3.10+ and Node 18+.

**1. Backend** (terminal 1)

```bash
cd backend
pip install -r requirements.txt
cp .env.example .env        # Windows PowerShell: copy .env.example .env
python -m uvicorn app.main:app --port 8000
```

Put your free Gemini key (https://aistudio.google.com/apikey) in `backend/.env` as `GEMINI_API_KEY=...`. It is optional: without it, the agent runs its rule-based fallback and everything else works.

**2. Frontend** (terminal 2)

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173 (it forwards `/api` to the backend on port 8000).

**Tests** (never call Gemini; the Gemini path is tested with a fake HTTP answer)

```bash
cd backend
python -m pytest -q
```

## Demo (about 2 minutes)

1. **Trip**: Meera's 5 bookings, all green. Latest activity shows the backup rule waiting (5% × ₹1,600 = ₹80 ≤ ₹100 → wait); the Risk page shows the same numbers.
2. **Risk → Play sign**: the plane fails to land; chance 5% → 19%. The airline board still says "On Time". The backup rule holds a seat on the 21:20 overnight train to Mysuru (Risk page: 19% × ₹1,600 = ₹305 > ₹100 → hold, seat held). **Backups** shows the card: ₹0 paid, ₹0 if cancelled before 20:20, at most ₹100 after. Keep playing signs: 39%, 59%, 74%.
3. **Simulator → Cancel flight → Run scenario**: the board says "Cancelled"; cab, hotel, train and tour turn red, each with a reason. The backup card says the flight was cancelled and the Trip page says "Disruption detected — choose a plan". **Plans** shows Plan A using the held seat and breaking no rule. Without the hold the seat is sold out and every plan breaks a rule.
4. **Plans → Ask AI agent**: watch its tool calls, its recommendation (AI pick) and drafted messages. Then type "I can only spend ₹2,000 extra" and ask again: the rules change and the plans re-sort.
5. **Use this plan**: the Trip page shows the new itinerary with new or backup (blue), kept (green) and dropped (grey) bookings, plus a to-do list on the plan card.
6. **Reset Replay**, then **Risk → Play sign → False alarm**: the plane lands, the backup is cancelled, ₹0 lost.

Also try **Delay flight 4 h** (the board says "Delayed 4 h 0 min") and **Cancel train**, and edit the rules on the Trip page (**Save rules**). Changing the rules re-plans: an applied plan is un-applied (the log says so) and the backup seat stays usable. One disruption per run; press Reset Replay to try another.

## Layout

```
backend/
  app/
    main.py      API routes, in-memory demo state, the agent's tools
    cascade.py   domino check: spare time, broken / at-risk
    ranker.py    search pretend options from where the traveller is, score plans
    holds.py     chance from warning signs + backup rule
    agent.py     Gemini tool-calling agent + rule-based fallback
    config.py    reads backend/.env
  data/          trip.json, options.json, signals.json (pretend data)
  tests/         test_reroute.py
  .env.example   copy to .env, add your key
frontend/
  src/App.jsx    all six pages (hash router) and their components
  src/main.jsx   mounts the app
  src/index.css  styles
  vite.config.js forwards /api to port 8000
```

## API

Every route returns the full demo state.

| Method | Path | What it does |
|---|---|---|
| GET | `/api/trip` | Current state: trip, rules, timeline, chance, airline board text, latest backup-rule numbers, holds, plans, agent result, log |
| POST | `/api/rules` | `{extra_spend_cap, reach_tour_by: "HH:MM", allow_night_road}` → re-plan if anything changed |
| POST | `/api/disrupt` | `{type: "cancel"\|"delay", booking_id, delay_min, at}` → domino check + top 3 plans (one per run) |
| POST | `/api/plans/{plan_id}/apply` | Use a plan → new timeline; the backup seat is marked used only if the plan rides on it |
| POST | `/api/signals/play` | Next warning sign → new chance, backup if the rule is true |
| POST | `/api/holds/{hold_id}/keep` | Keep a backup |
| POST | `/api/holds/{hold_id}/cancel` | Cancel a backup (it is not held again) |
| POST | `/api/false-alarm` | Plane lands → cancel held backups, end the replay, check the backup rule again |
| POST | `/api/reset` | Start over (the backup rule is checked again) |
| POST | `/api/agent` | `{message}` → run the AI agent |

## Scoring

Plans that break a rule are still shown, labelled; plans that keep every rule come first. Lower score is better:

```
score = extra cost ₹/1000 + 1.5 × hours late + 2 × changes + 3 × night road rides
```

A road ride (bus, cab) breaks the night rule if it is on the road between 23:00 and 05:00, even if it left earlier, unless the traveller allows night road travel.

## What is real and what is pretend

Bookings, prices, warning signs, their weights and backup payments are pretend so the demo is the same every time. The domino check, plan search, scoring, backup rule and the agent's tool calls are real working code.

**Never commit `backend/.env`.** It is in `.gitignore`.
