"""Search the pretend options for ways to reach the goal, score each plan, return the best ones.

All prices and times come from the JSON data and this code. The AI never makes up numbers.
"""
from .cascade import check, gap, say, to_min

MAX_LEGS = 5
MAX_WAIT = 180  # longer waits at a station are only allowed at home or after a hotel night
ROAD = {"cab", "bus"}
NIGHT_END = 5 * 60  # the night window runs from no_road_after until 05:00
OWN = ("kept", "changed")


def clock(hhmm):
    hours, minutes = hhmm.split(":")
    return int(hours) * 60 + int(minutes)


def at_night(dep, arr, rules):
    """True if a ride from dep to arr overlaps any night window (no_road_after until 05:00)."""
    cutoff = clock(rules["no_road_after"])
    return any(dep < (day + 1) * 1440 + NIGHT_END and arr > day * 1440 + cutoff for day in range(-1, 3))


def goal_booking(trip):
    return next(b for b in trip["bookings"] if b["type"] == "tour")


def _position(trip, disruption, now):
    """Where the traveller is at `now`, when she is free, and which of her bookings are already done."""
    rows = check(trip["bookings"], disruption)
    place, free, done = trip["start_place"], now, []
    for b in trip["bookings"]:
        row = rows[b["id"]]
        if b["type"] == "tour" or row["status"] in ("cancelled", "broken") or row["start"] > now:
            break
        done.append(b["id"])
        place, free = b["to"], max(now, row["end"])
    return place, free, done


def _available_legs(trip, options, disruption, held_ids, done):
    """Rides and stays we could use: the traveller's own bookings plus the options still on sale."""
    target, cancelled = disruption["booking_id"], disruption["type"] == "cancel"
    legs = []
    for b in trip["bookings"]:
        if b["type"] == "tour" or b["id"] in done or (b["id"] == target and cancelled):
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
    conn = 0 if first and leg["source"] in OWN else leg["min_connection"]  # already at the gate for her own flight
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


def _routes(legs, place, t, goal, deadline, at_home):
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
        may_wait = (not path and at_home) or (prev and prev["type"] == "hotel")
        nexts = []
        for leg in legs:
            if leg["from"] != place or leg["id"] in used:
                continue
            dep = _depart(leg, t, first=not path)
            if dep is None or (not may_wait and dep - t > MAX_WAIT):
                continue
            nexts.append((leg, dep))
        own = {(leg["from"], leg["to"]) for leg, _ in nexts if leg["source"] in OWN}
        for leg, dep in nexts:
            if leg["source"] == "new" and (leg["from"], leg["to"]) in own:
                continue  # never buy a ride or room she already has and can still use
            arr = _arrive(leg, dep)
            walk(leg["to"], arr, path + [(leg, dep, arr)])

    walk(place, t, [])
    return found


