from __future__ import annotations

from copy import deepcopy

from app.db.models import Bot, ChatSession

# BR-04: every dimension across every preset defaults ``cta_enabled`` to
# False. The BANT preset's need/timeline dimensions already documented why
# (interrogative pill questions read as qualification fishing to modern B2B
# visitors — Drift/Intercom Fin/HubSpot all default this off; background LLM
# extraction still scores the dimension without an intrusive prompt). MEDDIC/
# CHAMP/GPCTBA+C&I previously left several dimensions on by default with no
# equivalent rationale — an oversight from the presets being authored
# independently, not a deliberate framework-specific design choice. Customers
# who want the more interrogative flow can still flip individual dimensions
# on per-bot from the admin Qualification page.
PRESET_FRAMEWORKS = {
    "bant": {
        "framework": "bant",
        "need": {
            "enabled": True,
            "weight": 25,
            "options": [
                {"label": "Just browsing", "score": 5},
                {"label": "Exploring solutions", "score": 10},
                {"label": "Active pain point", "score": 15},
                {"label": "Urgent need", "score": 20},
                {"label": "Critical / blocking", "score": 25},
            ],
            # Need-tier pill questions ("what's your situation?") feel like
            # qualification fishing to modern B2B visitors — Drift, Intercom Fin,
            # and HubSpot all default these OFF. Scoring still happens in the
            # background via post-chat LLM extraction in ``qualification_service``
            # so leads still get tiered; the visitor just doesn't get an
            # intrusive pill prompt mid-conversation. Customers who want the
            # aggressive flow can flip this back to True in the admin UI.
            "cta_enabled": False,
            "cta_prompt": "What best describes your situation?",
        },
        "timeline": {
            "enabled": True,
            "weight": 25,
            "options": [
                {"label": "No timeline", "score": 5},
                {"label": "6-12 months", "score": 10},
                {"label": "3-6 months", "score": 15},
                {"label": "1-3 months", "score": 20},
                {"label": "This month", "score": 25},
            ],
            # Timeline pill defaulted OFF too. The conversational utility ("so
            # I can tune my answer to your horizon") is real but most visitors
            # read it as another qualification chip — the background LLM
            # extraction at ``qualification_service`` still infers timeline
            # from the conversation text, so the tier signal is preserved
            # while the visitor gets a cleaner, less interrogated experience.
            # Customers who specifically want the chip can flip it on per-bot
            # from the admin Qualification page.
            "cta_enabled": False,
            "cta_prompt": "When are you looking to get started?",
        },
        "authority": {
            "enabled": True,
            "weight": 25,
            "options": [
                {"label": "Researching for someone", "score": 5},
                {"label": "Team member / influencer", "score": 10},
                {"label": "Manager / champion", "score": 15},
                {"label": "Decision maker", "score": 20},
                {"label": "Budget owner", "score": 25},
            ],
            "cta_enabled": False,
            "cta_prompt": "What's your role in this decision?",
        },
        "budget": {
            "enabled": True,
            "weight": 25,
            "options": [
                {"label": "No budget yet", "score": 5},
                {"label": "Under $1K/mo", "score": 10},
                {"label": "$1K-5K/mo", "score": 15},
                {"label": "$5K-20K/mo", "score": 20},
                {"label": "$20K+/mo", "score": 25},
            ],
            "cta_enabled": False,
            "cta_prompt": "Do you have a budget range in mind?",
        },
        "thresholds": {"mql": 30, "sal": 55, "sql": 75},
        "conversation_order": ["need", "timeline", "authority", "budget"],
        "decay": {"enabled": True, "timeline_decay_per_30d": 5, "need_decay_per_30d": 3},
    },
    "meddic": {
        "framework": "meddic",
        "metrics": {
            "enabled": True,
            "weight": 17,
            "options": [
                {"label": "No measurable impact defined", "score": 4},
                {"label": "Early KPI hypotheses", "score": 8},
                {"label": "Clear baseline metrics", "score": 12},
                {"label": "Target KPIs committed", "score": 17},
                {"label": "Board-level quantified outcomes", "score": 21},
            ],
            "cta_enabled": False,
            "cta_prompt": "What measurable outcomes matter most to your team?",
        },
        "economic_buyer": {
            "enabled": True,
            "weight": 17,
            "options": [
                {"label": "Unknown buyer", "score": 4},
                {"label": "Potential sponsor identified", "score": 8},
                {"label": "Budget owner known", "score": 12},
                {"label": "Direct access to economic buyer", "score": 17},
                {"label": "Economic buyer actively driving deal", "score": 21},
            ],
            "cta_enabled": False,
            "cta_prompt": "Who ultimately owns budget approval for this initiative?",
        },
        "decision_criteria": {
            "enabled": True,
            "weight": 17,
            "options": [
                {"label": "Criteria unknown", "score": 4},
                {"label": "High-level requirements only", "score": 8},
                {"label": "Defined evaluation criteria", "score": 12},
                {"label": "Weighted criteria in shortlist", "score": 17},
                {"label": "Your strengths map to top criteria", "score": 21},
            ],
            "cta_enabled": False,
            "cta_prompt": "What criteria are you using to evaluate vendors?",
        },
        "decision_process": {
            "enabled": True,
            "weight": 17,
            "options": [
                {"label": "Process unknown", "score": 4},
                {"label": "Informal process", "score": 8},
                {"label": "Documented process with stages", "score": 12},
                {"label": "Clear stakeholders and timeline", "score": 17},
                {"label": "Procurement path and approvals confirmed", "score": 21},
            ],
            "cta_enabled": False,
            "cta_prompt": "How does your team typically run the buying process?",
        },
        "identify_pain": {
            "enabled": True,
            "weight": 16,
            "options": [
                {"label": "Pain unclear", "score": 4},
                {"label": "General friction described", "score": 8},
                {"label": "Specific pain with examples", "score": 12},
                {"label": "Urgent pain with business impact", "score": 17},
                {"label": "Critical pain tied to executive goals", "score": 21},
            ],
            "cta_enabled": False,
            "cta_prompt": "What is the biggest challenge you need to solve first?",
        },
        "champion": {
            "enabled": True,
            "weight": 16,
            "options": [
                {"label": "No internal champion", "score": 4},
                {"label": "Interested contact", "score": 8},
                {"label": "Influencer willing to advocate", "score": 12},
                {"label": "Strong champion with access", "score": 17},
                {"label": "Executive champion actively selling internally", "score": 21},
            ],
            "cta_enabled": False,
            "cta_prompt": "Who is most likely to champion this internally?",
        },
        "thresholds": {"mql": 30, "sal": 55, "sql": 75},
        "conversation_order": [
            "identify_pain",
            "metrics",
            "economic_buyer",
            "decision_criteria",
            "decision_process",
            "champion",
        ],
        "decay": {"enabled": True, "timeline_decay_per_30d": 5, "need_decay_per_30d": 3},
    },
    "champ": {
        "framework": "champ",
        "challenges": {
            "enabled": True,
            "weight": 25,
            "options": [
                {"label": "No clear challenge", "score": 5},
                {"label": "Minor pain points", "score": 10},
                {"label": "Recurring operational challenge", "score": 15},
                {"label": "High-impact challenge", "score": 20},
                {"label": "Critical challenge requiring urgent change", "score": 25},
            ],
            "cta_enabled": False,
            "cta_prompt": "What challenge is most urgent for your team right now?",
        },
        "authority": {
            "enabled": True,
            "weight": 25,
            "options": [
                {"label": "No buying authority", "score": 5},
                {"label": "Influencer only", "score": 10},
                {"label": "Manager recommendation role", "score": 15},
                {"label": "Decision committee member", "score": 20},
                {"label": "Final decision authority", "score": 25},
            ],
            "cta_enabled": False,
            "cta_prompt": "Who is involved in making the final decision?",
        },
        "money": {
            "enabled": True,
            "weight": 25,
            "options": [
                {"label": "No budget allocated", "score": 5},
                {"label": "Exploring funding options", "score": 10},
                {"label": "Budget range discussed", "score": 15},
                {"label": "Budget approved in principle", "score": 20},
                {"label": "Budget allocated and available", "score": 25},
            ],
            "cta_enabled": False,
            "cta_prompt": "Do you already have a budget range in mind?",
        },
        "prioritization": {
            "enabled": True,
            "weight": 25,
            "options": [
                {"label": "Not prioritized", "score": 5},
                {"label": "Backlog item", "score": 10},
                {"label": "Quarterly priority", "score": 15},
                {"label": "Near-term priority", "score": 20},
                {"label": "Top priority initiative", "score": 25},
            ],
            "cta_enabled": False,
            "cta_prompt": "Where does this initiative sit in your current priorities?",
        },
        "thresholds": {"mql": 30, "sal": 55, "sql": 75},
        "conversation_order": ["challenges", "authority", "money", "prioritization"],
        "decay": {"enabled": True, "timeline_decay_per_30d": 5, "need_decay_per_30d": 3},
    },
    "gpctba_ci": {
        "framework": "gpctba_ci",
        "goals": {
            "enabled": True,
            "weight": 14,
            "options": [
                {"label": "No defined goals", "score": 4},
                {"label": "General goals", "score": 8},
                {"label": "Specific goals", "score": 11},
                {"label": "Strategic measurable goals", "score": 14},
            ],
            "cta_enabled": False,
            "cta_prompt": "What outcomes are you targeting this quarter?",
        },
        "plans": {
            "enabled": True,
            "weight": 14,
            "options": [
                {"label": "No clear plan", "score": 4},
                {"label": "Early plan draft", "score": 8},
                {"label": "Documented implementation plan", "score": 11},
                {"label": "Resourced plan with owners", "score": 14},
            ],
            "cta_enabled": False,
            "cta_prompt": "How are you planning to roll this out internally?",
        },
        "challenges": {
            "enabled": True,
            "weight": 14,
            "options": [
                {"label": "Challenges unclear", "score": 4},
                {"label": "Known blockers", "score": 8},
                {"label": "High-impact blockers", "score": 11},
                {"label": "Critical blockers with urgency", "score": 14},
            ],
            "cta_enabled": False,
            "cta_prompt": "What is currently blocking progress the most?",
        },
        "timeline": {
            "enabled": True,
            "weight": 14,
            "options": [
                {"label": "No timeline", "score": 4},
                {"label": "Tentative timeline", "score": 8},
                {"label": "Planned timeline", "score": 11},
                {"label": "Committed launch timeline", "score": 14},
            ],
            "cta_enabled": False,
            "cta_prompt": "When do you need this in place?",
        },
        "budget": {
            "enabled": True,
            "weight": 14,
            "options": [
                {"label": "No budget", "score": 4},
                {"label": "Budget being explored", "score": 8},
                {"label": "Budget range known", "score": 11},
                {"label": "Budget approved", "score": 14},
            ],
            "cta_enabled": False,
            "cta_prompt": "What budget envelope are you working with?",
        },
        "authority": {
            "enabled": True,
            "weight": 15,
            "options": [
                {"label": "Authority unknown", "score": 4},
                {"label": "Influencer identified", "score": 8},
                {"label": "Decision group identified", "score": 11},
                {"label": "Decision authority confirmed", "score": 14},
            ],
            "cta_enabled": False,
            "cta_prompt": "Who signs off on this purchase?",
        },
        "consequences": {
            "enabled": True,
            "weight": 15,
            "options": [
                {"label": "Low impact if delayed", "score": 4},
                {"label": "Moderate impact", "score": 8},
                {"label": "Significant business impact", "score": 11},
                {"label": "Severe consequences if unresolved", "score": 14},
            ],
            "cta_enabled": False,
            "cta_prompt": "What happens if this is not solved in time?",
        },
        "thresholds": {"mql": 30, "sal": 55, "sql": 75},
        "conversation_order": ["goals", "plans", "challenges", "timeline", "budget", "authority", "consequences"],
        "decay": {"enabled": True, "timeline_decay_per_30d": 5, "need_decay_per_30d": 3},
    },
}


