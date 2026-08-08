"""Free, in-house company-domain extraction from an email address.

No API call — see docs/superpowers/plans/2026-08-08-visitor-intelligence.md
for why this replaced a paid reverse-email-lookup vendor.
"""

# Not exhaustive by design — covers the providers a B2B chatbot lead is
# actually likely to type. Extend this list as false positives are
# reported; do not attempt to auto-generate it — a bad addition here
# silently drops a real company's leads.
_FREE_EMAIL_DOMAINS = frozenset(
    {
        "gmail.com",
        "googlemail.com",
        "yahoo.com",
        "yahoo.co.in",
        "ymail.com",
        "outlook.com",
        "hotmail.com",
        "live.com",
        "msn.com",
        "icloud.com",
        "me.com",
        "mac.com",
        "protonmail.com",
        "proton.me",
        "aol.com",
        "rediffmail.com",
        "zoho.com",
    }
)


def extract_company_domain(email: str | None) -> str | None:
    """Return the lowercased domain of a business email, or None if the
    address is malformed or belongs to a known free/personal provider."""
    if not email or "@" not in email:
        return None

    domain = email.strip().lower().rsplit("@", 1)[-1]
    if not domain or "." not in domain:
        return None

    if domain in _FREE_EMAIL_DOMAINS:
        return None

    return domain
