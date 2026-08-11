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
        # ── Added when a miss stopped being cosmetic ────────────────────────
        # Before company resolution existed, a gap here just stored a harmless
        # string ("yahoo.co.uk") on the lead. Now it triggers a paid crawl,
        # bills the customer, and tells their salesperson the lead works at
        # Yahoo. Regional variants of providers already listed are the
        # cheapest wins, so they go in as a group rather than one report at a
        # time.
        "yahoo.co.uk",
        "yahoo.ca",
        "yahoo.com.au",
        "yahoo.com.br",
        "yahoo.fr",
        "yahoo.de",
        "yahoo.es",
        "yahoo.it",
        "yahoo.co.jp",
        "hotmail.co.uk",
        "hotmail.fr",
        "hotmail.de",
        "hotmail.it",
        "hotmail.es",
        "hotmail.ca",
        "hotmail.com.br",
        "live.co.uk",
        "live.ca",
        "live.com.au",
        "live.in",
        "outlook.in",
        "outlook.fr",
        "outlook.de",
        "outlook.es",
        "outlook.it",
        "outlook.com.au",
        "outlook.co.id",
        # Large non-Anglophone consumer providers. Each of these is a
        # household mail service, not an employer.
        "gmx.com",
        "gmx.de",
        "gmx.net",
        "gmx.at",
        "gmx.ch",
        "gmx.co.uk",
        "t-online.de",
        "freenet.de",
        "mail.ru",
        "inbox.ru",
        "bk.ru",
        "list.ru",
        "yandex.ru",
        "yandex.com",
        "ya.ru",
        "qq.com",
        "163.com",
        "126.com",
        "sina.com",
        "sina.cn",
        "naver.com",
        "hanmail.net",
        "daum.net",
        "orange.fr",
        "wanadoo.fr",
        "free.fr",
        "laposte.net",
        "sfr.fr",
        "libero.it",
        "virgilio.it",
        "tiscali.it",
        "seznam.cz",
        "wp.pl",
        "o2.pl",
        "interia.pl",
        "terra.com.br",
        "uol.com.br",
        "bol.com.br",
        # Privacy / disposable-adjacent providers people use as a main address.
        "tutanota.com",
        "tutamail.com",
        "tuta.com",
        "tuta.io",
        "fastmail.com",
        "hushmail.com",
        "pm.me",
        "mail.com",
        "email.com",
        # India-specific consumer providers, matching the traffic mix.
        # NOT here on purpose: sify.com and indiatimes.com. Both ran consumer
        # webmail, but both are also the live corporate domains of real
        # companies (Sify Technologies; Times Internet / Bennett Coleman), and
        # this file's own warning applies — a bad entry silently drops a real
        # company's leads, which is worse than paying to resolve a webmail
        # domain and getting nothing back.
        "in.com",
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
