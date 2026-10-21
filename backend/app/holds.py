"""Chance of failure from warning signs, and the backup rule.

Hold a backup when:  chance it breaks × money lost if we wait  >  cost to cancel the backup

"Money lost if we wait" comes from our own planner: what the best plan costs if the flight is
cancelled and the seat has sold out, minus what it costs if we hold the seat. Plain code decides;
the AI never spends money.
"""
import math

from .cascade import check, to_min
from .ranker import make_plans


def chance(base, weights):
    """Add sign weights in log-odds so the chance stays between 0% and 100%."""
    logit = math.log(base / (1 - base)) + sum(weights)
    return 1 / (1 + math.exp(-logit))


def _cancel(target):
    return {"type": "cancel", "booking_id": target, "delay_min": 0}


def best_money(trip, options, target, now, held_ids):
    """Rupees the best acceptable plan really costs if `target` is cancelled: extra spend plus the
    tour fee if the tour is missed. Night road plans don't count unless the traveller allows them.
    With no acceptable plan, she loses every booking that breaks."""
    rules = trip["rules"]
    plans = make_plans(trip, options, _cancel(target), now, held_ids, top=None)
    ok = [p["money"] for p in plans if not p["night"] or rules["allow_night_road"]]
    if ok:
        return min(ok)
    rows = check(trip["bookings"], _cancel(target))
    return sum(b["no_show_fee"] for b in trip["bookings"] if rows[b["id"]]["status"] == "broken")


def pick_backup(trip, options, target, now, skip=()):
    """The backup is the sell-out seat used by the best rule-keeping plan if `target` were cancelled now."""
    limit = trip["rules"]["max_undo_cost"]
    eligible = {o["id"] for o in options
                if o.get("sells_out_if_cancelled") == target and o["cancel_fee"] <= limit
                and o["id"] not in skip and to_min(o["start"]) > now}
    for plan in make_plans(trip, options, _cancel(target), now, eligible, top=None):
        if plan["violations"]:
            break
        for leg in plan["legs"]:
            if leg["source"] == "held":
                return next(o for o in options if o["id"] == leg["id"])
    return None


def loss_if_wait(trip, options, target, option, now):
    """Returns (loss, cost without the backup, cost with it)."""
    without = best_money(trip, options, target, now, frozenset())
    with_it = best_money(trip, options, target, now, {option["id"]})
    return without - with_it, without, with_it


def should_hold(p, loss, undo_cost):
    return p * loss > undo_cost


def undo_cost(hold, now):
    """Free before the free-cancel time (if the seat has one), else the cancellation fee."""
    free_until = hold["free_cancel_until"]
    return 0 if free_until is not None and now <= free_until else hold["cancel_fee"]


def consider(trip, options, target, p, now, holds, skip=()):
    """Check the rule and both limits. Returns (option to hold or None, explanation)."""
    option = pick_backup(trip, options, target, now, skip)
    if not option:
        return None, "no backup seat fits the rules"
    loss, without, with_it = loss_if_wait(trip, options, target, option, now)
    fee = option["cancel_fee"]
    maths = (f"if cancelled, best plan without a backup costs ₹{without:,}, with it ₹{with_it:,}, "
             f"so waiting loses ₹{loss:,}. {p:.0%} × ₹{loss:,} = ₹{p * loss:,.0f} vs ₹{fee} to cancel")
    if not should_hold(p, loss, fee):
        return None, f"{maths} → wait"
    blocked = sum(h["price"] for h in holds if h["status"] == "held")
    if blocked + option["price"] > trip["rules"]["hold_budget"]:
        return None, f"{maths} → rule true, but the hold budget is full"
    return option, f"{maths} → hold {option['name']}"


def new_hold(option, number, p, target):
    free = option.get("free_cancel_until")
    return {"id": f"HOLD{number}", "option_id": option["id"], "name": option["name"], "target": target,
            "price": option["price"], "cancel_fee": option["cancel_fee"],
            "free_cancel_until": to_min(free) if free else None, "departs": to_min(option["start"]),
            "status": "held", "lost": 0, "chance_when_held": round(p, 3)}