# Probe-question variants, keyed ``"framework:dimension"``. Each list rewords the
# SAME ask so a re-probed dimension never shows the identical sentence twice in a
# row (see ``pick_probe_variant``). Index 0 is the canonical default and MUST
# match the dimension's ``cta_prompt`` above — that lets the picker tell a stock
# prompt (safe to rotate) from a customer's custom wording (left untouched). Pill
# ``options``/scores are unaffected: only the intro wording rotates.
CTA_PROMPT_VARIANTS: dict[str, list[str]] = {
    # ── BANT ──────────────────────────────────────────────────────────────
    "bant:need": [
        "What best describes your situation?",
        "Where are you at with this right now?",
        "How would you describe where things stand?",
        "What's prompting you to look into this?",
        "Which of these feels closest for you?",
        "How pressing is this for you at the moment?",
        "What's driving your interest here?",
    ],
    "bant:timeline": [
        "When are you looking to get started?",
        "What's your timeline looking like?",
        "How soon are you hoping to move on this?",
        "Any target date in mind for getting going?",
        "When would you ideally have this in place?",
        "Is there a timeframe you're working toward?",
        "Where does this sit on your calendar?",
    ],
    "bant:authority": [
        "What's your role in this decision?",
        "How are you involved in the decision here?",
        "Where do you sit in the decision-making?",
        "Are you the one driving this, or helping evaluate?",
        "What part do you play in choosing a solution?",
        "Who's steering this on your end?",
        "How does this decision get made on your side?",
    ],
    "bant:budget": [
        "Do you have a budget range in mind?",
        "Any budget figure you're working with?",
        "Have you set aside a budget for this?",
        "What kind of budget are you thinking?",
        "Is there a spend range you have in mind?",
        "Where are you at on budget for this?",
        "Do you have a number in mind for this?",
    ],
    # ── MEDDIC ────────────────────────────────────────────────────────────
    "meddic:metrics": [
        "What measurable outcomes matter most to your team?",
        "Which results are you most trying to move?",
        "What numbers would make this a win for you?",
        "How will you measure success here?",
        "What impact are you hoping to see?",
        "Which metrics matter most on your side?",
        "What outcome would make this worthwhile?",
    ],
    "meddic:economic_buyer": [
        "Who ultimately owns budget approval for this initiative?",
        "Who signs off on spend for something like this?",
        "Who holds the budget on your side?",
        "Who has final say on the budget here?",
        "Who approves funding for this kind of thing?",
        "Where does budget approval sit on your team?",
        "Who owns the purse strings for this?",
    ],
    "meddic:decision_criteria": [
        "What criteria are you using to evaluate vendors?",
        "What matters most as you compare options?",
        "How are you deciding between solutions?",
        "What are you weighing in your evaluation?",
        "Which factors carry the most weight for you?",
        "What would make one option stand out?",
        "What's on your checklist when comparing vendors?",
    ],
    "meddic:decision_process": [
        "How does your team typically run the buying process?",
        "What does the buying process look like on your side?",
        "How do purchases like this usually get made?",
        "Walk me through how you'd move this forward?",
        "What steps does a decision like this go through?",
        "How does your team usually approach buying?",
        "What's the path from here to a yes on your end?",
    ],
    "meddic:identify_pain": [
        "What is the biggest challenge you need to solve first?",
        "What's the main problem you're trying to fix?",
        "What's hurting most right now?",
        "Where's the biggest pain point for you?",
        "What would you most want to solve first?",
        "What's the core issue you're up against?",
        "What brought you here today?",
    ],
    "meddic:champion": [
        "Who is most likely to champion this internally?",
        "Who on your side would push this forward?",
        "Who'd be the internal advocate for this?",
        "Who would help drive this with your team?",
        "Who's most bought-in on your end?",
        "Who would carry this internally?",
        "Who's likely to back this on the inside?",
    ],
    # ── CHAMP ─────────────────────────────────────────────────────────────
    "champ:challenges": [
        "What challenge is most urgent for your team right now?",
        "What's the most pressing issue for your team?",
        "What's top of the pile to fix right now?",
        "Which challenge needs solving soonest?",
        "What's the biggest thing on your team's plate?",
        "Where's the urgency for your team right now?",
        "What problem is most urgent on your side?",
    ],
    "champ:authority": [
        "Who is involved in making the final decision?",
        "Who has a say in the final call?",
        "Who else weighs in on a decision like this?",
        "Who makes the final call on your side?",
        "Who's in the room when this gets decided?",
        "Who signs off in the end?",
        "Who's part of deciding this?",
    ],
    "champ:money": [
        "Do you already have a budget range in mind?",
        "Any budget in mind so far?",
        "Have you scoped a budget for this yet?",
        "What budget are you working with?",
        "Is there a spend range you're considering?",
        "Where are you on budget for this?",
        "Do you have a figure in mind yet?",
    ],
    "champ:prioritization": [
        "Where does this initiative sit in your current priorities?",
        "How high a priority is this for you right now?",
        "Where does this rank on your list?",
        "How urgent is this among everything else?",
        "Is this a now thing or a later thing?",
        "How near the top of the list is this?",
        "Where does this fall in your priorities?",
    ],
    # ── GPCTBA & C&I ──────────────────────────────────────────────────────
    "gpctba_ci:goals": [
        "What outcomes are you targeting this quarter?",
        "What are you hoping to achieve this quarter?",
        "What goals are you aiming at right now?",
        "What would a win look like this quarter?",
        "What results are you going after?",
        "What's the target you're working toward?",
        "What outcomes matter most this quarter?",
    ],
    "gpctba_ci:plans": [
        "How are you planning to roll this out internally?",
        "What's your plan for putting this in place?",
        "How would you roll this out on your side?",
        "What does implementation look like for you?",
        "How are you thinking about getting this live?",
        "What's your rollout plan looking like?",
        "How would this get deployed with your team?",
    ],
    "gpctba_ci:challenges": [
        "What is currently blocking progress the most?",
        "What's holding things up right now?",
        "What's the biggest blocker for you?",
        "What's standing in the way most?",
        "Where are you getting stuck?",
        "What's slowing progress the most?",
        "What's the main obstacle right now?",
    ],
    "gpctba_ci:timeline": [
        "When do you need this in place?",
        "What's your timeline for having this live?",
        "By when do you need this working?",
        "When would you like this up and running?",
        "What's your deadline looking like?",
        "Any target date for going live?",
        "When does this need to be ready?",
    ],
    "gpctba_ci:budget": [
        "What budget envelope are you working with?",
        "What budget are you planning around?",
        "What kind of budget do you have for this?",
        "What spend range are you working within?",
        "Where's your budget for this?",
        "What budget have you set aside?",
        "What figure are you planning against?",
    ],
    "gpctba_ci:authority": [
        "Who signs off on this purchase?",
        "Who approves a purchase like this?",
        "Who gives the final go-ahead?",
        "Who has to sign off on your side?",
        "Who holds approval for this?",
        "Who makes the call to buy?",
        "Who's the one who approves this?",
    ],
    "gpctba_ci:consequences": [
        "What happens if this is not solved in time?",
        "What's the cost of leaving this unsolved?",
        "What's at stake if this slips?",
        "What happens if nothing changes?",
        "What's the impact of not fixing this?",
        "How much does inaction hurt here?",
        "What's the downside if this waits?",
    ],
}


