"""Search the pretend options for ways to reach the goal, score each plan, return the top 3.

All prices and times come from the JSON data and this code. The AI never makes up numbers.
"""
from .cascade import fmt, gap, to_min

MAX_LEGS = 5
MAX_WAIT = 180  # longer waits at a station are only allowed after a hotel night
ROAD = {"cab", "bus"}
NIGHT_END = 5 * 60  # road travel between no_road_after and 05:00 counts as night travel


def _available_legs(trip, options, disruption, held_ids):
    """Rides and stays we could use: Meera's own bookings plus the options still on sale."""
    target, cancelled = disruption["booking_id"], disruption["type"] == "cancel"
    legs = []
    for b in trip["bookings"]:
        if b["type"] == "tour" or (b["id"] == target and cancelled):
            continue
        leg = dict(b, source="kept", start_m=to_min(b["start"]), end_m=to_min(b["end"]))
        if b["id"] == target:  # delayed
            d = disruption["delay_min"]
            leg.update(source="changed", start_m=leg["start_m"] + d, end_m=leg["end_m"] + d)
        legs.append(leg)
    for o in options:
        if cancelled and o.get("sells_out_if_cancelled") == target and o["id"] not in held_ids:
            continue  # seat gone in the rush
        leg = dict(o, source="held" if o["id"] in held_ids else "new")
        if "start" in o:
            leg.update(start_m=to_min(o["start"]), end_m=to_min(o["end"]))
        legs.append(leg)
    return legs


def _depart(leg, t, first):
    """When we could start this leg if we are free at time t, or None if we can't make it."""
    own = leg["source"] in ("kept", "changed")
    conn = 0 if first and own else leg["min_connection"]  # she is already at the gate for her own flight
    if leg["type"] == "hotel":
        return t if t + conn <= leg["start_m"] and t < leg["end_m"] else None
    if "duration" in leg:  # taxi: leaves whenever we want
        return t + conn
    return leg["start_m"] if leg["start_m"] >= t + conn else None


def _arrive(leg, dep):
    if leg["type"] == "hotel":
        return leg["end_m"]  # checkout
    if "duration" in leg:
        return dep + leg["duration"]
    return leg["end_m"]


def _routes(legs, place, t, goal, deadline):
    """Depth-first search over legs. Returns lists of (leg, depart, arrive)."""
    found = []

    def walk(place, t, path):
        if place == goal:
            found.append(path)
            return
        if len(path) == MAX_LEGS or t > deadline + 360:
            return
        used = {leg["id"] for leg, _, _ in path}
        prev = path[-1][0] if path else None
        for leg in legs:
            if leg["from"] != place or leg["id"] in used:
                continue
            dep = _depart(leg, t, first=not path)
            if dep is None:
                continue
            if prev and prev["type"] != "hotel" and dep - t > MAX_WAIT:
                continue
            arr = _arrive(leg, dep)
            walk(leg["to"], arr, path + [(leg, dep, arr)])

    walk(place, t, [])
    return found


def _is_night(minutes, rules):
    tod = minutes % 1440
    return tod >= to_min("D1T" + rules["no_road_after"]) or tod < NIGHT_END


def _plan(route, trip, disruption):
    rules = trip["rules"]
    goal = next(b for b in trip["bookings"] if b["type"] == "tour")
    target, cancelled = disruption["booking_id"], disruption["type"] == "cancel"
    used = {leg["id"] for leg, _, _ in route}

    arrival = route[-1][2]
    late = max(0, arrival + goal["min_connection"] - to_min(rules["must_arrive"]["by"]))
    new = [leg for leg, _, _ in route if leg["source"] in ("new", "held")]
    dropped = [b for b in trip["bookings"]
               if b["type"] != "tour" and b["id"] not in used and not (b["id"] == target and cancelled)]
    extra = sum(leg["price"] for leg in new) + sum(b["cancel_fee"] for b in dropped)
    night = sum(1 for leg, dep, _ in route if leg["type"] in ROAD and _is_night(dep, rules))
    changes = len(new) + len(dropped)

    violations = []
    if late:
        violations.append(f"late for the tour by {gap(late)}")
    if extra > rules["extra_spend_cap"]:
        violations.append(f"over budget by ₹{extra - rules['extra_spend_cap']:,}")
    if night:
        violations.append(f"road travel after {rules['no_road_after']}")

    # Lower is better.
    score = extra / 1000 + 1.5 * late / 60 + 2 * changes + 3 * night

    legs = [{"id": leg["id"], "name": leg["name"], "type": leg["type"], "source": leg["source"],
             "start": dep, "end": arr, "price": leg["price"] if leg["source"] in ("new", "held") else 0}
            for leg, dep, arr in route]
    actions = []
    for leg in legs:
        if leg["source"] == "held":
            actions.append(f"Use your held seat: {leg['name']} (₹{leg['price']:,})")
        elif leg["source"] == "new":
            actions.append(f"Book: {leg['name']} (₹{leg['price']:,})")
    for b in dropped:
        actions.append(f"Cancel: {b['name']} (lose ₹{b['cancel_fee']:,})")
    actions.append("Tour stays booked" if not late else f"Tell the tour you will be {gap(late)} late")

    timeline = [dict(leg, status=leg["source"], reason={"kept": "Kept", "changed": "Kept, new time",
                                                         "new": f"New, ₹{leg['price']:,}",
                                                         "held": f"Your held seat, ₹{leg['price']:,}"}[leg["source"]])
                for leg in legs]
    for b in dropped:
        timeline.append({"id": b["id"], "name": b["name"], "type": b["type"], "status": "dropped",
                         "start": to_min(b["start"]), "end": to_min(b["end"]), "reason": f"Cancel, lose ₹{b['cancel_fee']:,}"})
    if cancelled:
        b = next(b for b in trip["bookings"] if b["id"] == target)
        timeline.append({"id": b["id"], "name": b["name"], "type": b["type"], "status": "cancelled",
                         "start": to_min(b["start"]), "end": to_min(b["end"]), "reason": "Cancelled by the operator, refund due"})
    timeline.append({"id": goal["id"], "name": goal["name"], "type": goal["type"],
                     "status": "broken" if late else "kept", "start": to_min(goal["start"]), "end": to_min(goal["end"]),
                     "reason": f"Late by {gap(late)}" if late else f"Arrive Mysuru {fmt(arrival)[3:]}, in time"})
    timeline.sort(key=lambda r: r["start"])

    return {"title": " + ".join(leg["name"] for leg in new) or "Keep your bookings",
            "legs": legs, "dropped": [{"id": b["id"], "name": b["name"], "fee": b["cancel_fee"]} for b in dropped],
            "arrival": arrival, "late_min": late, "extra_cost": extra, "changes": changes, "night": night,
            "violations": violations, "score": round(score, 2), "actions": actions, "timeline": timeline}


def make_plans(trip, options, disruption, now, held_ids=frozenset(), top=3):
    """Top plans: those that break no rule first, then by score."""
    legs = _available_legs(trip, options, disruption, held_ids)
    goal = trip["rules"]["must_arrive"]
    routes = _routes(legs, trip["start_place"], now, goal["place"], to_min(goal["by"]))
    plans = sorted((_plan(r, trip, disruption) for r in routes), key=lambda p: (len(p["violations"]), p["score"]))
    for label, plan in zip("ABCDEFGH", plans[:top]):
        plan["id"] = label
    return plans[:top]
