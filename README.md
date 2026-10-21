# Reroute

AI agent for travel disruption recovery. DevHost 2026, Problem Statement **PS 4.1**.

When a flight is cancelled, the cab, hotel, train and tour that depend on it break too. Reroute finds every booking that breaks (the domino check), searches other options, scores plans against the traveller's rules (budget, time to reach the tour, no road travel at night) and shows a new itinerary.

**The AI agent** (Gemini) decides which of our tools to call: check the domino effect, search plans, run what-if searches ("what if she spends ₹1,000 more?"), change the rules when the traveller types them ("I can only spend ₹2,000"), recommend a plan and draft messages to the hotel, cab and family. The tools are plain code, so every price and time comes from data, never from the AI. If Gemini is down, a rule-based run of the same tools takes over.

**It also acts early.** Warning signs (the incoming plane fails to land, heavy rain) raise the chance the flight is cancelled. When

```
chance it breaks × money lost if we wait  >  cost to cancel the backup
```

Reroute holds a backup seat that is free or cheap to cancel. "Money lost if we wait" comes from our own planner: the best plan if the seat sells out minus the best plan if we hold it (₹3,910 − ₹2,310 = ₹1,600 in the demo). So it waits on a normal day (5% × ₹1,600 = ₹80 < ₹100) and holds after the first warning sign (19% × ₹1,600 = ₹305 > ₹100). If the flight goes fine, the backup is cancelled and nothing is lost.

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

Put your free Gemini key (https://aistudio.google.com/apikey) in `backend/.env` as `GEMINI_API_KEY=...`. Without it, the agent runs its rule-based fallback and everything else works.

**2. Frontend** (terminal 2)

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173

**Tests** (never call Gemini)

```bash
cd backend
python -m pytest -q
```

## Demo (about 2 minutes)

1. Meera's trip: 5 bookings, all green.
2. **Play warning sign**: the plane fails to land; chance 5% → 19%. The log shows the backup rule; Reroute holds a seat on the 21:20 overnight train to Mysuru (₹0 paid, free to cancel until 20:20).
3. **Cancel flight**: cab, hotel, train and tour turn red, each with a reason. Plan A uses the held seat and breaks no rule. Without the hold the seat is sold out and every plan breaks a rule.
4. **Ask AI agent**: watch its tool calls, its recommendation (AI pick) and drafted messages. Then type "I can only spend ₹2,000 extra" and ask again.
5. **Use this plan**: the new trip shows kept (green), new or backup (blue) and cancelled (grey) bookings, plus a to-do list.
6. **Reset demo**, play a warning sign, then **False alarm**: the plane lands, the backup is cancelled, ₹0 lost.

Also try **Delay flight 90 min** (keeps the flight, swaps the cab), **Delay flight 4 h**, **Cancel hotel** and **Cancel train**, and edit the rules on the left. One disruption per run; press Reset to try another.

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
  tests/
  .env.example   copy to .env, add your key
frontend/
  src/App.jsx    the whole page
```

## API

| Method | Path | What it does |
|---|---|---|
| GET | `/api/trip` | Current state: trip, rules, timeline, chance, holds, plans, agent result, log |
| POST | `/api/disrupt` | `{type: "cancel"\|"delay", booking_id, delay_min, at}` → domino check + top 3 plans (one per run) |
| POST | `/api/plans/{id}/apply` | Use a plan → new timeline |
| POST | `/api/signals/play` | Next warning sign → new chance, backup if the rule is true |
| POST | `/api/holds/{id}/keep` · `/cancel` | Keep or cancel a backup (a cancelled seat is not held again) |
| POST | `/api/false-alarm` | Plane lands → cancel held backups, end the replay |
| POST | `/api/rules` | `{extra_spend_cap, reach_tour_by: "HH:MM", allow_night_road}` → plans re-sort |
| POST | `/api/agent` | `{message}` → run the AI agent |
| POST | `/api/reset` | Start over |

## Scoring

Plans that break a rule are still shown, labelled. Lower score is better:

```
score = extra cost ₹/1000 + 1.5 × hours late + 2 × changes + 3 × night road rides
```

A road ride (bus, taxi) breaks the night rule if it is on the road after 23:00, even if it left earlier.

## What is real and what is pretend

Bookings, prices, warning signs, their weights and backup payments are pretend so the demo is the same every time. The domino check, plan search, scoring, backup rule and the agent's tool calls are real working code.

**Never commit `backend/.env`.** It is in `.gitignore`.
