import io
import json
import urllib.error

import pytest
from fastapi.testclient import TestClient

from app import agent, holds
from app.cascade import check, to_min
from app.main import OPTIONS, SIGNALS, TRIP, app
from app.ranker import at_night, make_plans

CANCEL_F1 = {"type": "cancel", "booking_id": "F1", "delay_min": 0}
TR = next(o for o in OPTIONS if o["id"] == "TR")


@pytest.fixture(autouse=True)
def no_live_ai(monkeypatch):
    """Tests never call Gemini: the agent always takes the rule-based path."""
    monkeypatch.setattr(agent, "setting", lambda name, default=None: None if name == "GEMINI_API_KEY" else default)


@pytest.fixture
def c():
    client = TestClient(app)
    client.post("/api/reset")
    return client


def statuses(disruption=None):
    return {k: v["status"] for k, v in check(TRIP["bookings"], disruption).items()}


def plans(disruption, at, held=frozenset(), rules=None):
    trip = {**TRIP, "rules": {**TRIP["rules"], **(rules or {})}}
    return make_plans(trip, OPTIONS, disruption, to_min(at), held)


# Domino check

def test_normal_day_all_ok():
    assert set(statuses().values()) == {"ok"}


def test_cancelled_flight_breaks_whole_chain():
    assert statuses(CANCEL_F1) == {"F1": "cancelled", "C1": "broken", "H1": "broken", "T1": "broken", "K1": "broken"}


def test_delay_90_breaks_cab_and_puts_hotel_at_risk():
    s = statuses({"type": "delay", "booking_id": "F1", "delay_min": 90})
    assert s == {"F1": "delayed", "C1": "broken", "H1": "at_risk", "T1": "ok", "K1": "ok"}


# Night rule

def test_overnight_road_ride_counts_as_night():
    rules = TRIP["rules"]
    assert at_night(to_min("D1T21:45"), to_min("D2T05:30"), rules)  # overnight bus
    assert at_night(to_min("D1T22:00"), to_min("D2T01:00"), rules)
    assert not at_night(to_min("D1T21:25"), to_min("D1T22:40"), rules)
    assert not at_night(to_min("D2T06:15"), to_min("D2T09:15"), rules)


def test_no_clean_plan_uses_night_road():
    for d, at in ((CANCEL_F1, "D1T18:40"), ({"type": "delay", "booking_id": "F1", "delay_min": 240}, "D1T18:00"),
                  ({"type": "cancel", "booking_id": "T1", "delay_min": 0}, "D1T18:00")):
        for p in plans(d, at, {"TR"}):
            if not p["violations"]:
                assert p["night"] == 0, p["title"]


# Plans

def test_without_backup_every_plan_breaks_a_rule():
    found = plans(CANCEL_F1, "D1T18:40")
    assert found and all(p["violations"] for p in found)


def test_held_backup_gives_clean_plan():
    best = plans(CANCEL_F1, "D1T18:40", {"TR"})[0]
    assert best["violations"] == [] and best["legs"][0]["id"] == "TR"


def test_short_delay_keeps_the_flight():
    best = plans({"type": "delay", "booking_id": "F1", "delay_min": 90}, "D1T18:00")[0]
    assert [leg["id"] for leg in best["legs"]] == ["F1", "C2", "H1", "T1"] and best["extra_cost"] == 1200


def test_hotel_cancel_finds_another_hotel():
    best = plans({"type": "cancel", "booking_id": "H1", "delay_min": 0}, "D1T18:00")[0]
    assert best["violations"] == [] and "H3" in [leg["id"] for leg in best["legs"]]


def test_never_buys_a_ride_she_already_has():
    for p in plans({"type": "cancel", "booking_id": "T1", "delay_min": 0}, "D1T18:00"):
        ids = [leg["id"] for leg in p["legs"]]
        assert not ("C2" in ids and "C1" not in ids and "F1" in ids), ids