def pick_probe_variant(
    framework: str | None,
    dimension: str | None,
    base_prompt: str | None,
    *,
    seed: int = 0,
    avoid_text: str = "",
) -> str:
    """Rotate the probe wording so a re-asked dimension never reads as the same
    canned question twice in a row.

    Returns a variant from ``CTA_PROMPT_VARIANTS["<framework>:<dimension>"]``
    chosen by ``seed``, excluding any variant already present in ``avoid_text``
    (the previous bot turn) so it never repeats back-to-back. Falls back to
    ``base_prompt`` when there are no variants for the pair, or when
    ``base_prompt`` differs from the stock default (index 0) — i.e. the customer
    set custom wording, which is respected rather than overwritten.
    """
    base = base_prompt or ""
    variants = CTA_PROMPT_VARIANTS.get(f"{framework}:{dimension}") or []
    if not variants:
        return base
    # Custom per-bot wording (not the stock default) is respected, not rotated.
    if base and base.strip().casefold() != variants[0].strip().casefold():
        return base
    avoid = (avoid_text or "").casefold()
    pool = [v for v in variants if v.casefold() not in avoid] or variants
    return pool[abs(int(seed)) % len(pool)]


def _deep_merge(base: dict, overrides: dict) -> dict:
    merged = deepcopy(base)
    for key, value in (overrides or {}).items():
        if isinstance(merged.get(key), dict) and isinstance(value, dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = deepcopy(value)
    return merged


def _framework_name(bot: Bot | None) -> str:
    cfg = (bot.bant_config or {}) if bot else {}
    name = cfg.get("framework") or "bant"
    return name if name in PRESET_FRAMEWORKS else "bant"


def _dimension_keys(framework_config: dict) -> list[str]:
    order = framework_config.get("conversation_order") or []
    keys: list[str] = []
    for key in order:
        if isinstance(framework_config.get(key), dict):
            keys.append(key)
    for key, value in framework_config.items():
        if key in {"framework", "thresholds", "conversation_order", "decay", "behavioral_config"}:
            continue
        if isinstance(value, dict) and key not in keys:
            keys.append(key)
    return keys


def framework_dimension_keys(framework_config: dict) -> list[str]:
    """Public wrapper over ``_dimension_keys`` for cross-module callers
    (e.g. ``lead_service``) that need to iterate a framework's actual
    dimension names instead of assuming BANT's need/timeline/authority/budget."""
    return _dimension_keys(framework_config)


def get_framework_config(bot: Bot | None) -> dict:
    cfg = deepcopy(bot.bant_config) if (bot and bot.bant_config) else {}
    framework = _framework_name(bot)
    preset = deepcopy(PRESET_FRAMEWORKS[framework])
    merged = _deep_merge(preset, cfg)
    merged["framework"] = framework
    return merged


def calculate_composite_score(dimension_scores: dict, framework_config: dict) -> int:
    if not dimension_scores:
        return 0

    dimensions = _dimension_keys(framework_config)
    enabled = [dim for dim in dimensions if framework_config.get(dim, {}).get("enabled", True)]
    if not enabled:
        return 0

    total_weight = sum(float(framework_config.get(dim, {}).get("weight", 0) or 0) for dim in enabled)
    if total_weight <= 0:
        return 0

    composite = 0.0
    for dim in enabled:
        score = int((dimension_scores.get(dim) or {}).get("score") or 0)
        dim_cfg = framework_config.get(dim, {})
        options = dim_cfg.get("options") or []
        max_dim_score = max((int(o.get("score", 0)) for o in options), default=25)
        normalized_score = (score / max_dim_score) * 100 if max_dim_score > 0 else 0
        weight = float(dim_cfg.get("weight", 0) or 0)
        composite += normalized_score * (weight / total_weight)

    return min(max(int(round(composite)), 0), 100)


def get_tier(score: int, thresholds: dict | None = None) -> str:
    merged = _deep_merge({"mql": 30, "sal": 55, "sql": 75}, thresholds or {})
    if score >= int(merged["sql"]):
        return "sql"
    if score >= int(merged["sal"]):
        return "sal"
    if score >= int(merged["mql"]):
        return "mql"
    return "unqualified"


def build_qualification_response(session: ChatSession, bot: Bot | None) -> dict:
    framework_config = get_framework_config(bot)
    framework = framework_config.get("framework", "bant")

    dimension_scores = deepcopy(session.dimension_scores) if session.dimension_scores else None
    if not dimension_scores:
        dimension_scores = {
            "need": {"score": int(session.bant_need_score or 0), "value": session.bant_need or ""},
            "budget": {"score": int(session.bant_budget_score or 0), "value": session.bant_budget or ""},
            "authority": {"score": int(session.bant_authority_score or 0), "value": session.bant_authority or ""},
            "timeline": {"score": int(session.bant_timeline_score or 0), "value": session.bant_timeline or ""},
        }

    score = calculate_composite_score(dimension_scores, framework_config)
    thresholds = framework_config.get("thresholds") or {}
    tier = get_tier(score, thresholds=thresholds)

    return {
        "framework": framework,
        "score": score,
        "tier": tier,
        "thresholds": thresholds,
        "dimensions": dimension_scores,
        "conversation_order": framework_config.get("conversation_order") or [],
    }


def get_preset_frameworks() -> dict:
    return deepcopy(PRESET_FRAMEWORKS)
