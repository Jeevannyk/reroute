# Reroute: an AI agent that fixes broken trips

DevHost 2026 · Problem Statement 4.1 (AI agent for travel disruption recovery) · Sahyadri College, Mangaluru

> **This is for the qualification round.** We must build a small working version, record a demo video and make the slides **today**, and every team member must be able to explain it. We keep only what we can finish and explain today. Everything else goes under "Later".

---

## 1. The pitch in one line

Other apps fix your trip after the flight is cancelled. Reroute sees the problem coming, saves you a backup seat before they run out, fixes every booking that breaks, and costs you nothing if the problem never happens.

## 2. What we must hand in today

| # | Deliverable | Done when |
|---|---|---|
| 1 | Working prototype on GitHub | `git clone` + the run steps in the README work on a teammate's laptop |
| 2 | Demo video (max 4 min, aim for 2) | Shows the demo script in section 12 |
| 3 | Slides (8-slide template) | Problem Statement ID **PS 4.1** on the cover; follows section 15 |
| 4 | Everyone can explain it | Each person can say section 13 in their own words and answer the questions there |

## 3. The idea

Reroute looks at a person's whole trip: flight, cab, hotel, train and tour. These bookings depend on each other. If the flight is late, the cab, the hotel and the next train can all go wrong. That is the domino effect.

Reroute does two jobs.

1. **Fix the whole trip (the base).** When something breaks, Reroute finds every other booking that breaks because of it. It looks for other options, picks the best ones within the traveller's rules (budget, arrival time and so on), and shows a new plan.
2. **Act early, but only in ways that can be undone (the extra).** Before the airline says anything, Reroute watches for warning signs. Examples: the plane coming in to Mangaluru fails to land and goes around, or the airport weather report shows heavy rain. If the warning signs are strong enough, Reroute holds a backup seat that can be cancelled for free or a small fee. If the problem never happens, it cancels the backup.

**The main point:** Most people think help should start when the airline cancels. But by then the backup seats are already gone. It is better to act a little early, using only steps you can take back, and to make final decisions only when you are sure.

**The one rule to remember:**

```
Hold a backup when:   chance it breaks × money lost if we wait  >  cost to cancel the backup

  chance it breaks      = how likely this booking is to fail (from the warning signs)
  money lost if we wait = (best plan if the backup seat sells out) − (best plan if we hold it),
                          counting the tour fee if a plan misses the tour
  cost to cancel        = the cancellation fee on the backup

Limits: each backup can cost at most ₹200 to cancel,
        and all backups together can block at most ₹5,000.
```

This rule is checked by normal code, not by the AI. The AI never decides to spend money. We used the same idea in our FLYTRAP project: the AI never gets the final say on risky actions.

## 4. The problem and the person

**Person:** Meera, 27, works in Mangaluru. Her trip:

| # | Booking | Time |
|---|---|---|
| F1 | Flight Mangaluru (IXE) → Bengaluru (BLR) | Day 1, 18:30 → 19:35 |
| C1 | Cab from Bengaluru airport to hotel | Day 1, pickup 20:00 |
| H1 | Hotel in Bengaluru (late check-in until 23:00) | Night 1 |
| T1 | Train Bengaluru → Mysuru | Day 2, 07:00 → 09:00 |
| K1 | Mysuru palace tour (already paid) | Day 2, 10:30 |

**Her rules:** reach Mysuru by 10:30 on day 2, spend at most ₹5,000 extra, no road travel after 23:00 unless she says yes.

**When it hurts:** It is 17:50, she is at the gate, and it is raining hard. The board says "On Time". But the plane that should take her to Bengaluru has already tried to land twice and failed. The airline cancels at 18:40. By then the overnight train seats are gone. Her cab driver waits and charges her, the hotel marks her as a no-show, and she misses the train and the tour. Her travel app only told her "flight delayed".

**Others with the same problem:** pilgrim groups going to Dharmasthala and Kukke, patients travelling to hospitals in Mangaluru, and anyone crossing the Shiradi or Charmadi ghats in the monsoon.

## 5. What already exists, and what is new