def _plan(route, trip, disruption, done):
    rules = trip["rules"]
    goal = goal_booking(trip)
    target, cancelled = disruption["booking_id"], disruption["type"] == "cancel"
    used = {leg["id"] for leg, _, _ in route} | set(done)

    arrival = route[-1][2]
    at_tour = arrival + goal["min_connection"]
    late = max(0, at_tour - to_min(rules["reach_tour_by"]))
    tour_missed = at_tour > to_min(goal["start"])
    new = [leg for leg, _, _ in route if leg["source"] in ("new", "held")]
    dropped = [b for b in trip["bookings"]
               if b["type"] != "tour" and b["id"] not in used and not (b["id"] == target and cancelled)]
    extra = sum(leg["price"] for leg in new) + sum(b["cancel_fee"] for b in dropped)
    night = sum(1 for leg, dep, arr in route if leg["type"] in ROAD and at_night(dep, arr, rules))
    changes = len(new) + len(dropped)

    violations = []
    if late:
        violations.append(f"reaches the palace {gap(late)} after {say(to_min(rules['reach_tour_by']))[-5:]}")
    if extra > rules["extra_spend_cap"]:
        violations.append(f"over budget by ₹{extra - rules['extra_spend_cap']:,}")
    if night and not rules["allow_night_road"]:
        violations.append(f"road travel at night (after {rules['no_road_after']})")

    # Lower is better.
    score = extra / 1000 + 1.5 * late / 60 + 2 * changes + 3 * night

    legs = [{"id": leg["id"], "name": leg["name"], "type": leg["type"], "source": leg["source"],
             "start": dep, "end": arr, "price": leg["price"] if leg["source"] in ("new", "held") else 0}
            for leg, dep, arr in route]
    actions = []
    for leg in legs:
        if leg["source"] == "held":
            actions.append(f"Confirm your backup seat: {leg['name']} (₹{leg['price']:,})")
        elif leg["source"] == "new":
            actions.append(f"Book: {leg['name']} (₹{leg['price']:,})")
    for b in dropped:
        actions.append(f"Cancel: {b['name']} (lose ₹{b['cancel_fee']:,})")
    actions.append(f"Tell the tour you will miss the {say(to_min(goal['start']))[-5:]} start" if tour_missed
                   else "Tour stays booked")

    reasons = {"kept": "Kept", "changed": "Kept, new time"}
    timeline = [dict(leg, status=leg["source"],
                     reason=reasons.get(leg["source"]) or
                     (f"New, ₹{leg['price']:,}" if leg["source"] == "new" else f"Your backup seat, ₹{leg['price']:,}"))
                for leg in legs]
    by_id = {b["id"]: b for b in trip["bookings"]}
    for i in done:
        b = by_id[i]
        timeline.append({"id": i, "name": b["name"], "type": b["type"], "status": "kept",
                         "start": to_min(b["start"]), "end": to_min(b["end"]), "reason": "Done"})
    for b in dropped:
        timeline.append({"id": b["id"], "name": b["name"], "type": b["type"], "status": "dropped",
                         "start": to_min(b["start"]), "end": to_min(b["end"]), "reason": f"Cancel, lose ₹{b['cancel_fee']:,}"})
    if cancelled:
        b = by_id[target]
        timeline.append({"id": b["id"], "name": b["name"], "type": b["type"], "status": "cancelled",
                         "start": to_min(b["start"]), "end": to_min(b["end"]), "reason": "Cancelled by the operator, refund due"})
    timeline.append({"id": goal["id"], "name": goal["name"], "type": goal["type"],
                     "status": "broken" if tour_missed else "kept", "start": to_min(goal["start"]), "end": to_min(goal["end"]),
                     "reason": f"At the palace {say(at_tour)[-5:]}: " + ("misses the start" if tour_missed else "in time")})
    timeline.sort(key=lambda r: r["start"])

    return {"title": " + ".join(leg["name"] for leg in new) or "Keep your bookings",
            "legs": legs, "dropped": [{"id": b["id"], "name": b["name"], "fee": b["cancel_fee"]} for b in dropped],
            "arrival": arrival, "at_tour": at_tour, "late_min": late, "tour_missed": tour_missed,
            "extra_cost": extra, "money": extra + (goal["no_show_fee"] if tour_missed else 0),
            "changes": changes, "night": night, "violations": violations, "score": round(score, 2),
            "actions": actions, "timeline": timeline}


def make_plans(trip, options, disruption, now, held_ids=frozenset(), top=3):
    """Best plans: those that break no rule first, then by score. top=None returns all."""
    goal = goal_booking(trip)
    if disruption["type"] == "cancel" and disruption["booking_id"] == goal["id"]:
        return []  # the tour itself is gone: refund, nothing to replan
    place, free, done = _position(trip, disruption, now)
    legs = _available_legs(trip, options, disruption, held_ids, done)
    rules = trip["rules"]
    routes = _routes(legs, place, free, rules["goal"], to_min(rules["reach_tour_by"]),
                     at_home=place == trip["start_place"] and not done)
    plans = sorted((_plan(r, trip, disruption, done) for r in routes), key=lambda p: (len(p["violations"]), p["score"]))
    plans = plans[:top] if top else plans
    for i, plan in enumerate(plans):
        plan["id"] = chr(ord("A") + i) if i < 26 else str(i)
    return plans
