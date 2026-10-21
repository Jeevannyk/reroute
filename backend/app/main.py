"""FastAPI server for the Reroute demo. State lives in memory; POST /api/reset starts over.

Every route returns the full demo state, so the website just renders what it gets.
One disruption per demo run: press Reset to try another.
"""
import json
import re
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from . import agent, holds
from .cascade import check, gap, say, to_min
from .ranker import make_plans

DATA = Path(__file__).resolve().parents[1] / "data"
STAMP = r"^D[12]T([01]\d|2[0-3]):[0-5]\d$"


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
    state.update(now=START, played=0, replay_over=False, chance=SIGNALS["base_chance"], holds=[], declined=set(),
                 rules=dict(TRIP["rules"]), disruption=None, plans=[], applied=None, agent=None, log=[])


reset_state()


def _trip():
    return {**TRIP, "rules": state["rules"]}


def _log(text):
    state["log"].append({"at": state["now"], "text": text})


def _held_ids():
    """Seats Reroute holds or Meera already kept: both can be used in a plan."""
    return {h["option_id"] for h in state["holds"] if h["status"] in ("held", "kept")}


def _expire():
    for h in state["holds"]:
        if h["status"] == "held" and state["now"] >= h["departs"]:
            h["status"] = "expired"
            _log(f"Backup expired: {h['name']} has left.")


def _view():
    if state["applied"]:
        timeline = state["applied"]["timeline"]
    else:
        rows = check(TRIP["bookings"], state["disruption"])
        timeline = [{"id": b["id"], "name": b["name"], "type": b["type"], **rows[b["id"]]} for b in TRIP["bookings"]]
    left = 0 if state["replay_over"] else len(SIGNALS["signals"]) - state["played"]
    return {"trip": _trip(), "now": state["now"], "chance": round(state["chance"], 3),
            "signals": SIGNALS["signals"][:state["played"]], "signals_left": left, "replay_over": state["replay_over"],
            "holds": state["holds"], "disruption": state["disruption"], "timeline": timeline,
            "plans": state["plans"], "applied": state["applied"], "agent": state["agent"], "log": state["log"]}


def _problem_text(d):
    b = BOOKINGS[d["booking_id"]]
    return f"{b['name']} cancelled" if d["type"] == "cancel" else f"{b['name']} delayed by {gap(d['delay_min'])}"


def _deadline(text):
    """'09:30', 'tomorrow 09:30' or 'D2T09:30' -> 'D2T09:30' (the tour is tomorrow)."""
    m = re.search(r"(\d{1,2}):(\d{2})", str(text))
    if not m or int(m[1]) > 23 or int(m[2]) > 59:
        raise ValueError(f"bad time {text!r}, use HH:MM")
    return f"D2T{int(m[1]):02d}:{m[2]}"


def _changed_rules(changes):
    """A copy of the current rules with valid changes applied. Raises ValueError."""
    rules = dict(state["rules"])
    if changes.get("extra_spend_cap") is not None:
        cap = round(float(changes["extra_spend_cap"]))
        if not 0 <= cap <= 100000:
            raise ValueError("extra_spend_cap must be between 0 and 100000")
        rules["extra_spend_cap"] = cap
    if changes.get("reach_tour_by") is not None:
        rules["reach_tour_by"] = _deadline(changes["reach_tour_by"])
    if changes.get("allow_night_road") is not None:
        rules["allow_night_road"] = bool(changes["allow_night_road"])
    return rules


def _rules_text(rules):
    return (f"spend ≤ ₹{rules['extra_spend_cap']:,}, palace by {say(to_min(rules['reach_tour_by']))[-5:]}, "
            f"night road {'allowed' if rules['allow_night_road'] else 'not allowed'}")


def _replan():
    if state["disruption"]:
        state["plans"] = make_plans(_trip(), OPTIONS, state["disruption"], state["now"], _held_ids())
        state["applied"] = None
        state["agent"] = None  # its recommendation was for the old plans


def _set_rules(changes):
    state["rules"] = _changed_rules(changes)
    _replan()
    _log(f"Rules now: {_rules_text(state['rules'])}.")


class Disruption(BaseModel):
    type: str  # "cancel" or "delay"
    booking_id: str
    delay_min: int = Field(0, ge=0, le=1440)
    at: str = Field("D1T18:00", pattern=STAMP)  # when the news arrives


class Rules(BaseModel):
    extra_spend_cap: int | None = None
    reach_tour_by: str | None = None
    allow_night_road: bool | None = None