| Product | What it does | What it misses |
|---|---|---|
| Flighty | Tracks the plane that will fly your route and predicts delays (paid feature) | Only warns you. Flights only. Does not book anything. |
| Hopper Disruption Guarantee | After a delay of 2+ hours or a cancellation, rebook on any airline or get a refund | Only helps after the airline announces the problem. Flights only. |
| Airline auto-rebooking | Puts you on the airline's next flight | Ignores your train, hotel, cab and tour. |
| TripIt Pro | Holds your whole itinerary, alerts you to delays and suggests alternate flights | Does not rebook the cab, hotel, train or tour. Does not hold backups early. |
| **Reroute** | Fixes the whole trip, and holds backups early in ways that can be undone | In our prototype, bookings and payments are pretend |

Sources: [Flighty delay predictions](https://flighty.com/help/delay-predictions), [TechCrunch on Flighty](https://techcrunch.com/2024/08/06/flightys-popular-flight-tracking-app-can-now-predict-delays-using-machine-learning/), [Hopper Premium Disruption Assistance](https://help.hopper.com/en_us/premium-disruption-assistance-ByKnGtdKD.md).

Why now: news reports say India's UPI is testing "Reserve Pay" for AI agents, which lets an app block money first and take it later ([TechCrunch](https://techcrunch.com/2025/10/09/india-pilots-ai-chatbot-led-e-commerce-with-chatgpt-gemini-claude-in-the-mix), [Onmanorama](https://www.onmanorama.com/news/business/2025/10/09/npci-razorpay-openai-chatgpt-payments.html)). That is exactly what backups need. Flights at Mangaluru also get diverted in heavy monsoon rain ([Udayavani](https://www.udayavani.com/english-news/flights-diverted-due-to-heavy-rains-in-mangaluru)).

## 6. How it works

```
Meera's trip (bookings + her rules)
   ↓
0. WATCH     warning signs → chance each booking fails       [extra]
   ↓
0b. BACKUP   is the rule true? → hold a backup seat           [extra]
   ↓
1. DETECT    something breaks (a button in the demo)
   ↓
2. DOMINO    find every booking that breaks because of it
   ↓
3. SEARCH    find other options for each broken booking (pretend data)
   ↓
4. CHOOSE    code scores the plans; the AI agent calls our tools, tries what-ifs, recommends one
   ↓
5. NEW PLAN  new timeline: kept / changed / cancelled / to do
```

### 6.1 Finding the domino effect

- Each booking lists which booking it needs (`depends_on`). Example: the cab needs the flight, and the hotel needs the cab.
- For each link we work out the spare time: `spare time = next booking's start − (this booking's end + time needed to get there)`.
- When a booking is late, we push the new time down the chain. Spare time below zero means **broken** (red). Under 30 minutes means **at risk** (amber).
- Reroute shows the reason in plain words, for example: "Lands 22:10, hotel check-in closes 23:00, only 50 min spare → at risk".

A simple loop over the bookings is enough for today. `networkx` is optional.

### 6.2 Choosing the best plan

- First, mark plans that break a hard rule (late for Mysuru, over budget). We still show them, labelled "breaks rule: …".
- Then score each plan. Lower is better:
  `score = (extra cost ₹ / 1000) + 1.5 × (hours late) + 2 × (number of changes) + 3 × (night travel)`
- **The AI never makes up prices or times.** All numbers come from our data and code. The AI agent (Gemini) decides which of our tools to call: check the domino effect, search plans, run what-if searches ("what if she spends ₹1,000 more?"), change her rules when she types them ("I can only spend ₹2,000"), recommend a plan and draft messages. If Gemini is not working, a rule-based run of the same tools takes over.
- **Night rule:** any road ride (bus, taxi) that is on the road after 23:00 breaks it, even if it left earlier. Overnight trains are fine.

### 6.3 Warning signs and chance of failure

For today the warning signs are **a prepared list** that plays one by one when we click "Play warning signs". (Detecting a go-around from real plane data is in "Later".)

| Warning sign | Effect |
|---|---|
| Incoming plane fails to land and climbs again (go-around) | Big jump (a second one: medium jump) |
| Plane circles and waits to land | Medium jump |
| Mangaluru airport weather report shows heavy rain | Small jump |
| Airline cancels | Chance = 100% |

**Example with Meera's flight:**

| After this sign | Chance F1 fails |
|---|---|
| Normal day | 5% |
| First go-around | about 19% |
| Second go-around | about 39% |
| Plane circling | about 59% |
| Heavy rain in weather report | about 74% |

(For coders: add weights in "log-odds" so the chance stays between 0% and 100%. Start 5%, weights +1.5, +1.0, +0.8, +0.7. Ten lines of Python.)

### 6.4 Backups

- **Money lost if we wait** comes from our own planner. If the flight is cancelled and the train seat has sold out, the best plan costs ₹3,910 (₹2,410 extra and she misses the ₹1,500 tour). If we hold the seat, the best plan costs ₹2,310. So waiting loses ₹1,600.
- **The rule:** hold when chance × ₹1,600 > ₹100 (the cost to cancel the seat), so above about 6%. On a normal day (5%) it waits. After the first go-around (19%): 19% × ₹1,600 = ₹305 > ₹100, so it holds.
- A backup is **held**, then either **kept** (Meera taps KEEP) or **cancelled** (Meera taps CANCEL, or the problem goes away).
- Payments are pretend. No real money moves.
- **Meera only sees one simple card:**
  > 19% chance your 18:30 flight gets cancelled. We are holding a seat for you on the 21:20 overnight train to Mysuru. You have paid ₹0. Free to cancel until 20:20, then at most ₹100. **KEEP** · **CANCEL**

## 7. What we build today, and what waits

### Build today

- Meera's trip as a JSON file (5 bookings + rules)
- Problem buttons on the Simulator page: "Delay flight 4 h", "Cancel flight", "Cancel train" (one per demo run, then Reset)
- Domino check: broken (red) and at-risk (amber) bookings, with reasons
- Pretend search data for the Mangaluru → Bengaluru → Mysuru trip (a few flights, buses, trains and hotels in JSON)
- Scoring and the top 3 plans; pick one → new trip: kept (green), new or backup (blue), cancelled (grey)
- **The extra:** "Play warning sign" button → chance meter rises → rule checker holds a backup → KEEP / CANCEL card
- "False alarm" button: the plane lands, the backup is cancelled, ₹0 lost
- **AI agent:** Gemini calls our tools (domino check, plan search, what-ifs, rules), recommends a plan and drafts messages (hotel, cab, family). Type "I can only spend ₹2,000" and it changes the rules and re-plans.
- Edit the rules (budget, palace time, night travel) → plans re-sort

### Nice to have today (only if the above works)

- Live Mangaluru airport weather report (one internet call)

### Later (final round)

- Detect go-arounds from real plane position data (OpenSky); learn the warning-sign weights from past flights
- Ghat road messages: official post vs WhatsApp forwards
- Several disruptions in one trip; late check-in requests to hotels
- Group mode, compensation help (check current DGCA rules), map, Kannada or voice input
- Tamper-proof log (copy `chain.py` from FLYTRAP)

## 8. How the parts connect (today's version)

```
Website (React) ──► Server (FastAPI)
                        ├─ trip + pretend search data (JSON files)
                        ├─ domino check        (cascade.py)
                        ├─ scoring             (ranker.py)
                        ├─ chance + backup rule (holds.py)   ← code decides, not the AI
                        └─ AI agent            (agent.py, Gemini calls the tools above; rule-based fallback)
```

### Server addresses (API)

| Method | Address | What it does |
|---|---|---|
| GET | `/api/trip` | Meera's trip, bookings and rules |
| POST | `/api/disrupt` | Break something: `{type, booking_id, delay_min}` → broken bookings + top 3 plans |
| POST | `/api/plans/{id}/apply` | Use a plan → new timeline |
| POST | `/api/signals/play` | Play the next warning sign → new chance, backup if the rule is true |
| POST | `/api/holds/{id}/keep` · `/cancel` | Meera keeps or cancels the backup |
| POST | `/api/false-alarm` | Plane lands → cancel all backups |
| POST | `/api/rules` | Change budget, palace time or night travel → plans re-sort |
| POST | `/api/agent` | Run the AI agent (optional message like "I can only spend ₹2,000") |
| POST | `/api/reset` | Start the demo again |

### What the data looks like

```json
{
  "traveller": "Meera",
  "rules": {"goal": "Mysuru", "reach_tour_by": "D2T10:30",
            "extra_spend_cap": 5000, "no_road_after": "23:00", "allow_night_road": false,
            "hold_budget": 5000, "max_undo_cost": 200},
  "bookings": [
    {"id": "F1", "type": "flight", "from": "IXE", "to": "BLR",
     "start": "D1T18:30", "end": "D1T19:35", "price": 4200, "depends_on": []},
    {"id": "H1", "type": "hotel", "city": "Bengaluru", "checkin_by": "D1T23:00",
     "price": 2800, "no_show_fee": 2800, "depends_on": ["C1"], "min_connection": 0}
  ]
}
```

(`D1T18:30` means day 1 at 18:30.)

## 9. Tools we use

| Part | Tool | Why |
|---|---|---|
| Website | React + Vite, plain CSS | Same as FLYTRAP; no time to set up Tailwind |
| Timeline | Simple coloured boxes in rows (our own component) | Red / amber / green is all we need |
| Server | FastAPI (Python) | Same as FLYTRAP; copy its setup |
| Data | JSON files | No database needed for today |
| AI | Gemini (free), copy the calling code from FLYTRAP `llm_agent.py` | The free tier is enough for the demo |
| Hosting | Run on a laptop, record the video | Nothing to deploy today |

**Keys:** put `GEMINI_API_KEY` only in `backend/.env`. That file is ignored by git. Each teammate uses their own key. Never commit a key.

## 10. Folder layout

```
reroute/
  backend/
    app/
      main.py        server routes
      cascade.py     domino check: spare time, broken / at-risk
      ranker.py      search pretend data, score plans, top 3
      holds.py       chance of failure + backup rule + KEEP / CANCEL
      agent.py       AI agent: Gemini calls our tools; rule-based fallback
    data/
      trip.json      Meera's trip
      options.json   pretend flights, buses, trains, hotels
      signals.json   the prepared warning signs
    tests/           test the domino check and the backup rule
    requirements.txt
    .env.example
  frontend/
    src/
      App.jsx
      components/Timeline.jsx, Buttons.jsx, PlanCards.jsx, ChanceMeter.jsx, BackupCard.jsx
  README.md          what it is + how to run it
  .gitignore         .env, venv/, __pycache__/, node_modules/, dist/
```

## 11. Today's plan (team of 4)

Times are hours from when we start.

| Time | Goal | Check |
|---|---|---|
| 0:00-0:30 | **Everyone** reads sections 3, 4 and 6 together. Agree on the JSON format. Create the repo. | Everyone can explain the domino effect and the backup rule |
| 0:30-3:00 | Server: trip, domino check, pretend search, scoring, API. Website: timeline and buttons. | "Cancel flight" shows red bookings and 3 plans |
| 3:00-5:00 | The extra: warning signs, chance meter, backup rule, KEEP / CANCEL card, false alarm | Backup appears and gets cancelled. **If not working by 5:00, stop and ship the base.** |
| 5:00-6:00 | Gemini explanation (optional), polish, README run steps, push to GitHub | A teammate can clone and run it |
| 6:00-7:00 | Record the demo video | Video under 4 minutes, saved |
| 7:00-8:00 | Slides; each person practises section 13 out loud | Slides done, everyone can explain it |

### Who does what

| Person | Job |
|---|---|
| P1 Server | `cascade.py`, `ranker.py`, API routes |
| P2 Data + backups | `trip.json`, `options.json`, `signals.json`, `holds.py` + tests |
| P3 Website | Timeline, buttons, plan cards, chance meter, backup card |
| P4 Pitch | README, slides, demo video script and recording, Gemini explanation if time |

## 12. Demo video script (about 2 minutes)

| Time | What we show |
|---|---|
| 0:00 | Meera's trip: 5 bookings, all green, her rules on the side. |
| 0:15 | Click "Play warning sign". The incoming plane fails to land. The airline still says "On Time". Chance her flight is cancelled: 5% → 19%. |
| 0:25 | The backup rule fires (read the log line): waiting would cost ₹1,600, and 19% × ₹1,600 = ₹305 is more than the ₹100 cancel fee. Reroute holds a seat on the 21:20 overnight train to Mysuru. Card: "₹0 paid, free to cancel until 20:20". Click the sign twice more: 39%, 59%. |
| 0:45 | Click "Cancel flight". Cab, hotel, train and tour turn red, each with a reason. Plan A uses the held train seat and breaks no rule. Point at plans B and C: without the backup, the seat is sold out and every plan breaks a rule. |
| 1:05 | Click "Ask AI agent". Show the steps: it checks the domino effect, searches, recommends plan A and drafts messages to the hotel, cab and family. |
| 1:25 | Type "I can only spend ₹2,000 extra" and ask again: the agent changes her rules, re-plans, and tries what-ifs to find what would unlock a plan. |
| 1:40 | Reset, play a warning sign, then click "False alarm": the plane lands, the backup is cancelled, ₹0 lost. |
| 1:50 | Closing line: "Other apps tell you your flight is delayed. Reroute saves your way out before the seats are gone, fixes the whole trip, and costs nothing if it was wrong." |

Say in the video that the data is pretend and the warning signs are a prepared replay.

## 13. Explain it in 60 seconds (everyone must know this)

> When a flight is cancelled, it's not just the flight. Your cab, hotel, train and tour all break too, like dominoes. Reroute looks at the whole trip, finds everything that breaks, and gives you the best new plan within your budget and deadline.
>
> It also acts early. Before the airline announces anything, it watches warning signs like the plane failing to land or heavy rain. If the risk is high enough, it holds a backup seat you can cancel almost for free. If the flight goes fine, it cancels the backup and you lose nothing.
>
> The AI never spends your money on its own. A simple rule in our code decides: hold a backup only when the chance of trouble times what you'd lose is more than the cost to cancel.

### Questions judges may ask

| Question | Answer |
|---|---|
| Is the data real? | No. Bookings, prices and warning signs are pretend so the demo is the same every time. Later we connect real flight, train and weather data. |
| What does the AI do? | It is the agent: it decides which of our tools to call (domino check, plan search, what-if searches, rule changes from what Meera types), recommends a plan and drafts messages. The tools are normal code, so it can't make up prices or spend money. If Gemini is down, a rule-based run of the same tools takes over. |
| Why not just wait for the cancellation? | By then the backup seats are gone. Our planner shows it: without the backup the best plan costs ₹3,910 and misses the tour; with it, ₹2,310 and on time. Holding costs at most ₹100 to undo. |
| Won't this grab seats other people need? | No hold on a normal day: at the usual 5% chance, 5% × ₹1,600 = ₹80 is less than the ₹100 cancel fee, so the rule waits. It holds only after a warning sign, one seat per trip, and cancels it when the risk goes away. |
| Where do the chances come from? | For the demo the warning-sign weights are set by hand. Later they would be learned from past flight data (for example OpenSky go-around records). |
| How is this different from Flighty or Hopper? | Flighty only warns. Hopper only helps after the cancellation, and only for flights. Reroute fixes the whole trip and acts before the cancellation. |
| How does it make money? | Travel agents and booking sites pay a monthly fee or a small fee per rescued trip. |
| Why Mangaluru? | Monsoon rain diverts flights at Mangaluru's hilltop airport, and the ghat roads close. Local travellers, pilgrims and patients get stuck often. |

## 14. Risks for today

| What could go wrong | What we do |
|---|---|
| Not enough time | Base first. If the backup feature isn't working by 5:00, ship the base and mention backups as "next step" on the slides. |
| Gemini busy or out of free requests | The agent falls back to a rule-based run of the same tools (the screen says so). Press "Ask AI agent" again to retry Gemini. |
| Teammates can't explain it | Spend the first 30 minutes on sections 3, 4 and 6 together. Everyone practises section 13 at the end. |
| Demo breaks while recording | Use the Reset button; record in short clips and join them. |
| Someone commits the API key | Key only in `backend/.env`; check `git status` before every push. |

## 15. Slides (8-slide template)

1. **Cover:** team, college, Problem Statement ID **PS 4.1**.
2. **Problem:** Meera at the gate at 17:50; five bookings falling like dominoes.
3. **Solution:** watch → backup → detect → domino → search → choose → new plan.
4. **Technical approach:** the tools table (section 9) and the backup rule.
5. **Diagram:** how the parts connect (section 8) and the flow (section 6).
6. **Impact:** red to green timeline; "₹0 paid, most you can lose ₹100"; travellers, pilgrims and patients who can't afford to lose a day.
7. **Business and growth:** fee from travel agents and booking sites; later, real airline, IRCTC and KSRTC data.
8. **Links:** GitHub repo, demo video (max 4 min).

## 16. What is real and what is pretend

This is a prototype. Bookings, prices, warning signs and backup payments are pretend. The domino check, scoring and backup rule are real working code. To work for real, Reroute would need real travel data and booking companies that offer free or cheap cancellation and "block now, charge later" payments.