def test_plans_start_where_she_is():
    best = plans({"type": "cancel", "booking_id": "T1", "delay_min": 0}, "D2T06:30")[0]
    assert best["legs"][0]["id"] == "C3" and best["violations"] == []


def test_cancelled_tour_means_nothing_to_replan():
    assert plans({"type": "cancel", "booking_id": "K1", "delay_min": 0}, "D1T18:00") == []


def test_tighter_budget_changes_the_plans():
    assert plans(CANCEL_F1, "D1T18:40", {"TR"}, {"extra_spend_cap": 2000})[0]["violations"]


# Backup rule

def test_chance_matches_plan():
    weights, got = [], []
    for s in SIGNALS["signals"]:
        weights.append(s["weight"])
        got.append(round(holds.chance(0.05, weights), 2))
    assert got == [0.19, 0.39, 0.59, 0.74]


def test_loss_comes_from_the_planner():
    loss, without, with_it = holds.loss_if_wait(TRIP, OPTIONS, "F1", TR, to_min("D1T17:20"))
    assert (loss, without, with_it) == (1600, 3910, 2310)


def test_no_hold_on_a_normal_day_but_hold_after_a_warning():
    assert not holds.should_hold(0.05, 1600, TR["cancel_fee"])
    assert holds.should_hold(0.19, 1600, TR["cancel_fee"])


def test_backup_respects_night_rule_and_undo_limit():
    # B1 (sleeper bus) breaks the night rule; B2 costs ₹300 to cancel (> ₹200). So the backup is the train.
    assert holds.pick_backup(TRIP, OPTIONS, "F1", to_min("D1T17:20"))["id"] == "TR"


def test_seat_without_free_cancel_does_not_crash():
    hold = holds.new_hold(next(o for o in OPTIONS if o["id"] == "B2"), 1, 0.5, "F1")
    assert holds.undo_cost(hold, to_min("D1T18:00")) == 300


# API

def test_api_demo_flow(c):
    s = c.post("/api/signals/play").json()
    assert s["holds"][0]["option_id"] == "TR" and s["holds"][0]["status"] == "held"
    s = c.post("/api/disrupt", json={**CANCEL_F1, "at": "D1T18:40"}).json()
    assert s["plans"][0]["violations"] == []
    s = c.post("/api/agent", json={"message": ""}).json()
    assert s["agent"]["recommended"] == "A" and s["agent"]["steps"][0]["tool"] == "get_status"
    assert s["agent"]["messages"]
    s = c.post("/api/plans/A/apply").json()
    assert s["holds"][0]["status"] == "used"


def test_kept_seat_is_still_used_after_cancel(c):
    c.post("/api/signals/play")
    c.post("/api/holds/HOLD1/keep")
    s = c.post("/api/disrupt", json={**CANCEL_F1, "at": "D1T18:40"}).json()
    assert s["plans"][0]["legs"][0]["id"] == "TR" and s["plans"][0]["violations"] == []


def test_no_duplicate_or_repeat_holds(c):
    c.post("/api/signals/play")
    c.post("/api/holds/HOLD1/keep")
    s = c.post("/api/signals/play").json()
    assert len(s["holds"]) == 1
    c.post("/api/reset")
    c.post("/api/signals/play")
    c.post("/api/holds/HOLD1/cancel")
    s = c.post("/api/signals/play").json()
    assert all(h["option_id"] != "TR" or h["status"] == "cancelled" for h in s["holds"])


def test_false_alarm_costs_nothing_and_ends_replay(c):
    c.post("/api/signals/play")
    s = c.post("/api/false-alarm").json()
    assert s["holds"][0]["status"] == "cancelled" and s["holds"][0]["lost"] == 0
    assert s["signals_left"] == 0
    assert c.post("/api/signals/play").status_code == 409


def test_hold_expires_when_the_seat_leaves(c):
    c.post("/api/signals/play")
    s = c.post("/api/disrupt", json={**CANCEL_F1, "at": "D1T22:00"}).json()
    assert s["holds"][0]["status"] == "expired"


