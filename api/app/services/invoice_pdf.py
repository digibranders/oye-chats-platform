"""Invoice document rendering — Rule 46 HTML template + WeasyPrint PDF.

Pure presentation over a FINALIZED invoice row: every figure comes from the
frozen columns/snapshots written by ``invoice_service.finalize_invoice`` — this
module computes nothing tax-related itself, so document and ledger can never
disagree. Dates render in IST (the FY series the serial was allocated in is
IST-based; a UTC date could show a different calendar day than the series).

WeasyPrint is imported lazily: it needs system pango libraries (macOS
``brew install pango`` + ``DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib``,
Ubuntu ``apt install libpango-1.0-0 libpangoft2-1.0-0``), and the HTML path
must keep working (tests, previews) even where those are absent.
"""

from __future__ import annotations

from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from jinja2 import Environment, select_autoescape

from app.core.gstin import country_name, state_name
from app.db.models import Invoice

IST = ZoneInfo("Asia/Kolkata")

_ONES = (
    "",
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
    "Eleven",
    "Twelve",
    "Thirteen",
    "Fourteen",
    "Fifteen",
    "Sixteen",
    "Seventeen",
    "Eighteen",
    "Nineteen",
)
_TENS = ("", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety")


def _two_digits(n: int) -> str:
    if n < 20:
        return _ONES[n]
    tens, ones = divmod(n, 10)
    return f"{_TENS[tens]} {_ONES[ones]}".strip()


def _three_digits(n: int) -> str:
    hundreds, rest = divmod(n, 100)
    parts = []
    if hundreds:
        parts.append(f"{_ONES[hundreds]} Hundred")
    if rest:
        parts.append(_two_digits(rest))
    return " ".join(parts)


def _rupees_in_words(n: int) -> str:
    """Indian numbering: crore (10^7), lakh (10^5), thousand, hundred."""
    if n == 0:
        return "Zero"
    parts = []
    crore, n = divmod(n, 10_000_000)
    lakh, n = divmod(n, 100_000)
    thousand, n = divmod(n, 1_000)
    if crore:
        parts.append(f"{_rupees_in_words(crore)} Crore")
    if lakh:
        parts.append(f"{_two_digits(lakh)} Lakh")
    if thousand:
        parts.append(f"{_two_digits(thousand)} Thousand")
    if n:
        parts.append(_three_digits(n))
    return " ".join(parts)


def amount_in_words_inr(minor: int) -> str:
    """``179900`` (paise) → ``"Rupees One Thousand Seven Hundred Ninety Nine Only"``."""
    if minor < 0:
        raise ValueError("amount_in_words_inr expects a non-negative amount (credit notes pass magnitudes)")
    rupees, paise = divmod(int(minor), 100)
    words = f"Rupees {_rupees_in_words(rupees) if rupees else 'Zero'}"
    if paise:
        words += f" and {_two_digits(paise)} Paise"
    return f"{words} Only"


# Minor-unit symbols for the currencies the invoice engine can issue in. INR is
# the only live rail today; the rest exist so the USD rail (Plan C) cannot ship
# a document that prints a rupee sign on a dollar amount.
_CURRENCY_SYMBOLS = {"INR": "₹", "USD": "$", "EUR": "€", "GBP": "£", "AED": "AED ", "SGD": "S$"}


def _fmt_rate(bps: int | None, *, half: bool = False) -> str:
    """Basis points → ``18`` / ``9`` / ``2.5``, never ``18.0``.

    A trailing ".0" on a statutory document reads as an unfinished template.
    ``half`` splits the rate for the CGST/SGST pair.
    """
    value = (bps or 0) / (200 if half else 100)
    return f"{value:.10g}"


def _fmt_money(minor: int | None, currency: str | None) -> str:
    """Minor units → display string in the invoice's OWN currency.

    Indian lakh grouping applies to INR only; every other currency uses
    thousands grouping, because "$1,52,458.00" is not a number anyone outside
    India reads correctly — and on a statutory export document it misstates
    the figure's presentation.
    """
    code = (currency or "INR").upper()
    if code == "INR":
        return _fmt_inr(minor)
    if minor is None:
        return ""
    if minor < 0:
        raise ValueError("_fmt_money expects a non-negative amount (credit notes pass magnitudes)")
    major, cents = divmod(int(minor), 100)
    symbol = _CURRENCY_SYMBOLS.get(code, f"{code} ")
    return f"{symbol}{major:,}.{cents:02d}"


def _fmt_inr(minor: int | None) -> str:
    """Paise → ``₹1,52,458.00``-style Indian-grouped display."""
    if minor is None:
        return ""
    if minor < 0:
        raise ValueError("_fmt_inr expects a non-negative amount (credit notes pass magnitudes)")
    rupees, paise = divmod(int(minor), 100)
    s = str(rupees)
    if len(s) > 3:
        head, tail = s[:-3], s[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        s = ",".join([*groups, tail])
    return f"₹{s}.{paise:02d}"


_TEMPLATE = """\
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page { size: A4; margin: 16mm 15mm 18mm; }
  body { font-family: Helvetica, Arial, sans-serif; font-size: 9.5pt; color: #0f172a; line-height: 1.45; }
  .muted { color: #64748b; }
  .small { font-size: 8.5pt; }
  .row { display: flex; justify-content: space-between; }
  .brand { font-size: 19pt; font-weight: bold; color: #4f46e5; letter-spacing: -0.5px; }
  .brand img { height: 10mm; }
  .doc-title { font-size: 15pt; font-weight: bold; letter-spacing: 2.5px; margin: 0 0 1.5mm; }
  .header { margin-bottom: 5mm; padding-bottom: 4mm; border-bottom: 1.2pt solid #4f46e5; }
  .header .right { text-align: right; }
  .badge { display: inline-block; font-size: 8pt; font-weight: bold; letter-spacing: 1.5px;
           padding: 1mm 3.5mm; border-radius: 2mm; margin-top: 1.5mm;
           background: #dcfce7; color: #15803d; }
  .parties { margin-bottom: 5mm; }
  .block { max-width: 47%; }
  .block h3 { font-size: 7.5pt; text-transform: uppercase; letter-spacing: 1.5px; color: #64748b; margin: 0 0 1.5mm; }
  .block .name { font-weight: bold; font-size: 10.5pt; }
  .meta { background: #f8fafc; border: 0.5pt solid #e2e8f0; border-radius: 1.5mm;
          padding: 2.5mm 4mm; font-size: 8.5pt; color: #475569; margin-bottom: 5mm; }
  .meta span.item { margin-right: 7mm; }
  table.items { width: 100%; border-collapse: collapse; margin: 0; }
  table.items th { font-size: 7.5pt; text-transform: uppercase; letter-spacing: 1.2px; color: #64748b;
                   text-align: left; padding: 0 2mm 2mm 0; border-bottom: 1pt solid #0f172a; }
  table.items td { padding: 2.8mm 2mm 2.8mm 0; border-bottom: 0.5pt solid #e2e8f0; }
  td.num, th.num { text-align: right; padding-right: 0; }
  table.totals { width: 47%; margin-left: 53%; border-collapse: collapse; margin-top: 2.5mm; }
  table.totals td { padding: 1.6mm 0; }
  table.totals td.label { color: #475569; }
  table.totals tr.grand td { border-top: 1.2pt solid #4f46e5; background: #eef2ff; color: #312e81;
                             font-weight: bold; font-size: 11pt; padding: 2.6mm 2.5mm; }
  .words { margin-top: 4.5mm; }
  .legend { margin: 3mm 0; font-style: italic; color: #475569; }
  .foot { margin-top: 12mm; padding-top: 3.5mm; border-top: 0.6pt solid #e2e8f0;
          display: flex; justify-content: space-between; font-size: 8.5pt; }
  .sign { text-align: right; }
  .copy-mark { letter-spacing: 0.6px; margin-top: 1mm; }
</style>
</head>
<body>
  <div class="row header">
    <div>
      {% if seller.logo_url -%}
      <div class="brand"><img src="{{ seller.logo_url }}" alt="{{ brand_name }}"></div>
      {%- else -%}
      <div class="brand">{{ brand_name }}</div>
      {%- endif %}
      {% if seller.trade_name and seller.trade_name != seller.legal_name -%}
      <div class="muted small">by {{ seller.legal_name }}</div>
      {%- endif %}
    </div>
    <div class="right">
      <div class="doc-title">{{ title }}</div>
      {% if is_tax_invoice %}<div class="muted small copy-mark">ORIGINAL FOR RECIPIENT</div>{% endif %}
      <div class="muted">No: <strong style="color:#0f172a">{{ inv.invoice_number }}</strong></div>
      <div class="muted">Date: {{ issue_date }}</div>
      {% if against -%}
      <div class="muted">Against invoice: {{ against }}{% if against_date %} dated {{ against_date }}{% endif %}</div>
      {%- endif %}
      {% if badge -%}
      <div class="badge">{{ badge }}</div>
      {%- endif %}
    </div>
  </div>

  <div class="row parties">
    <div class="block">
      <h3>From</h3>
      <div class="name">{{ seller.legal_name }}</div>
      {% for line in seller.address_lines -%}
      <div class="muted">{{ line }}</div>
      {%- endfor %}
      {% if seller.gstin %}<div>GSTIN: {{ seller.gstin }}</div>{% endif %}
      {% if seller.cin %}<div class="muted">CIN: {{ seller.cin }}</div>{% endif %}
      {% if seller.phone %}<div class="muted">{{ seller.phone }}</div>{% endif %}
      {% if seller.website %}<div class="muted">{{ seller.website }}</div>{% endif %}
    </div>
    <div class="block" style="text-align:right">
      <h3>Bill to</h3>
      <div class="name">{{ buyer.legal_name or buyer.name or "Customer" }}</div>
      {% if buyer.billing_address -%}
        {% for key in ("line1", "line2", "city", "state", "postal_code") -%}
          {% if buyer.billing_address.get(key) %}<div class="muted">{{ buyer.billing_address[key] }}</div>{% endif %}
        {%- endfor %}
      {%- endif %}
      {% if buyer.email %}<div class="muted">{{ buyer.email }}</div>{% endif %}
      {% if buyer.gstin %}<div>GSTIN: {{ buyer.gstin }}</div>{% endif %}
    </div>
  </div>

  {% if meta_items -%}
  <div class="meta">
    {% for item in meta_items %}<span class="item">{{ item }}</span>{% endfor %}
  </div>
  {%- endif %}

  <table class="items">
    <tr>
      <th>Description</th>
      {% if is_tax_invoice %}<th>SAC</th>{% endif %}
      <th class="num">Amount</th>
    </tr>
    {% for line in lines -%}
    <tr>
      <td>{{ line.description }}</td>
      {% if is_tax_invoice %}<td>{{ inv.hsn_sac }}</td>{% endif %}
      <td class="num">{{ line.amount }}</td>
    </tr>
    {%- endfor %}
  </table>

  <table class="totals">
    {% if is_tax_invoice -%}
    <tr><td class="label">Taxable value</td><td class="num">{{ taxable }}</td></tr>
    {% for tax in tax_rows -%}
    <tr><td class="label">{{ tax.label }}</td><td class="num">{{ tax.amount }}</td></tr>
    {%- endfor %}
    <tr><td class="label">Total tax</td><td class="num">{{ total_tax }}</td></tr>
    {%- endif %}
    <tr class="grand"><td>Total</td><td class="num">{{ total }}</td></tr>
  </table>

  <div class="words"><strong>Amount in words:</strong> {{ in_words }}</div>

  {% if export_legend -%}
  <div class="legend">{{ export_legend }}</div>
  {%- endif %}

  <div class="foot">
    <div class="muted">
      <div>Questions about this document? {{ support_email }}</div>
      {# Rule 46(p) requires a signature, but its proviso waives it for an
         electronic invoice issued under the IT Act 2000. This declaration is
         what invokes the waiver. The old layout printed a generic
         "computer-generated" line AND an empty "Authorised signatory" block,
         which read as an UNSIGNED invoice rather than one needing no
         signature -- the worst of both. #}
      <div>This is a computer-generated invoice and does not require a physical signature.</div>
    </div>
    <div class="sign">
      <div>For {{ seller.legal_name }}</div>
    </div>
  </div>
</body>
</html>
"""

_env = Environment(autoescape=select_autoescape(default=True))
_template = _env.from_string(_TEMPLATE)


def render_invoice_html(invoice: Invoice) -> str:
    """Render the finalized invoice as a self-contained HTML document."""
    if not invoice.invoice_number or not invoice.issued_at:
        raise ValueError("invoice must be finalized (numbered + issued) before rendering")

    issued = invoice.issued_at
    if issued.tzinfo is None:
        issued = issued.replace(tzinfo=UTC)
    issued_ist = issued.astimezone(IST)

    # Credit notes reversing a tax invoice carry the same breakup table; plain
    # receipts (and their credit notes) have no tax section.
    is_tax_invoice = invoice.invoice_type in ("tax_invoice", "credit_note") and invoice.taxable_value_minor is not None
    titles = {"tax_invoice": "TAX INVOICE", "credit_note": "CREDIT NOTE", "receipt": "RECEIPT"}
    seller = invoice.seller_snapshot or {}
    buyer = invoice.buyer_snapshot or {}
    against = None
    against_date = None
    if invoice.invoice_type == "credit_note":
        ref_item = next((item for item in (invoice.line_items or []) if item.get("against_invoice")), None)
        if ref_item:
            against = ref_item.get("against_invoice")
            raw_date = ref_item.get("against_invoice_date")
            if raw_date:
                try:
                    parsed = datetime.fromisoformat(raw_date)
                    if parsed.tzinfo is None:
                        parsed = parsed.replace(tzinfo=UTC)
                    against_date = f"{parsed.astimezone(IST):%d %b %Y}"
                except ValueError:
                    against_date = None

    # Every amount on this document formats in the invoice's OWN currency.
    def money(minor: int | None) -> str:
        return _fmt_money(minor, invoice.currency)

    tax_rows = []
    export_legend = None
    if is_tax_invoice:
        if invoice.supply_kind == "intra":
            half = _fmt_rate(invoice.tax_rate_bps, half=True)
            tax_rows = [
                {"label": f"CGST @ {half}%", "amount": money(invoice.cgst_minor)},
                {"label": f"SGST @ {half}%", "amount": money(invoice.sgst_minor)},
            ]
        elif invoice.total_tax_minor:
            full = _fmt_rate(invoice.tax_rate_bps)
            tax_rows = [{"label": f"IGST @ {full}%", "amount": money(invoice.igst_minor)}]
        if invoice.is_export:
            if seller.get("lut_active"):
                lut = f" ({seller['lut_number']})" if seller.get("lut_number") else ""
                export_legend = f"Supply meant for export under LUT without payment of IGST{lut}."
            else:
                # Rule 96A fallback — export WITHOUT a LUT is made on payment of
                # IGST, and Rule 46 mandates this exact endorsement (previously
                # missing, so an IGST-paid export printed no export legend at all).
                export_legend = "SUPPLY MEANT FOR EXPORT ON PAYMENT OF INTEGRATED TAX."

    period = ""
    if invoice.period_start and invoice.period_end:
        p_start, p_end = invoice.period_start, invoice.period_end
        if p_start.tzinfo is None:
            p_start = p_start.replace(tzinfo=UTC)
        if p_end.tzinfo is None:
            p_end = p_end.replace(tzinfo=UTC)
        period = f"{p_start.astimezone(IST):%d %b %Y} – {p_end.astimezone(IST):%d %b %Y}"

    lines = [
        {"description": item.get("description") or "Service", "amount": money(item.get("amount_minor"))}
        for item in (invoice.line_items or [{"description": invoice.description, "amount_minor": invoice.amount_cents}])
    ]

    # Compliance/reference strip. Plain "Label: value" strings (no inner
    # markup) — GSTR reviewers and tests both match the literal phrases.
    from app.config import SUPPORT_EMAIL

    support_email = seller.get("support_email") or SUPPORT_EMAIL

    meta_items = []
    if is_tax_invoice:
        if invoice.place_of_supply:
            # Rule 46: the place of supply must carry the State NAME, not a bare
            # code (e.g. "27 – Maharashtra"), for an inter-state supply.
            name = state_name(invoice.place_of_supply)
            pos = f"{invoice.place_of_supply} – {name}" if name else invoice.place_of_supply
            meta_items.append(f"Place of supply: {pos}")
        elif invoice.is_export:
            # finalize_invoice stores NULL for an export (there is no Indian
            # state), but Rule 46 still wants a place of supply on the document
            # and GSTR-1 Table 6A reports exports under code 96. Rendered here
            # rather than stored, so 96 never leaks into VALID_STATE_CODES —
            # that set also validates GSTINs and buyer state codes.
            meta_items.append("Place of supply: 96 – Outside India")
        meta_items.append("Reverse charge: No")
        if invoice.is_export:
            # Rule 46 requires the country of destination on an export invoice.
            destination = country_name(buyer.get("billing_country"))
            if destination:
                meta_items.append(f"Country of destination: {destination}")
    if period:
        meta_items.append(f"Service period: {period}")
    if invoice.razorpay_payment_id:
        meta_items.append(f"Payment ref: {invoice.razorpay_payment_id}")

    return _template.render(
        inv=invoice,
        title=titles.get(invoice.invoice_type, "RECEIPT"),
        against=against,
        against_date=against_date,
        issue_date=f"{issued_ist:%d %b %Y}",
        period=period,
        seller=seller,
        buyer=buyer,
        brand_name=seller.get("trade_name") or seller.get("legal_name") or "OyeChats",
        badge="PAID" if invoice.status == "paid" and invoice.invoice_type != "credit_note" else None,
        meta_items=meta_items,
        is_tax_invoice=is_tax_invoice,
        lines=lines,
        taxable=money(invoice.taxable_value_minor),
        tax_rows=tax_rows,
        total_tax=money(invoice.total_tax_minor),
        total=money(invoice.amount_cents),
        in_words=amount_in_words_inr(invoice.amount_cents),
        export_legend=export_legend,
        support_email=support_email,
    )


def render_invoice_pdf(invoice: Invoice) -> bytes:
    """Render the finalized invoice to PDF bytes (requires system pango)."""
    from weasyprint import HTML  # lazy: system-library dependent

    return HTML(string=render_invoice_html(invoice)).write_pdf()
