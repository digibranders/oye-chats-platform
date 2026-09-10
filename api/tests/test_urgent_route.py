"""A visitor reporting an active incident gets the fastest route, not a generic form.

Production, 2026-09-10: "we are under a ransomware attack right now, please
help!" got "Our team is offline right now. Share your details..." on all four
bots, including two security companies.
"""

import timeit

import pytest

from app.services.intent_service import bot_offers_handoff
from app.services.urgent_route import emergency_url_from_answer_links, is_urgent_incident, urgent_reply


@pytest.mark.parametrize(
    "msg",
    [
        "we are under a ransomware attack right now, please help!",
        "our servers have been hacked",
        "I think we've been breached",
        "there is an active incident on our network",
        "urgent help needed now",
        "help, our site got hacked",
        "we've been hacked, please help now",
        "our website is hacked and down right now",
        "Are you there? urgent help needed now!",
    ],
)
def test_urgent_incidents_are_recognised(msg):
    assert is_urgent_incident(msg) is True


@pytest.mark.parametrize(
    "msg",
    [
        "what is your incident response service?",
        "tell me about ransomware attacks",
        "do you handle emergency response?",
        "how do you protect against being hacked?",
        "what happens if we are breached?",
        "",
        # An incident in the past is context for a sales question, not an emergency.
        "our site got hacked last year, what do you offer?",
        "we were breached in 2023",
        "I was hacked a few months ago",
        # A question about the service names the words without reporting anything.
        "do you offer emergency plumbing now?",
        "is urgent help available on weekends?",
        "do you provide emergency incident response now?",
        "can you help with ransomware attacks?",
    ],
)
def test_questions_about_incidents_are_not_urgent(msg):
    assert is_urgent_incident(msg) is False


#: Labelled by the code review on 2026-09-10. The first detector got 46 of these
#: wrong: it paged the owner for "I need urgent help with pricing" and missed
#: "we've been hacked, how do we recover?".
_LABELLED_INCIDENTS = [
    "site is down and showing a ransom note",
    "someone got into our email accounts",
    "we got phished and they wired money",
    "could you help asap, ransomware attack",
    "our website has been defaced",
    "someone is inside our network right now",
    "we just got hit by ransomware",
    "ransomware!!! help",
    "help!! ransomware on all our servers",
    "hackers took over our instagram account",
    "my account got hacked",
    "we have been hacked",
    "our company email was compromised and they're sending invoices to clients",
    "we are being DDoSed right now",
    "we're under a DDoS attack",
    "someone stole our customer data",
    "my wordpress site got hacked, can you fix it today?",
    "can you help? our server was hacked",
    "is anyone there? we have been breached",
    "our payroll system got hit by malware this morning",
    "we got hacked yesterday and they are still in the system",
    "we were hacked last night",
    "URGENT: data breach in progress",
    "we have an ongoing breach",
    "My client's site was hacked",
    "we've been hacked, how do we recover?",
    "our servers have been compromised, can you protect us?",
    "we've been breached and need to prevent further damage",
    "our site was hacked and I don't know if they still have access",
    "we were hacked last week and they are still in our systems",
    "we got hacked 2 days ago and the attacker is still in",
    "we're being attacked, how do we stop it?",
    "ransomware hit us, what do we do",
    "our website is hacked, how to fix",
    "we've been hacked. How do we get our site back?",
    "hi, we've been hacked",
    "Hello, is this urgent support? we are under attack",
    "I need urgent help",
    "all our files are encrypted and there's a ransom note",
]
_LABELLED_NOT_INCIDENTS = [
    "urgent quote needed",
    "we need an urgent response to our RFP",
    "do you do emergency callouts",
    "I need help urgently with pricing",
    "I need urgent help with pricing",
    "need urgent help with my invoice",
    "our old vendor got hacked so we are looking for a new one",
    "my account is locked",
    "hacked by your competitor's marketing lol",
    "urgent: please call me back now about the proposal",
    "this is urgent, I need a price now",
    "emergency dental appointment available now?",
    "My HR team needs urgent help with payroll compliance now",
    "we were hacked last year, what do you offer for emergency response?",
    "I'm worried we could get hacked",
    "our competitor was breached, are we at risk?",
    "my friend got hacked, how can I protect myself?",
    "what should I do if I've been hacked?",
    "I've been hacked before so security matters to me",
    "we got breached two years ago and want a pentest",
    "our previous provider was compromised",
    "i'm compromised on budget, what's cheapest",
    "I've compromised on quality before, not again",
    "We are an urgent care clinic, do you integrate with EHR?",
    "help me with an attack plan for our marketing campaign",
    "help with our heart attack awareness campaign",
    "Do you offer 24/7 emergency support? we need help immediately",
    "I'm the emergency contact now for my mom, how do I update it",
    "we are hacked-proof? what makes you secure",
    "have you ever been hacked?",
    "is my data safe if you are hacked?",
    "we were hacked last year and now we want a pentest",
    "we were breached in 2023, now we need a SOC",
    "Thanks for the help! Tell me about ransomware attacks",
    "I need help with ransomware protection",
    "can ransomware encrypt my backups?",
    "how would ransomware hit us?",
    "we encrypted our backups last week",
    "Can we book an emergency appointment now?",
    "urgent: need the invoice for last month now",
]
#: Held out from the rules while they were written, then fixed where a simple rule could.
_HELD_OUT_INCIDENTS = [
    "HELP we got hacked",
    "someone hacked our shopify store and changed the payout account",
    "our network is under attack",
    "i think my laptop is infected with ransomware right now",
    "we're seeing a data breach, customer records are being posted online",
    "we have been compromised",
    "attackers are in our AWS account",
    "our domain was hijacked",
    "malware on all our PCs, need help asap",
    "we got hit with a ddos attack",
]
_HELD_OUT_NOT_INCIDENTS = [
    "can you recover a hacked website?",
    "what's the cost if our site gets hacked",
    "we help companies that got hacked",
    "my previous site got hacked so I want a more secure host",
    "is urgent help available 24/7?",
    "I need an emergency plumber now",
    "our servers were compromised in the 2021 incident, what's changed since?",
    "urgent help needed with GST filing",
    "please help asap with my order status",
    "I need help now, my breach of contract case",
    "our client breached the contract and we need urgent legal help",
    "my landlord breached the lease, I need help",
    "my employer breached my employment agreement",
    "we compromised on the design, can you quote again?",
]
#: Guards on the rules added for the held-out cases.
_RULE_GUARD_INCIDENTS = [
    "our files were encrypted by ransomware",
    "files encrypted by ransomware on our NAS",
    "we are seeing a DDoS attack",
    "someone hijacked our domain",
]
_RULE_GUARD_NOT_INCIDENTS = [
    "our data is encrypted by default",
    "we need ddos protection",
    "we hacked together a prototype",
    "we're dealing with a breach of contract",
    "we scan for malware on our servers weekly",
    "I'm having a panic attack about the launch",
    "help, my landlord breached the lease",
]