def test_one_disruption_per_run(c):
    c.post("/api/disrupt", json={**CANCEL_F1, "at": "D1T18:40"})
    assert c.post("/api/disrupt", json={"type": "cancel", "booking_id": "T1"}).status_code == 409


def test_bad_input_is_rejected(c):
    assert c.post("/api/disrupt", json={**CANCEL_F1, "at": "tomorrow"}).status_code == 422
    assert c.post("/api/disrupt", json={**CANCEL_F1, "at": "D1T25:99"}).status_code == 422
    assert c.post("/api/rules", json={"reach_tour_by": "soon"}).status_code == 400


def test_rules_endpoint_replans(c):
    c.post("/api/signals/play")
    c.post("/api/disrupt", json={**CANCEL_F1, "at": "D1T18:40"})
    s = c.post("/api/rules", json={"extra_spend_cap": 2000}).json()
    assert s["trip"]["rules"]["extra_spend_cap"] == 2000 and s["plans"][0]["violations"]


def broken_flight(c, keep=False):
    """Warning sign (backup held), optionally kept, then the flight is cancelled."""
    c.post("/api/signals/play")
    if keep:
        c.post("/api/holds/HOLD1/keep")
    return c.post("/api/disrupt", json={**CANCEL_F1, "at": "D1T18:40"}).json()


def test_replan_after_apply_keeps_the_used_seat(c):
    broken_flight(c)
    assert c.post("/api/plans/A/apply").json()["holds"][0]["status"] == "used"
    s = c.post("/api/rules", json={"reach_tour_by": "11:00"}).json()
    assert s["applied"] is None and s["holds"][0]["status"] == "held"
    assert s["plans"][0]["legs"][0]["id"] == "TR" and s["plans"][0]["violations"] == []
    assert "no longer applied" in s["log"][-2]["text"]
    c.post("/api/plans/A/apply")
    s = c.post("/api/agent", json={"message": ""}).json()  # no rule change: the plan stays applied
    assert s["applied"]["id"] == "A" and s["agent"]["recommended"] == "A"
    assert "best keeps all rules" in next(st["summary"] for st in s["agent"]["steps"] if st["tool"] == "search_plans")


def test_applying_another_plan_releases_the_seat(c):
    broken_flight(c)
    c.post("/api/plans/A/apply")
    s = c.post("/api/plans/B/apply").json()
    assert "TR" not in [leg["id"] for leg in s["applied"]["legs"]] and s["holds"][0]["status"] == "held"
    c.post("/api/reset")
    broken_flight(c, keep=True)
    assert c.post("/api/plans/A/apply").json()["holds"][0]["status"] == "used"
    assert c.post("/api/plans/B/apply").json()["holds"][0]["status"] == "kept"


def test_board_follows_the_disruption(c):
    assert c.get("/api/trip").json()["board"] == "On Time"
    delay = {"type": "delay", "booking_id": "F1", "delay_min": 90, "at": "D1T18:00"}
    assert c.post("/api/disrupt", json=delay).json()["board"] == "Delayed 1 h 30 min"
    c.post("/api/reset")
    assert c.post("/api/disrupt", json={**CANCEL_F1, "at": "D1T18:40"}).json()["board"] == "Cancelled"
    c.post("/api/reset")
    assert c.post("/api/disrupt", json={"type": "cancel", "booking_id": "T1"}).json()["board"] == "On Time"


def test_backup_rule_is_shown_at_start(c):
    s = c.post("/api/reset").json()
    assert s["holds"] == [] and len(s["log"]) == 1
    text = s["log"][0]["text"]
    assert text.startswith("Backup rule:") and "5% × ₹1,600 = ₹80 ≤ ₹100" in text and "free until 20:20" in text
    assert text.endswith("→ wait")


# Agent