class AgentAsk(BaseModel):
    message: str = Field("", max_length=300)


@app.get("/api/trip")
def trip():
    return _view()


@app.post("/api/rules")
def rules(body: Rules):
    try:
        _set_rules(body.model_dump())
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    return _view()


@app.post("/api/disrupt")
def disrupt(body: Disruption):
    if state["disruption"]:
        raise HTTPException(409, "one disruption per demo run; press Reset first")
    if body.booking_id not in BOOKINGS or body.type not in ("cancel", "delay"):
        raise HTTPException(400, "unknown booking or disruption type")
    if body.type == "delay" and body.delay_min <= 0:
        raise HTTPException(400, "delay_min must be positive")
    state["now"] = max(state["now"], to_min(body.at))
    _expire()
    state["disruption"] = body.model_dump()
    if body.type == "cancel" and body.booking_id == SIGNALS["target"]:
        state["chance"] = 1.0
    _replan()
    rows = check(TRIP["bookings"], state["disruption"])
    hit = [i for i, r in rows.items() if r["status"] in ("broken", "at_risk")]
    found = f"{len(state['plans'])} plan(s) found." if state["plans"] else "Nothing to re-plan; refund due."
    _log(f"{_problem_text(state['disruption'])}. Domino check: {', '.join(hit) or 'nothing else'} affected. {found}")
    return _view()


@app.post("/api/plans/{plan_id}/apply")
def apply_plan(plan_id: str):
    plan = next((p for p in state["plans"] if p["id"] == plan_id), None)
    if not plan:
        raise HTTPException(404, "unknown plan")
    state["applied"] = plan
    used = {leg["id"] for leg in plan["legs"] if leg["source"] == "held"}
    for h in state["holds"]:
        if h["option_id"] in used and h["status"] in ("held", "kept"):
            h["status"] = "used"
    _log(f"Plan {plan_id} applied: {plan['title']} (₹{plan['extra_cost']:,} extra).")
    return _view()


@app.post("/api/signals/play")
def play_signal():
    if state["disruption"]:
        raise HTTPException(409, "already disrupted; press Reset to replay warning signs")
    if state["replay_over"] or state["played"] >= len(SIGNALS["signals"]):
        raise HTTPException(409, "warning-sign replay is over; press Reset")
    sig = SIGNALS["signals"][state["played"]]
    state["played"] += 1
    state["now"] = max(state["now"], to_min(sig["at"]))
    _expire()
    weights = [s["weight"] for s in SIGNALS["signals"][:state["played"]]]
    state["chance"] = holds.chance(SIGNALS["base_chance"], weights)
    _log(f"Warning sign: {sig['text']}. Chance your flight is cancelled: {state['chance']:.0%}. "
         f"Airline board still says On Time.")
    target = SIGNALS["target"]
    if not any(h["target"] == target and h["status"] in ("held", "kept", "used") for h in state["holds"]):
        option, why = holds.consider(_trip(), OPTIONS, target, state["chance"], state["now"],
                                     state["holds"], state["declined"])
        _log(f"Backup rule: {why}")
        if option:
            state["holds"].append(holds.new_hold(option, len(state["holds"]) + 1, state["chance"], target))
    return _view()


def _find_hold(hold_id):
    hold = next((h for h in state["holds"] if h["id"] == hold_id), None)
    if not hold:
        raise HTTPException(404, "unknown hold")
    return hold


@app.post("/api/holds/{hold_id}/keep")
def keep_hold(hold_id: str):
    _expire()
    hold = _find_hold(hold_id)
    if hold["status"] == "held":
        hold["status"] = "kept"
        _log(f"Meera kept the backup: {hold['name']} (₹{hold['price']:,} paid).")
        _replan()
    return _view()


@app.post("/api/holds/{hold_id}/cancel")
def cancel_hold(hold_id: str):
    hold = _find_hold(hold_id)
    if hold["status"] == "held":
        hold.update(status="cancelled", lost=holds.undo_cost(hold, state["now"]))
        state["declined"].add(hold["option_id"])
        _log(f"Backup cancelled by Meera: {hold['name']}. Lost ₹{hold['lost']}. It won't be held again.")
        _replan()
    return _view()


@app.post("/api/false-alarm")
def false_alarm():
    if state["disruption"]:
        raise HTTPException(409, "already disrupted; press Reset first")
    alarm = SIGNALS["false_alarm"]
    state["now"] = max(state["now"], to_min(alarm["at"]))
    state["chance"] = SIGNALS["base_chance"]
    state["replay_over"] = True
    _log(f"{alarm['text']}. Chance back to {state['chance']:.0%}.")
    for h in state["holds"]:
        if h["status"] == "held":
            h.update(status="cancelled", lost=holds.undo_cost(h, state["now"]))
            _log(f"Backup auto-cancelled: {h['name']}. Lost ₹{h['lost']}.")
    return _view()


