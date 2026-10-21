# Reroute

AI agent for travel disruption recovery. DevHost 2026, Problem Statement **PS 4.1**.

When a flight is cancelled, the cab, hotel, train and tour that depend on it break too. Reroute finds every booking that breaks (the domino check), searches other options, scores plans against the traveller's rules (budget, arrival time, no late-night road travel) and shows a new itinerary.

It also acts early: warning signs (the incoming plane fails to land, heavy rain) raise the chance the flight fails. When

```
chance it breaks × money lost if we wait  >  cost to cancel the backup
```

Reroute holds a backup seat that can be cancelled for free or a small fee. If the flight goes fine, the backup is cancelled and nothing is lost. This rule is plain code. The AI never spends money or makes up prices; it only explains the best plan.

See [Reroute-Project-Plan.md](Reroute-Project-Plan.md) for the full idea.

## Run it

Needs Python 3.10+ and Node 18+.

**1. Backend** (terminal 1)

```bash
cd backend
pip install -r requirements.txt
cp .env.example .env        # Windows PowerShell: copy .env.example .env
python -m uvicorn app.main:app --port 8000
```

Optional: put your free Gemini key (https://aistudio.google.com/apikey) in `backend/.env` as `GEMINI_API_KEY=...`. Without it, the plan explanation uses a fixed sentence and everything else works.

**2. Frontend** (terminal 2)

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173

**Tests**

```bash
cd backend
python -m pytest -q
```

## Demo (about 2 minutes)

1. Meera's trip: 5 bookings, all green.
2. Click **Play warning sign**. The plane fails to land; chance goes 5% → 19%. The backup rule holds a seat on the 21:45 bus to Mysuru (₹0 paid, at most ₹50 to cancel). Keep clicking: 39%, 59%, 74%. The airline board still says "On Time".
3. Click **Cancel flight**. Cab, hotel, train and tour turn red, each with a reason. Plan A uses the held bus seat and breaks no rule. Without the hold, that seat would be sold out and every plan breaks a rule.
4. Click **Use this plan**. The timeline shows kept / new / cancelled bookings and a to-do list.
5. **Reset**, play a warning sign, then **False alarm**: the plane lands, the backup is cancelled, ₹0 lost.

Also try **Delay flight 4 h** and **Cancel train**.

## Layout

```
backend/
  app/
    main.py      API routes, in-memory demo state
    cascade.py   domino check: spare time, broken / at-risk
    ranker.py    search pretend options, score plans, top 3
    holds.py     chance from warning signs + backup rule
    agent.py     Gemini explanation (optional, falls back to a fixed sentence)
    config.py    reads backend/.env
  data/          trip.json, options.json, signals.json (pretend data)
  tests/
  .env.example   copy to .env, add your key
frontend/
  src/App.jsx    the whole page
```

## API

| Method | Path | What it does |
|---|---|---|
| GET | `/api/trip` | Current state: trip, timeline, chance, holds, plans, log |
| POST | `/api/disrupt` | `{type: "cancel"\|"delay", booking_id, delay_min, at}` → domino check + top 3 plans |
| POST | `/api/plans/{id}/apply` | Use a plan → new timeline |
| POST | `/api/signals/play` | Next warning sign → new chance, backup if the rule is true |
| POST | `/api/holds/{id}/keep` · `/cancel` | Keep or cancel a backup |
| POST | `/api/false-alarm` | Plane lands → cancel all backups |
| POST | `/api/reset` | Start over |
| GET | `/api/explain` | AI explanation of the best plan |

## Scoring

Plans that break a rule are still shown, labelled. Lower score is better:

```
score = extra cost ₹/1000 + 1.5 × hours late + 2 × changes + 3 × night road trips
```

## What is real and what is pretend

Bookings, prices, warning signs and backup payments are pretend so the demo is the same every time. The domino check, plan search, scoring and backup rule are real working code.

**Never commit `backend/.env`.** It is in `.gitignore`.