def test_fallback_applies_rules_from_the_message(c):
    assert agent.rules_from("must arrive by 08:00, no night travel") == {"reach_tour_by": "08:00", "allow_night_road": False}
    assert agent.rules_from("night travel ok") == {"allow_night_road": True}
    assert agent.rules_from("my 18:30 flight, overnight train is fine") == {}
    broken_flight(c)
    s = c.post("/api/agent", json={"message": "I can only spend ₹2000"}).json()
    assert s["trip"]["rules"]["extra_spend_cap"] == 2000
    assert s["agent"]["steps"][0]["tool"] == "update_rules" and s["plans"][0]["violations"]


def fake_gemini(monkeypatch, answers):
    """Replace the HTTP call to Gemini with canned answers. Returns the request bodies sent."""
    sent = []

    def urlopen(req, timeout):
        assert req.full_url.startswith(agent.BASE) and timeout <= agent.TIME_LIMIT
        sent.append(json.loads(req.data))
        answer = answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return io.BytesIO(json.dumps(answer).encode())

    monkeypatch.setattr(agent, "setting", lambda name, default=None: "test-key" if name == "GEMINI_API_KEY" else default)
    monkeypatch.setattr(agent.urllib.request, "urlopen", urlopen)
    return sent


def model_says(*parts):
    return {"candidates": [{"content": {"role": "model", "parts": list(parts)}}]}


def test_gemini_path_runs_the_tools_it_asks_for(c, monkeypatch):
    sent = fake_gemini(monkeypatch, [
        model_says({"functionCall": {"name": "get_status", "args": {}}}),
        model_says({"functionCall": {"name": "recommend_plan", "args": {"plan_id": "A", "reason": "Keeps every rule"}}}),
        model_says({"text": "I recommend plan A."}),
    ])
    broken_flight(c)
    a = c.post("/api/agent", json={"message": "help"}).json()["agent"]
    assert a["source"] == agent.DEFAULT_MODELS.split(",")[0] and a["reply"] == "I recommend plan A."
    assert [st["tool"] for st in a["steps"]] == ["get_status", "recommend_plan"] and a["recommended"] == "A"
    answer = sent[1]["contents"][-1]["parts"][0]["functionResponse"]
    assert answer["name"] == "get_status" and answer["response"]["problem"] == "Flight Mangaluru → Bengaluru cancelled"


def test_gemini_error_shows_a_short_note(c, monkeypatch, caplog):
    def busy():
        return urllib.error.HTTPError(agent.BASE, 429, "Too Many Requests", {},
                                      io.BytesIO(b'{"error": {"code": 429, "status": "RESOURCE_EXHAUSTED"}}'))
    fake_gemini(monkeypatch, [busy(), busy()])  # both models busy
    broken_flight(c)
    a = c.post("/api/agent", json={"message": ""}).json()["agent"]
    assert a["source"].startswith("rule-based") and a["note"] == agent.BUSY_NOTE and a["recommended"] == "A"
    assert "RESOURCE_EXHAUSTED" in caplog.text  # the raw error goes to the server log only


def test_gemini_wait_is_capped(c, monkeypatch):
    sent = fake_gemini(monkeypatch, [])
    monkeypatch.setattr(agent, "TIME_LIMIT", 0)
    broken_flight(c)
    a = c.post("/api/agent", json={"message": ""}).json()["agent"]
    assert sent == [] and a["source"].startswith("rule-based") and a["note"] == agent.BUSY_NOTE


def test_rule_numbers_are_in_the_state(c):
    s = c.post("/api/reset").json()
    assert s["rule"] == {"chance": 0.05, "maths": "5% × ₹1,600 = ₹80 ≤ ₹100", "fee": 100, "decision": "wait"}
    s = c.post("/api/signals/play").json()
    assert s["rule"]["maths"] == "19% × ₹1,600 = ₹305 > ₹100" and s["rule"]["decision"] == "hold"
    assert s["rule"]["maths"] in s["log"][-1]["text"] and s["holds"][0]["status"] == "held"
    s = c.post("/api/false-alarm").json()
    assert s["rule"]["decision"] == "wait" and s["holds"][0]["status"] == "cancelled"