@app.post("/api/reset")
def reset():
    reset_state()
    return _view()


def _plan_brief(p, prefix=""):
    return {"id": prefix + p["id"], "title": p["title"], "extra_cost": p["extra_cost"],
            "reach_mysuru": say(p["arrival"]), "at_palace": say(p["at_tour"]),
            "rules_broken": p["violations"], "score": p["score"],
            "steps": [f"{say(leg['start'])} {leg['name']} ({leg['source']})" for leg in p["legs"]],
            "cancel": [d["name"] for d in p["dropped"]]}


def _agent_tools(run):
    """Our code, exposed to the agent. Each tool returns (result for the AI, one-line summary for the screen)."""

    def get_status(_):
        rows = check(TRIP["bookings"], state["disruption"])
        hit = [i for i, r in rows.items() if r["status"] != "ok"]
        rules = state["rules"]
        return ({"now": say(state["now"]), "problem": _problem_text(state["disruption"]),
                 "bookings": [{"id": b["id"], "name": b["name"], "status": rows[b["id"]]["status"],
                               "reason": rows[b["id"]]["reason"]} for b in TRIP["bookings"]],
                 "rules": {"extra_spend_cap": rules["extra_spend_cap"],
                           "reach_tour_by": say(to_min(rules["reach_tour_by"])),
                           "allow_night_road": rules["allow_night_road"], "no_road_after": rules["no_road_after"]},
                 "backup_seats": [{"name": h["name"], "status": h["status"]} for h in state["holds"]]},
                f"{_problem_text(state['disruption'])}: {', '.join(hit)} hit")

    def search_plans(args):
        try:
            rules = _changed_rules(args)
        except (ValueError, TypeError) as e:
            return {"error": str(e), "plans": []}, f"Bad what-if: {e}"
        what_if = rules != state["rules"]
        plans = make_plans({**TRIP, "rules": rules}, OPTIONS, state["disruption"], state["now"], _held_ids())
        head = f"What-if ({_rules_text(rules)}): " if what_if else ""
        if not plans:
            tail = "no plans"
        elif plans[0]["violations"]:
            tail = f"{len(plans)} plan(s), every one breaks a rule (best: {'; '.join(plans[0]['violations'])})"
        else:
            tail = f"{len(plans)} plan(s), best keeps all rules: {plans[0]['title']} (₹{plans[0]['extra_cost']:,})"
        return ({"what_if": what_if, "plans": [_plan_brief(p, "whatif-" if what_if else "") for p in plans]},
                head + tail)

    def update_rules(args):
        try:
            _set_rules(args)
        except (ValueError, TypeError) as e:
            return {"error": str(e)}, f"Rule change refused: {e}"
        return ({"rules_now": _rules_text(state["rules"]), "plans": [_plan_brief(p) for p in state["plans"]]},
                f"Rules updated from your message: {_rules_text(state['rules'])}")

    def recommend_plan(args):
        pid = str(args.get("plan_id", "")).strip().upper()
        if not any(p["id"] == pid for p in state["plans"]):
            return {"error": f"no current plan {pid!r}; use an id from search_plans without what-if"}, f"Bad plan id {pid}"
        run["recommended"] = pid
        return {"ok": True}, f"Recommends plan {pid}: {args.get('reason', '')}"

    def draft_message(args):
        run["messages"].append({"to": str(args.get("to", "")), "text": str(args.get("text", ""))})
        return {"ok": True}, f"Drafted a message to {args.get('to', '')}"

    return {"get_status": get_status, "search_plans": search_plans, "update_rules": update_rules,
            "recommend_plan": recommend_plan, "draft_message": draft_message}


@app.post("/api/agent")
def run_agent(body: AgentAsk):
    if not state["disruption"]:
        raise HTTPException(400, "break something first")
    run = {"recommended": None, "messages": []}
    result = agent.run(_agent_tools(run), TRIP["traveller"], body.message.strip(),
                       on_restart=lambda: run.update(recommended=None, messages=[]))
    state["agent"] = {**result, **run, "message": body.message.strip()}
    _log(f"AI agent ({result['source']}): {len(result['steps'])} tool call(s), "
         f"recommends plan {run['recommended'] or '-'}.")
    return _view()
