"""Free, in-house company-domain extraction from an email address.

No API call — see docs/superpowers/plans/2026-08-08-visitor-intelligence.md
for why this replaced a paid reverse-email-lookup vendor.
"""

from app.services.domain_normalizer import registrable_domain

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
    """Return the registrable domain of a business email, or None.

    This is THE entry point for "which company does this address belong to?".
    It layers the free-provider policy on top of
    ``domain_normalizer.registrable_domain``, which owns every rule about what
    a domain actually is — public suffixes, hosting platforms, IP literals,
    malformed labels.

    Delegating rather than re-implementing matters because the result is the
    primary key of a cross-tenant company cache. Two functions with their own
    idea of a domain would disagree, and this one previously did: it returned
    ``mail.acme.co.uk`` where the normaliser returns ``acme.co.uk``, which
    would have created a separate cached company per email subdomain.

    Returns None for a free/personal provider, a malformed address, a bare
    public suffix, or anything else that is not a company domain.
    """
    if not email or "@" not in email:
        return None

    domain = registrable_domain(email.rsplit("@", 1)[-1])
    if not domain:
        return None

    if domain in _FREE_EMAIL_DOMAINS:
        return None

    return domain
