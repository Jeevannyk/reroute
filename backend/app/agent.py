"""Optional: Gemini explains the best plan in simple words.

Numbers come from our code, never from the AI. If Gemini is missing or busy, we return a fixed sentence.
The key is read from GEMINI_API_KEY in backend/.env only.
"""
import json
import urllib.request

from .cascade import fmt
from .config import setting

BASE = "https://generativelanguage.googleapis.com/v1beta"
DEFAULT_MODELS = "gemini-3.5-flash,gemini-3.1-flash-lite"

PROMPT = """You help a stressed traveller named {name}. Explain this recovery plan in at most 3 short,
plain sentences. Use only the facts below. Do not invent prices, times or bookings.

What went wrong: {problem}
Plan: {plan}"""


def fallback(plan):
    text = (f"Plan {plan['id']}: {plan['title']}. You reach Mysuru at {fmt(plan['arrival'])[3:]}, "
            f"it costs ₹{plan['extra_cost']:,} extra and changes {plan['changes']} booking(s).")
    if plan["violations"]:
        text += " Warning: " + "; ".join(plan["violations"]) + "."
    return text


def _facts(plan):
    return json.dumps({
        "title": plan["title"],
        "steps": [f"{fmt(l['start'])} {l['name']} ({l['source']})" for l in plan["legs"]],
        "cancel": [f"{d['name']} (lose ₹{d['fee']})" for d in plan["dropped"]],
        "extra_cost_rupees": plan["extra_cost"],
        "arrive_mysuru": fmt(plan["arrival"]),
        "rules_broken": plan["violations"],
    }, ensure_ascii=False)


def explain(plan, problem, traveller):
    key = setting("GEMINI_API_KEY")
    if not key:
        return {"text": fallback(plan), "source": "fallback", "note": "No GEMINI_API_KEY in backend/.env"}
    payload = {"contents": [{"role": "user", "parts": [
        {"text": PROMPT.format(name=traveller, problem=problem, plan=_facts(plan))}]}]}
    errors = []
    for model in [m for m in setting("GEMINI_MODELS", DEFAULT_MODELS).split(",") if m]:
        req = urllib.request.Request(
            f"{BASE}/models/{model}:generateContent",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json", "x-goog-api-key": key},
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.load(r)
            return {"text": data["candidates"][0]["content"]["parts"][0]["text"].strip(), "source": model}
        except (OSError, KeyError, IndexError, ValueError) as e:
            errors.append(f"{model}: {e}")
    return {"text": fallback(plan), "source": "fallback", "note": "; ".join(errors)[:300]}
