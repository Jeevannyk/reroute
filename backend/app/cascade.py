"""Domino check: push a disruption down the chain of bookings and mark broken / at-risk ones."""

AT_RISK_MIN = 30
WORDS = {"flight": "departs", "bus": "departs", "train": "departs", "cab": "pickup at",
         "hotel": "check-in closes", "tour": "starts"}


def to_min(stamp):
    """'D2T07:30' -> minutes since day 1 00:00."""
    day, clock = stamp[1:].split("T")
    hours, minutes = clock.split(":")
    return (int(day) - 1) * 1440 + int(hours) * 60 + int(minutes)


def fmt(minutes):
    day, rest = divmod(minutes, 1440)
    return f"D{day + 1} {rest // 60:02d}:{rest % 60:02d}"


def say(minutes):
    """Plain words for people and the AI: 'today 18:30' / 'tomorrow 07:00'."""
    return ("today " if minutes < 1440 else "tomorrow ") + fmt(minutes)[3:]


def gap(minutes):
    hours, mins = divmod(abs(minutes), 60)
    return f"{hours} h {mins} min" if hours else f"{mins} min"


def check(bookings, disruption=None):
    """Return {booking_id: {status, reason, start, end}} after one disruption.

    Bookings must be listed in order (parents before children).
    Spare time = this booking's start - (parent's end + time needed to get there).
    Below 0 -> broken, under 30 min -> at risk.
    """
    out = {}
    for b in bookings:
        start, end = to_min(b["start"]), to_min(b["end"])
        row = {"status": "ok", "reason": "On time", "start": start, "end": end}
        out[b["id"]] = row

        if disruption and disruption["booking_id"] == b["id"]:
            if disruption["type"] == "cancel":
                row.update(status="cancelled", reason="Cancelled by the operator")
            else:
                d = disruption["delay_min"]
                row.update(status="delayed", reason=f"Delayed by {gap(d)}", start=start + d, end=end + d)
            continue

        if not b["depends_on"]:
            continue
        lost = [p for p in b["depends_on"] if out[p]["status"] == "cancelled" or out[p].get("lost")]
        if lost:
            row.update(status="broken", lost=True, reason=f"Needs {lost[0]}, which is {out[lost[0]]['status']}")
            continue

        ready = max(out[p]["end"] for p in b["depends_on"]) + b["min_connection"]
        spare = start - ready
        words = f"Ready {fmt(ready)[3:]}, {WORDS[b['type']]} {fmt(start)[3:]}"
        if spare < 0:
            row.update(status="broken", reason=f"{words}: {gap(spare)} late")
            if b["type"] != "hotel":  # a missed ride happens later at best; a hotel's checkout does not move
                row.update(start=ready, end=ready + end - start)
        elif spare < AT_RISK_MIN:
            row.update(status="at_risk", reason=f"{words}: only {gap(spare)} spare")
        else:
            row["reason"] = f"{words}: {gap(spare)} spare"
    return out