@pytest.mark.parametrize("msg", _LABELLED_INCIDENTS + _HELD_OUT_INCIDENTS + _RULE_GUARD_INCIDENTS)
def test_reported_incidents_are_urgent(msg):
    assert is_urgent_incident(msg) is True


@pytest.mark.parametrize("msg", _LABELLED_NOT_INCIDENTS + _HELD_OUT_NOT_INCIDENTS + _RULE_GUARD_NOT_INCIDENTS)
def test_messages_that_only_use_the_words_are_not_urgent(msg):
    assert is_urgent_incident(msg) is False


_ADVERSARIAL_SEEDS = [
    "a",
    " ",
    "!",
    "we ",
    "we, ",
    "we got ",
    "we hit by by ",
    "our vendor ",
    "help, ",
    "someone ",
    "hacked ",
    "attackers are in ",
    "if we are hacked ",
    "we were hacked last year and ",
    "urgent help with ",
    "for malware on our ",
    "our vendor was hacked last year, if we are breached ",
]


@pytest.mark.parametrize("seed", _ADVERSARIAL_SEEDS)
def test_a_long_adversarial_message_is_judged_quickly(seed):
    message = (seed * (20_000 // len(seed) + 1))[:20_000]
    fastest = min(timeit.repeat(lambda: is_urgent_incident(message), number=1, repeat=3))
    assert fastest < 0.05, f"{fastest:.3f}s for {seed!r}"


def test_a_non_string_is_not_urgent():
    assert is_urgent_incident(None) is False


def test_the_emergency_link_comes_from_a_smart_link():
    links = [
        {"keyword": "pricing", "url": "https://acme.com/pricing"},
        {"keyword": "Emergency", "url": " https://acme.com/incident "},
    ]
    assert emergency_url_from_answer_links(links) == "https://acme.com/incident"


@pytest.mark.parametrize(
    "links",
    [
        None,
        "x",
        [{"keyword": "emergency", "url": "javascript:alert(1)"}],
        [{"keyword": "emergency", "url": "ftp://acme.com/x"}],
        [{"keyword": "emergency", "url": "https://"}],
        [{"keyword": "emergency"}],
    ],
)
def test_an_unusable_emergency_link_is_ignored(links):
    assert emergency_url_from_answer_links(links) is None


def _reply(**over):
    kwargs = dict(
        company_name="Acme",
        support_enabled=True,
        live_chat_enabled=True,
        team_available=True,
        emergency_url=None,
        contact_url=None,
    )
    kwargs.update(over)
    return urgent_reply(**kwargs)


def test_team_available_opens_the_form_and_says_it_is_flagged():
    r = _reply()
    assert r.suggest_handoff is True and r.needs_message_card is False
    assert "flagged" in r.text and "form below" in r.text


def test_team_offline_says_so_and_still_flags():
    r = _reply(team_available=False)
    assert "offline" in r.text and "flagged" in r.text
    assert r.suggest_handoff is True


def test_no_live_chat_opens_the_message_card():
    r = _reply(live_chat_enabled=False)
    assert r.suggest_handoff is False and r.needs_message_card is True


def test_the_emergency_link_is_offered_first_when_configured():
    r = _reply(emergency_url="https://acme.com/incident")
    assert "https://acme.com/incident" in r.text


def test_a_plan_without_a_human_points_to_a_page_and_claims_no_flagging():
    r = _reply(support_enabled=False, contact_url="https://acme.com/contact")
    assert "https://acme.com/contact" in r.text
    assert "flagged" not in r.text
    assert r.suggest_handoff is False and r.needs_message_card is False


def test_a_yes_after_the_live_reply_is_a_handoff_and_after_the_no_human_reply_is_not():
    """The next turn reads the bot's closing paragraph: "yes" after an offer of the
    team becomes a handoff, "yes" after a pointer to a page does not."""
    assert bot_offers_handoff(_reply().text) is True
    assert bot_offers_handoff(_reply(emergency_url="https://acme.com/incident").text) is True
    assert bot_offers_handoff(_reply(support_enabled=False, contact_url="https://acme.com/contact").text) is False
    assert bot_offers_handoff(_reply(support_enabled=False).text) is False


def test_a_repeat_on_live_chat_points_at_the_form_again():
    first = _reply()
    repeat = _reply(repeat=True)
    assert repeat.text == (
        "I've already flagged this to **Acme** as a priority. The form is just below: "
        "share your details there and I'll connect you with them right away."
    )
    assert (repeat.suggest_handoff, repeat.needs_message_card) == (first.suggest_handoff, first.needs_message_card)
    assert bot_offers_handoff(repeat.text) is True


def test_a_repeat_with_the_team_offline_says_they_will_reach_out():
    repeat = _reply(team_available=False, repeat=True)
    assert repeat.text == (
        "I've already flagged this to **Acme** as a priority. The form is just below: "
        "share your details there so they can reach you as soon as possible."
    )
    assert repeat.suggest_handoff is True


def test_a_repeat_without_live_chat_points_at_the_message_form():
    first = _reply(live_chat_enabled=False)
    repeat = _reply(live_chat_enabled=False, repeat=True)
    assert repeat.text == (
        "I've already flagged this to **Acme** as a priority. Leave your details in the message form "
        "so they can reach you as soon as possible."
    )
    assert (repeat.suggest_handoff, repeat.needs_message_card) == (first.suggest_handoff, first.needs_message_card)


def test_a_repeat_keeps_the_emergency_link():
    assert "https://acme.com/incident" in _reply(emergency_url="https://acme.com/incident", repeat=True).text


def test_a_repeat_without_support_repeats_the_pointer():
    assert _reply(support_enabled=False, contact_url="https://acme.com/contact", repeat=True) == _reply(
        support_enabled=False, contact_url="https://acme.com/contact"
    )


@pytest.mark.parametrize("keyword", ["urgent", "incident", "Urgent Delivery"])
def test_only_an_emergency_or_incident_response_link_counts(keyword):
    links = [{"keyword": keyword, "url": "https://acme.com/page"}]
    assert emergency_url_from_answer_links(links) is None


def test_an_incident_response_link_counts():
    links = [{"keyword": "incident response", "url": "https://acme.com/ir"}]
    assert emergency_url_from_answer_links(links) == "https://acme.com/ir"
