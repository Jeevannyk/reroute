"""FastAPI server for the Reroute demo. State lives in memory; POST /api/reset starts over.

Every route returns the full demo state, so the website just renders what it gets.
"""
import json
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from . import agent, holds
from .cascade import check, gap, to_min
from .ranker import make_plans

DATA = Path(__file__).resolve().parents[1] / "data"


def _load(name):
    return json.loads((DATA / name).read_text(encoding="utf-8"))


TRIP = _load("trip.json")
OPTIONS = _load("options.json")["options"]
SIGNALS = _load("signals.json")
BOOKINGS = {b["id"]: b for b in TRIP["bookings"]}
START = to_min("D1T17:00")

app = FastAPI(title="Reroute")
state = {}


def reset_state():
    state.clear()
    state.update(now=START, played=0, chance=SIGNALS["base_chance"], holds=[], disruption=None,
                 plans=[], applied=None, log=[])


reset_state()


def _log(text):
    state["log"].append({"at": state["now"], "text": text})


def _active_holds():
    return [h for h in state["holds"] if h["status"] == "held"]


def _view():
    if state["applied"]:
        timeline = state["applied"]["timeline"]
    else:
        rows = check(TRIP["bookings"], state["disruption"])
        timeline = [{"id": b["id"], "name": b["name"], "type": b["type"], **rows[b["id"]]} for b in TRIP["bookings"]]
    return {"trip": TRIP, "now": state["now"], "chance": round(state["chance"], 3),
            "signals": SIGNALS["signals"][:state["played"]], "signals_left": len(SIGNALS["signals"]) - state["played"],
            "holds": state["holds"], "disruption": state["disruption"], "timeline": timeline,
            "plans": state["plans"], "applied": state["applied"], "log": state["log"]}


def _problem_text(d):
    b = BOOKINGS[d["booking_id"]]
    return f"{b['name']} cancelled" if d["type"] == "cancel" else f"{b['name']} delayed by {gap(d['delay_min'])}"


class Disruption(BaseModel):
    type: str  # "cancel" or "delay"
    booking_id: str
    delay_min: int = 0
    at: str = "D1T18:00"  # when the news arrives


@app.get("/api/trip")
def trip():
    return _view()


@app.post("/api/disrupt")
def disrupt(body: Disruption):
    if body.booking_id not in BOOKINGS or body.type not in ("cancel", "delay"):
        raise HTTPException(400, "unknown booking or disruption type")
    if body.type == "delay" and body.delay_min <= 0:
        raise HTTPException(400, "delay_min must be positive")
    state["now"] = max(state["now"], to_min(body.at))
    state["disruption"] = body.model_dump()
    state["applied"] = None
    if body.type == "cancel" and body.booking_id == SIGNALS["target"]:
        state["chance"] = 1.0
    held = {h["option_id"] for h in _active_holds()}
    state["plans"] = make_plans(TRIP, OPTIONS, state["disruption"], state["now"], held)
    rows = check(TRIP["bookings"], state["disruption"])
    hit = [i for i, r in rows.items() if r["status"] in ("broken", "at_risk")]
    _log(f"{_problem_text(state['disruption'])}. Domino check: {', '.join(hit) or 'nothing else'} affected. "
         f"{len(state['plans'])} plan(s) found.")
    return _view()


@app.post("/api/plans/{plan_id}/apply")
def apply_plan(plan_id: str):
    plan = next((p for p in state["plans"] if p["id"] == plan_id), None)
    if not plan:
        raise HTTPException(404, "unknown plan")
    state["applied"] = plan
    used = {leg["id"] for leg in plan["legs"] if leg["source"] == "held"}
    for h in _active_holds():
        if h["option_id"] in used:
            h["status"] = "used"
    _log(f"Plan {plan_id} applied: {plan['title']} (₹{plan['extra_cost']:,} extra).")
    return _view()


@app.post("/api/signals/play")
def play_signal():
    if state["played"] >= len(SIGNALS["signals"]):
        raise HTTPException(400, "no more warning signs; reset to replay")
    sig = SIGNALS["signals"][state["played"]]
    state["played"] += 1
    state["now"] = max(state["now"], to_min(sig["at"]))
    weights = [s["weight"] for s in SIGNALS["signals"][:state["played"]]]
    state["chance"] = holds.chance(SIGNALS["base_chance"], weights)
    _log(f"Warning sign: {sig['text']}. Chance {SIGNALS['target']} fails: {state['chance']:.0%}. Airline board: On Time.")
    if not _active_holds() and not state["disruption"]:
        option, why = holds.consider(TRIP, OPTIONS, SIGNALS["target"], state["chance"], state["now"], _active_holds())
        _log(f"Backup rule: {why}")
        if option:
            state["holds"].append(holds.new_hold(option, len(state["holds"]) + 1, state["chance"]))
    return _view()


def _find_hold(hold_id):
    hold = next((h for h in state["holds"] if h["id"] == hold_id), None)
    if not hold:
        raise HTTPException(404, "unknown hold")
    return hold


@app.post("/api/holds/{hold_id}/keep")
def keep_hold(hold_id: str):
    hold = _find_hold(hold_id)
    if hold["status"] in ("held", "used"):
        hold["status"] = "kept"
        _log(f"Meera kept the backup: {hold['name']} (₹{hold['price']:,}).")
    return _view()


@app.post("/api/holds/{hold_id}/cancel")
def cancel_hold(hold_id: str):
    hold = _find_hold(hold_id)
    if hold["status"] == "held":
        hold.update(status="cancelled", lost=holds.undo_cost(hold, state["now"]))
        _log(f"Backup cancelled: {hold['name']}. Lost ₹{hold['lost']}.")
    return _view()


@app.post("/api/false-alarm")
def false_alarm():
    alarm = SIGNALS["false_alarm"]
    state["now"] = max(state["now"], to_min(alarm["at"]))
    state["chance"] = SIGNALS["base_chance"]
    _log(f"{alarm['text']}. Chance back to {state['chance']:.0%}.")
    for h in _active_holds():
        h.update(status="cancelled", lost=holds.undo_cost(h, state["now"]))
        _log(f"Backup auto-cancelled: {h['name']}. Lost ₹{h['lost']}.")
    return _view()


@app.post("/api/reset")
def reset():
    reset_state()
    return _view()


@app.get("/api/explain")
def explain():
    if not state["plans"]:
        raise HTTPException(400, "no plans yet; break something first")
    plan = state["plans"][0]
    return agent.explain(plan, _problem_text(state["disruption"]), TRIP["traveller"])
