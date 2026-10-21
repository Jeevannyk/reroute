"""Chance of failure from warning signs, and the backup rule.

Hold a backup when:  chance it breaks × money lost if we wait  >  cost to cancel the backup
Plain code decides. The AI never spends money.
"""
import math

from .cascade import check, to_min
from .ranker import make_plans


def chance(base, weights):
    """Add sign weights in log-odds so the chance stays between 0% and 100%."""
    logit = math.log(base / (1 - base)) + sum(weights)
    return 1 / (1 + math.exp(-logit))


def pick_backup(trip, options, target, now):
    """The backup is the sell-out seat used by the best plan if `target` were cancelled right now."""
    limit = trip["rules"]["max_undo_cost"]
    eligible = {o["id"] for o in options
                if o.get("sells_out_if_cancelled") == target and o["cancel_fee"] <= limit}
    for plan in make_plans(trip, options, {"type": "cancel", "booking_id": target}, now, eligible):
        if plan["violations"]:
            break
        for leg in plan["legs"]:
            if leg["source"] == "held":
                return next(o for o in options if o["id"] == leg["id"])
    return None


def loss_if_wait(trip, target, option):
    """Fees on the bookings that would break, plus how much the backup costs once the rush starts."""
    rows = check(trip["bookings"], {"type": "cancel", "booking_id": target})
    fees = sum(b["no_show_fee"] for b in trip["bookings"] if rows[b["id"]]["status"] == "broken")
    return fees + option["surge_price"] - option["price"]


def should_hold(p, loss, undo_cost):
    return p * loss > undo_cost


def undo_cost(hold, now):
    """Free before the free-cancel time, else the cancellation fee."""
    return 0 if now <= hold["free_cancel_until"] else hold["cancel_fee"]


def consider(trip, options, target, p, now, active_holds):
    """Check the rule and both limits. Returns (option to hold or None, explanation)."""
    option = pick_backup(trip, options, target, now)
    if not option:
        return None, "No backup seat fits the rules"
    loss = loss_if_wait(trip, target, option)
    maths = f"{p:.0%} × ₹{loss:,} = ₹{p * loss:,.0f} vs ₹{option['cancel_fee']} to cancel"
    if not should_hold(p, loss, option["cancel_fee"]):
        return None, f"{maths} → wait"
    blocked = sum(h["price"] for h in active_holds)
    if blocked + option["price"] > trip["rules"]["hold_budget"]:
        return None, f"{maths} → rule true, but the hold budget is full"
    return option, f"{maths} → hold {option['name']}"


def new_hold(option, number, p):
    return {"id": f"HOLD{number}", "option_id": option["id"], "name": option["name"],
            "price": option["price"], "cancel_fee": option["cancel_fee"],
            "free_cancel_until": to_min(option["free_cancel_until"]), "status": "held", "lost": 0,
            "chance_when_held": round(p, 3)}
