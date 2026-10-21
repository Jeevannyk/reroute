"""Reroute's AI agent: Gemini decides which of our tools to call, and in what order.

The tools are our own code (domino check, plan search, rules), so every price and time comes
from data and code; the AI never makes up numbers or spends money. If Gemini is missing or busy,
a fixed rule-based run of the same tools takes over, so the demo never breaks.
The key is read from GEMINI_API_KEY in backend/.env only.
"""
import json
import time
import urllib.error
import urllib.request

from .config import setting

BASE = "https://generativelanguage.googleapis.com/v1beta"
DEFAULT_MODELS = "gemini-3.5-flash,gemini-3.1-flash-lite"
MAX_TURNS = 10

RULE_PARAMS = {
    "extra_spend_cap": {"type": "NUMBER", "description": "Most extra money the traveller will spend, in rupees"},
    "reach_tour_by": {"type": "STRING", "description": "Latest time to reach the Mysuru Palace tour tomorrow, as HH:MM"},
    "allow_night_road": {"type": "BOOLEAN", "description": "Whether road travel at night (after the cut-off) is allowed"},
}

TOOLS = [
    {"name": "get_status",
     "description": "What went wrong, which bookings are broken or at risk and why, the traveller's rules, and any backup seat held."},
    {"name": "search_plans",
     "description": "Search recovery plans, scored by code. With no arguments it uses the traveller's current rules. "
                    "Pass rule values to run a what-if search; a what-if does NOT change the rules.",
     "parameters": {"type": "OBJECT", "properties": RULE_PARAMS}},
    {"name": "update_rules",
     "description": "Change the traveller's rules and re-plan. Only call this when the traveller's own message asks for new rules.",
     "parameters": {"type": "OBJECT", "properties": RULE_PARAMS}},
    {"name": "recommend_plan",
     "description": "Recommend one plan from the current plans (not a what-if plan) to the traveller.",
     "parameters": {"type": "OBJECT", "properties": {
         "plan_id": {"type": "STRING", "description": "Plan id from search_plans without what-if, e.g. A"},
         "reason": {"type": "STRING", "description": "One short sentence"}}, "required": ["plan_id", "reason"]}},
    {"name": "draft_message",
     "description": "Draft a short message the traveller can send to someone affected (hotel, cab driver, tour, family).",
     "parameters": {"type": "OBJECT", "properties": {
         "to": {"type": "STRING"}, "text": {"type": "STRING", "description": "At most 2 sentences"}},
         "required": ["to", "text"]}},
]

SYSTEM = """You are Reroute, a travel-disruption recovery agent working for {name}.
You decide which tools to call. Every price, time and rule check comes from the tools: never invent numbers.
You cannot book, cancel or send anything yourself: you recommend a plan and draft messages, and the traveller
taps to confirm. Never say you have booked, cancelled or sent something; say "I recommend" and "I drafted".
Work like this:
1. Call get_status.
2. If the traveller's message states new rules (budget, latest time, night travel), call update_rules with exactly those.
3. Call search_plans with no arguments.
4. If no plan keeps every rule, run what-if searches relaxing ONE rule at a time (for example budget +1000,
   reach the tour 30 minutes later, allow night road travel) and note which change unlocks a plan that keeps the other rules.
5. Call recommend_plan with the best current plan id, even if every plan breaks a rule (then pick the least bad).
6. Call draft_message for each booking the recommended plan cancels, and one for family.
7. Finish with a reply to {name}: at most 3 short sentences, times as "today HH:MM" or "tomorrow HH:MM".
   Say plainly which of her bookings the plan cancels and the extra cost; state only facts from tool results.
   Mention any what-if finding as a question (e.g. "If you can spend ₹1,000 more, ... Shall I?")."""


class AgentError(RuntimeError):
    pass


def _post(model, payload, key):
    req = urllib.request.Request(
        f"{BASE}/models/{model}:generateContent",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "x-goog-api-key": key},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise AgentError(f"{model}: HTTP {e.code} {e.read().decode()[:150]}") from None
    except OSError as e:
        raise AgentError(f"{model}: {e}") from None


def _generate(models, pinned, payload, key):
    """Before the first answer, try each model; after it, stay on that model (one retry if busy)."""
    if pinned:
        try:
            return _post(pinned, payload, key), pinned
        except AgentError:
            time.sleep(2)
            return _post(pinned, payload, key), pinned
    errors = []
    for model in models:
        try:
            return _post(model, payload, key), model
        except AgentError as e:
            errors.append(str(e))
    raise AgentError("; ".join(errors))


