from fastapi.testclient import TestClient

from app import holds
from app.cascade import check, to_min
from app.main import OPTIONS, SIGNALS, TRIP, app
from app.ranker import make_plans

CANCEL_F1 = {"type": "cancel", "booking_id": "F1", "delay_min": 0}


def statuses(disruption=None):
    return {k: v["status"] for k, v in check(TRIP["bookings"], disruption).items()}


def test_normal_day_all_ok():
    assert set(statuses().values()) == {"ok"}


def test_cancelled_flight_breaks_whole_chain():
    assert statuses(CANCEL_F1) == {"F1": "cancelled", "C1": "broken", "H1": "broken", "T1": "broken", "K1": "broken"}


def test_delay_breaks_cab_and_hotel_only():
    s = statuses({"type": "delay", "booking_id": "F1", "delay_min": 240})
    assert s == {"F1": "delayed", "C1": "broken", "H1": "broken", "T1": "ok", "K1": "ok"}


def test_small_delay_is_at_risk():
    assert statuses({"type": "delay", "booking_id": "F1", "delay_min": 15})["C1"] == "at_risk"


def test_chance_matches_plan():
    weights, got = [], []
    for s in SIGNALS["signals"]:
        weights.append(s["weight"])
        got.append(round(holds.chance(0.05, weights), 2))
    assert got == [0.19, 0.39, 0.59, 0.74]


def test_backup_rule():
    assert holds.should_hold(0.19, 6000, 50)
    assert not holds.should_hold(0.005, 6000, 50)


def test_backup_respects_undo_limit():
    # B2 costs ₹300 to cancel (> ₹200 limit), so the backup must be B1.
    assert holds.pick_backup(TRIP, OPTIONS, "F1", to_min("D1T17:20"))["id"] == "B1"


def test_without_backup_every_plan_breaks_a_rule():
    plans = make_plans(TRIP, OPTIONS, CANCEL_F1, to_min("D1T18:40"))
    assert plans and all(p["violations"] for p in plans)


def test_held_backup_gives_clean_plan():
    best = make_plans(TRIP, OPTIONS, CANCEL_F1, to_min("D1T18:40"), {"B1"})[0]
    assert best["violations"] == [] and best["legs"][0]["id"] == "B1"


def test_api_demo_flow():
    c = TestClient(app)
    c.post("/api/reset")
    s = c.post("/api/signals/play").json()
    assert s["holds"][0]["status"] == "held"
    s = c.post("/api/disrupt", json={**CANCEL_F1, "at": "D1T18:40"}).json()
    assert s["plans"][0]["violations"] == []
    s = c.post("/api/plans/A/apply").json()
    assert s["holds"][0]["status"] == "used"
    assert c.get("/api/explain").json()["text"]


def test_api_false_alarm_costs_nothing():
    c = TestClient(app)
    c.post("/api/reset")
    c.post("/api/signals/play")
    s = c.post("/api/false-alarm").json()
    assert s["holds"][0]["status"] == "cancelled" and s["holds"][0]["lost"] == 0
