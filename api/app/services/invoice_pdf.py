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

from datetime import UTC
from zoneinfo import ZoneInfo

from jinja2 import Environment, select_autoescape

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
    rupees, paise = divmod(int(minor), 100)
    words = f"Rupees {_rupees_in_words(rupees) if rupees else 'Zero'}"
    if paise:
        words += f" and {_two_digits(paise)} Paise"
    return f"{words} Only"


def _fmt_inr(minor: int | None) -> str:
    """Paise → ``₹1,52,458.00``-style Indian-grouped display."""
    if minor is None:
        return ""
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
  @page { size: A4; margin: 18mm 16mm; }
  body { font-family: Helvetica, Arial, sans-serif; font-size: 10pt; color: #1a1a1a; }
  h1 { font-size: 14pt; letter-spacing: 2px; margin: 0 0 2mm; }
  .muted { color: #555; }
  .row { display: flex; justify-content: space-between; margin-bottom: 6mm; }
  .block { max-width: 48%; }
  .block h3 { font-size: 9pt; text-transform: uppercase; letter-spacing: 1px; color: #666; margin: 0 0 1mm; }
  table { width: 100%; border-collapse: collapse; margin: 4mm 0; }
  th, td { border: 0.5pt solid #999; padding: 2mm 2.5mm; text-align: left; font-size: 9.5pt; }
  th { background: #f2f2f2; }
  td.num, th.num { text-align: right; }
  .totals td { border: none; padding: 1mm 2.5mm; }
  .totals tr.grand td { border-top: 1pt solid #333; font-weight: bold; }
  .legend { margin: 3mm 0; font-style: italic; }
  .foot { margin-top: 10mm; display: flex; justify-content: space-between; }
  .sign { text-align: right; }
</style>
</head>
<body>
  <div class="row">
    <div class="block">
      <h1>{{ title }}</h1>
      <div class="muted">No: <strong>{{ inv.invoice_number }}</strong></div>
      <div class="muted">Date: {{ issue_date }}</div>
      {% if inv.period_start and inv.period_end -%}
      <div class="muted">Service period: {{ period }}</div>
      {%- endif %}
    </div>
    <div class="block" style="text-align:right">
      <strong>{{ seller.legal_name }}</strong>
      {% if seller.trade_name and seller.trade_name != seller.legal_name -%}
      <div class="muted">({{ seller.trade_name }})</div>
      {%- endif %}
      {% for line in seller.address_lines -%}
      <div class="muted">{{ line }}</div>
      {%- endfor %}
      {% if seller.gstin -%}
      <div>GSTIN: {{ seller.gstin }}</div>
      {%- endif %}
    </div>
  </div>

  <div class="row">
    <div class="block">
      <h3>Bill to</h3>
      <strong>{{ buyer.legal_name or buyer.name or "Customer" }}</strong>
      {% if buyer.billing_address -%}
        {% for key in ("line1", "line2", "city", "postal_code") -%}
          {% if buyer.billing_address.get(key) %}<div class="muted">{{ buyer.billing_address[key] }}</div>{% endif %}
        {%- endfor %}
      {%- endif %}
      {% if buyer.email %}<div class="muted">{{ buyer.email }}</div>{% endif %}
      {% if buyer.gstin %}<div>GSTIN: {{ buyer.gstin }}</div>{% endif %}
    </div>
    <div class="block" style="text-align:right">
      {% if is_tax_invoice -%}
      {% if inv.place_of_supply %}<div>Place of supply: {{ inv.place_of_supply }}</div>{% endif %}
      <div>Reverse charge: No</div>
      {%- endif %}
    </div>
  </div>

  <table>
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

  <table class="totals" style="width: 45%; margin-left: 55%;">
    {% if is_tax_invoice -%}
    <tr><td>Taxable value</td><td class="num">{{ taxable }}</td></tr>
    {% for tax in tax_rows -%}
    <tr><td>{{ tax.label }}</td><td class="num">{{ tax.amount }}</td></tr>
    {%- endfor %}
    <tr><td>Total tax</td><td class="num">{{ total_tax }}</td></tr>
    {%- endif %}
    <tr class="grand"><td>Total</td><td class="num">{{ total }}</td></tr>
  </table>

  <div><strong>Amount in words:</strong> {{ in_words }}</div>

  {% if export_legend -%}
  <div class="legend">{{ export_legend }}</div>
  {%- endif %}

  <div class="foot">
    <div class="muted">This is a computer-generated document.</div>
    <div class="sign">
      <div>For {{ seller.legal_name }}</div>
      <div style="margin-top: 12mm;" class="muted">Authorised signatory</div>
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

    is_tax_invoice = invoice.invoice_type == "tax_invoice"
    seller = invoice.seller_snapshot or {}
    buyer = invoice.buyer_snapshot or {}

    tax_rows = []
    export_legend = None
    if is_tax_invoice:
        rate_pct = (invoice.tax_rate_bps or 0) / 100
        if invoice.supply_kind == "intra":
            tax_rows = [
                {"label": f"CGST @ {rate_pct / 2}%", "amount": _fmt_inr(invoice.cgst_minor)},
                {"label": f"SGST @ {rate_pct / 2}%", "amount": _fmt_inr(invoice.sgst_minor)},
            ]
        elif invoice.total_tax_minor:
            tax_rows = [{"label": f"IGST @ {rate_pct}%", "amount": _fmt_inr(invoice.igst_minor)}]
        if invoice.is_export and seller.get("lut_active"):
            lut = f" ({seller['lut_number']})" if seller.get("lut_number") else ""
            export_legend = f"Supply meant for export under LUT without payment of IGST{lut}."

    period = ""
    if invoice.period_start and invoice.period_end:
        period = f"{invoice.period_start.astimezone(IST):%d %b %Y} – {invoice.period_end.astimezone(IST):%d %b %Y}"

    lines = [
        {"description": item.get("description") or "Service", "amount": _fmt_inr(item.get("amount_minor"))}
        for item in (invoice.line_items or [{"description": invoice.description, "amount_minor": invoice.amount_cents}])
    ]

    return _template.render(
        inv=invoice,
        title="TAX INVOICE" if is_tax_invoice else "RECEIPT",
        issue_date=f"{issued_ist:%d %b %Y}",
        period=period,
        seller=seller,
        buyer=buyer,
        is_tax_invoice=is_tax_invoice,
        lines=lines,
        taxable=_fmt_inr(invoice.taxable_value_minor),
        tax_rows=tax_rows,
        total_tax=_fmt_inr(invoice.total_tax_minor),
        total=_fmt_inr(invoice.amount_cents),
        in_words=amount_in_words_inr(invoice.amount_cents),
        export_legend=export_legend,
    )


def render_invoice_pdf(invoice: Invoice) -> bytes:
    """Render the finalized invoice to PDF bytes (requires system pango)."""
    from weasyprint import HTML  # lazy: system-library dependent

    return HTML(string=render_invoice_html(invoice)).write_pdf()