def _gemini(tools, traveller, message, key):
    models = [m for m in setting("GEMINI_MODELS", DEFAULT_MODELS).split(",") if m]
    base = {"systemInstruction": {"parts": [{"text": SYSTEM.format(name=traveller)}]},
            "tools": [{"functionDeclarations": TOOLS}],
            "generationConfig": {"temperature": 0}}
    contents = [{"role": "user", "parts": [{"text": message or "My trip just broke. Please sort it out."}]}]
    steps, model = [], None
    for _ in range(MAX_TURNS):
        resp, model = _generate(models, model, {**base, "contents": contents}, key)
        try:
            content = resp["candidates"][0]["content"]
        except (KeyError, IndexError):
            raise AgentError(f"{model}: empty answer") from None
        contents.append(content)  # sent back as-is, so Gemini keeps its own reasoning context
        calls = [p["functionCall"] for p in content.get("parts", []) if "functionCall" in p]
        if not calls:
            reply = "".join(p.get("text", "") for p in content.get("parts", [])).strip()
            return {"source": model, "steps": steps, "reply": reply or "Done. See the recommended plan."}
        answers = []
        for call in calls:
            name, args = call["name"], call.get("args") or {}
            result, summary = tools[name](args) if name in tools else ({"error": "unknown tool"}, "unknown tool")
            steps.append({"tool": name, "args": args, "summary": summary})
            answers.append({"functionResponse": {"name": name, "response": result}})
        contents.append({"role": "user", "parts": answers})
    raise AgentError("agent did not finish in time")


def fallback(tools, traveller, note=""):
    """The same tools in a fixed order, used when Gemini is unavailable."""
    steps = []

    def call(name, args=None):
        result, summary = tools[name](args or {})
        steps.append({"tool": name, "args": args or {}, "summary": summary})
        return result

    status = call("get_status")
    plans = call("search_plans")["plans"]
    if not plans:
        return {"source": "rule-based (AI unavailable)", "steps": steps, "note": note,
                "reply": "Nothing to re-plan: " + status["problem"] + "."}
    best, hint = plans[0], ""
    if best["rules_broken"]:
        rules = status["rules"]
        h, m = map(int, rules["reach_tour_by"][-5:].split(":"))
        later = f"{(h * 60 + m + 30) // 60:02d}:{(m + 30) % 60:02d}"
        for args, words in (({"extra_spend_cap": rules["extra_spend_cap"] + 1000}, "spend ₹1,000 more"),
                            ({"reach_tour_by": later}, f"reach the palace by {later}"),
                            ({"allow_night_road": True}, "travel by road at night")):
            found = call("search_plans", args)["plans"]
            if found and not found[0]["rules_broken"]:
                hint = f" If you can {words}, \"{found[0]['title']}\" keeps every other rule. Shall I?"
                break
    call("recommend_plan", {"plan_id": best["id"], "reason": "Breaks the fewest rules with the best score"})
    for name in best["cancel"]:
        call("draft_message", {"to": name, "text": f"My plans changed ({status['problem']}), so I need to cancel this "
                                                   f"booking. Please refund what you can. - {traveller}"})
    call("draft_message", {"to": "Family", "text": f"{status['problem']}. New plan: {best['title']}, "
                                                   f"reaching Mysuru {best['reach_mysuru']}. - {traveller}"})
    reply = (f"Best plan: {best['title']}. You reach Mysuru {best['reach_mysuru']} and the palace "
             f"{best['at_palace']}, for ₹{best['extra_cost']:,} extra.")
    if best["rules_broken"]:
        reply += " It breaks: " + "; ".join(best["rules_broken"]) + "."
    return {"source": "rule-based (AI unavailable)", "steps": steps, "reply": reply + hint, "note": note}


def run(tools, traveller, message="", on_restart=lambda: None):
    """on_restart is called before the fallback takes over from a Gemini run that failed halfway."""
    key = setting("GEMINI_API_KEY")
    if not key:
        return fallback(tools, traveller, "No GEMINI_API_KEY in backend/.env")
    try:
        return _gemini(tools, traveller, message, key)
    except AgentError as e:
        on_restart()
        return fallback(tools, traveller, f"Gemini failed: {e}"[:300])
