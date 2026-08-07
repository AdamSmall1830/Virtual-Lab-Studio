"""Typeset PDF report for a finished run.

This is the readable companion to the reproducibility ZIP in :mod:`app.exports`.
The ZIP is for machines and auditors; this document is what a researcher prints,
circulates to collaborators, or attaches to a grant report. It always carries the
conclusions record in full — the same fields the Conclusions tab renders — and
the caller chooses which supporting appendices come with it.

Two rules shape everything here:

* **Nothing is asserted that the record does not contain.** Empty fields are
  omitted rather than rendered as hollow headings, and a missing summary or an
  unverifiable manifest is stated plainly instead of quietly skipped.
* **The provenance warnings travel with the paper.** Model-generated status,
  review status, and demo/simulated status appear on the cover and in the
  footer of every page, because a PDF outlives the app session that made it.
"""
from __future__ import annotations

import asyncio
import html
import io
import re
import unicodedata
from datetime import datetime, timezone
from typing import Any, Iterable, Sequence

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas
from reportlab.platypus import (
    BaseDocTemplate,
    Flowable,
    Frame,
    HRFlowable,
    KeepTogether,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)
from reportlab.platypus.tableofcontents import TableOfContents
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from .models import (
    MeetingDefinition,
    Project,
    Run,
    RunCitation,
    RunIntervention,
    RunManifest,
    RunReview,
    RunSummary,
    RunTurn,
)
from .provenance import frozen_evidence, validate_against_schema
from .schemas import PDF_REPORT_SECTIONS

# --------------------------------------------------------------------------
# Section catalogue
# --------------------------------------------------------------------------
# The conclusions record is always included — it is the report. Everything here
# is an appendix the caller opts into. Ordering is the order they appear in the
# document and in the picker.

SECTION_TITLES: dict[str, str] = {
    "meeting_brief": "Meeting brief",
    "question_answers_detail": "Agenda questions in full",
    "transcript": "Full transcript",
    "final_synthesis": "Final synthesis (verbatim)",
    "evidence": "Attached evidence",
    "citations": "Citations and validation",
    "agents": "Agents and system prompts",
    "usage": "Usage and cost",
    "interventions": "Human interventions",
    "reviews": "Human reviews",
    "provenance": "Provenance and integrity",
}

# A section id that exists in one place but not the other would silently drop
# content or offer a checkbox that does nothing, so the two must match exactly.
assert set(SECTION_TITLES) == set(PDF_REPORT_SECTIONS), (
    "PDF section catalogue drifted between schemas.PDF_REPORT_SECTIONS and "
    "pdf_report.SECTION_TITLES"
)

# --------------------------------------------------------------------------
# Palette — the app's light theme, so a printed report and the screen agree.
# --------------------------------------------------------------------------

INK = colors.HexColor("#111928")
MUTED = colors.HexColor("#545F73")
RULE = colors.HexColor("#C5CFDD")
TEAL = colors.HexColor("#0C8FA8")
GREEN = colors.HexColor("#1D9059")
RED = colors.HexColor("#DD2727")
AMBER = colors.HexColor("#B26A08")
VIOLET = colors.HexColor("#6738D6")
TINT = colors.HexColor("#F1F5F9")
TINT_WARN = colors.HexColor("#FDF6EC")
TINT_TEAL = colors.HexColor("#ECF7FA")


def _hex(color: colors.Color) -> str:
    """`#rrggbb` for use inside reportlab inline markup."""
    return "#" + color.hexval()[2:]


PAGE_SIZE = LETTER
MARGIN_X = 0.9 * inch
MARGIN_TOP = 0.95 * inch
MARGIN_BOTTOM = 0.85 * inch
CONTENT_WIDTH = PAGE_SIZE[0] - 2 * MARGIN_X


# --------------------------------------------------------------------------
# Fonts
# --------------------------------------------------------------------------

def _register_fonts() -> dict[str, str]:
    """Register a serif/sans/mono trio, degrading to what is installed.

    DejaVu is preferred for its wide Unicode coverage — model output routinely
    contains dashes, arrows, and Greek letters that the built-in Type 1 fonts
    cannot draw. reportlab's bundled Vera is the fallback that always exists in
    the wheel, and the base-14 fonts are the last resort.
    """
    dejavu = "/usr/share/fonts/truetype/dejavu"
    families = [
        (
            "VLS-Serif",
            {
                "": f"{dejavu}/DejaVuSerif.ttf",
                "-Bold": f"{dejavu}/DejaVuSerif-Bold.ttf",
                "-Italic": f"{dejavu}/DejaVuSerif-Italic.ttf",
                "-BoldItalic": f"{dejavu}/DejaVuSerif-BoldItalic.ttf",
            },
        ),
        (
            "VLS-Sans",
            {
                "": f"{dejavu}/DejaVuSans.ttf",
                "-Bold": f"{dejavu}/DejaVuSans-Bold.ttf",
                "-Italic": f"{dejavu}/DejaVuSans-Oblique.ttf",
                "-BoldItalic": f"{dejavu}/DejaVuSans-BoldOblique.ttf",
            },
        ),
        (
            "VLS-Mono",
            {
                "": f"{dejavu}/DejaVuSansMono.ttf",
                "-Bold": f"{dejavu}/DejaVuSansMono-Bold.ttf",
                "-Italic": f"{dejavu}/DejaVuSansMono-Oblique.ttf",
                "-BoldItalic": f"{dejavu}/DejaVuSansMono-BoldOblique.ttf",
            },
        ),
    ]
    resolved: dict[str, str] = {}
    for family, faces in families:
        # Register face by face: a distribution that ships regular and bold but
        # no italic should still give us the family, with italic aliased rather
        # than the whole family silently dropped.
        present: set[str] = set()
        for suffix, path in faces.items():
            try:
                pdfmetrics.registerFont(TTFont(family + suffix, path))
                present.add(suffix)
            except Exception:
                continue
        if "" not in present:
            continue
        bold = family + ("-Bold" if "-Bold" in present else "")
        italic = family + ("-Italic" if "-Italic" in present else "")
        bold_italic = family + (
            "-BoldItalic" if "-BoldItalic" in present
            else "-Bold" if "-Bold" in present
            else ""
        )
        pdfmetrics.registerFontFamily(
            family, normal=family, bold=bold, italic=italic, boldItalic=bold_italic
        )
        resolved[family] = family

    body = resolved.get("VLS-Serif") or resolved.get("VLS-Sans")
    sans = resolved.get("VLS-Sans")
    mono = resolved.get("VLS-Mono")

    if sans is None:
        # reportlab ships Bitstream Vera inside the wheel; register it by name.
        try:
            for name, file in (
                ("VLS-Vera", "Vera.ttf"),
                ("VLS-Vera-Bold", "VeraBd.ttf"),
                ("VLS-Vera-Italic", "VeraIt.ttf"),
                ("VLS-Vera-BoldItalic", "VeraBI.ttf"),
            ):
                pdfmetrics.registerFont(TTFont(name, file))
            pdfmetrics.registerFontFamily(
                "VLS-Vera", normal="VLS-Vera", bold="VLS-Vera-Bold",
                italic="VLS-Vera-Italic", boldItalic="VLS-Vera-BoldItalic",
            )
            sans = "VLS-Vera"
        except Exception:
            sans = None

    return {
        "body": body or sans or "Times-Roman",
        "sans": sans or "Helvetica",
        "mono": mono or "Courier",
    }


def _bold_of(name: str) -> str:
    """The registered bold face for a family, or the family itself."""
    for candidate in (f"{name}-Bold", {"Times-Roman": "Times-Bold", "Helvetica": "Helvetica-Bold"}.get(name, "")):
        if candidate and candidate in pdfmetrics.getRegisteredFontNames():
            return candidate
    return name


_FONTS = _register_fonts()
FONT_BODY = _FONTS["body"]
FONT_SANS = _FONTS["sans"]
FONT_MONO = _FONTS["mono"]
FONT_BODY_B = _bold_of(FONT_BODY)
FONT_SANS_B = _bold_of(FONT_SANS)


# --------------------------------------------------------------------------
# Styles
# --------------------------------------------------------------------------

def _styles() -> dict[str, ParagraphStyle]:
    base = ParagraphStyle(
        "body", fontName=FONT_BODY, fontSize=9.6, leading=14.4, textColor=INK,
        spaceAfter=7, alignment=TA_LEFT,
    )
    return {
        "body": base,
        "lead": ParagraphStyle("lead", parent=base, fontSize=11, leading=16.5, spaceAfter=10),
        "small": ParagraphStyle("small", parent=base, fontSize=8.3, leading=12, textColor=MUTED, spaceAfter=4),
        "cell": ParagraphStyle("cell", parent=base, fontSize=8.6, leading=12.4, spaceAfter=0),
        "cellMuted": ParagraphStyle("cellMuted", parent=base, fontSize=8.6, leading=12.4, spaceAfter=0, textColor=MUTED),
        "cellHead": ParagraphStyle(
            "cellHead", parent=base, fontName=FONT_SANS_B, fontSize=7.4, leading=10.5,
            textColor=MUTED, spaceAfter=0,
        ),
        "bullet": ParagraphStyle("bullet", parent=base, leftIndent=13, bulletIndent=2, spaceAfter=4),
        "subBullet": ParagraphStyle(
            "subBullet", parent=base, leftIndent=26, bulletIndent=15, spaceAfter=4,
            fontSize=9, leading=13, textColor=MUTED,
        ),
        "h1": ParagraphStyle(
            "h1", parent=base, fontName=FONT_SANS_B, fontSize=17, leading=21,
            textColor=INK, spaceBefore=6, spaceAfter=3,
        ),
        "h2": ParagraphStyle(
            "h2", parent=base, fontName=FONT_SANS_B, fontSize=11.6, leading=15,
            textColor=INK, spaceBefore=12, spaceAfter=4,
        ),
        "h3": ParagraphStyle(
            "h3", parent=base, fontName=FONT_SANS_B, fontSize=9.6, leading=13.5,
            textColor=TEAL, spaceBefore=8, spaceAfter=2,
        ),
        "eyebrow": ParagraphStyle(
            "eyebrow", parent=base, fontName=FONT_SANS_B, fontSize=7.6, leading=11,
            textColor=TEAL, spaceAfter=8,
        ),
        "coverTitle": ParagraphStyle(
            "coverTitle", parent=base, fontName=FONT_SANS_B, fontSize=25, leading=30,
            textColor=INK, spaceAfter=10,
        ),
        "coverSub": ParagraphStyle(
            "coverSub", parent=base, fontSize=11.5, leading=17, textColor=MUTED, spaceAfter=16,
        ),
        "callout": ParagraphStyle("callout", parent=base, fontSize=9.2, leading=13.6, spaceAfter=4),
        "calloutHead": ParagraphStyle(
            "calloutHead", parent=base, fontName=FONT_SANS_B, fontSize=8, leading=11.5, spaceAfter=3,
        ),
        "mono": ParagraphStyle(
            "mono", parent=base, fontName=FONT_MONO, fontSize=7.4, leading=10.4,
            textColor=MUTED, spaceAfter=2, wordWrap="CJK",
        ),
        "quote": ParagraphStyle(
            "quote", parent=base, fontSize=9.4, leading=14, leftIndent=12,
            textColor=MUTED, spaceAfter=6,
        ),
    }


S = _styles()


# --------------------------------------------------------------------------
# Text handling
# --------------------------------------------------------------------------

_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def _clean(value: Any) -> str:
    """Normalise arbitrary model text into something safe to typeset."""
    if value is None:
        return ""
    s = str(value)
    s = unicodedata.normalize("NFC", s)
    s = s.replace("\r\n", "\n").replace("\r", "\n")
    s = _CONTROL.sub("", s)
    return s.strip()


def _esc(value: Any) -> str:
    return html.escape(_clean(value), quote=False)


_RE_CODE = re.compile(r"`([^`\n]+)`")
_RE_BOLD = re.compile(r"\*\*(.+?)\*\*", re.S)
_RE_ITAL_STAR = re.compile(r"(?<!\*)\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)")
_RE_ITAL_UND = re.compile(r"(?<![\w\\])_(?!\s)([^_\n]+?)(?<!\s)_(?![\w])")
_RE_LINK = re.compile(r"\[([^\]\n]+)\]\((https?://[^)\s]+)\)")


def _inline(value: Any) -> str:
    """Convert the inline markdown subset the record uses into RML markup."""
    s = _esc(value)
    s = _RE_LINK.sub(r'<link href="\2" color="#0C8FA8">\1</link>', s)
    s = _RE_CODE.sub(
        lambda m: f'<font face="{FONT_MONO}" size="8.4">{m.group(1)}</font>', s
    )
    s = _RE_BOLD.sub(r"<b>\1</b>", s)
    s = _RE_ITAL_STAR.sub(r"<i>\1</i>", s)
    s = _RE_ITAL_UND.sub(r"<i>\1</i>", s)
    return s


_RE_BULLET = re.compile(r"^\s*[-*\u2022]\s+(.*)$")
_RE_NUMBER = re.compile(r"^\s*(\d{1,2})[.)]\s+(.*)$")
_RE_HEADING = re.compile(r"^\s*#{1,6}\s+(.*)$")


def _rich_text(value: Any, style: ParagraphStyle | None = None) -> list[Flowable]:
    """Render a free-text field that may contain light markdown.

    Model prose arrives with bullet lists, numbered steps and the occasional
    heading. Rendering it as one blob would lose that structure, which is often
    the difference between a readable recommendation and a wall of text.
    """
    body = style or S["body"]
    raw = _clean(value)
    if not raw:
        return []
    out: list[Flowable] = []
    for line in raw.split("\n"):
        stripped = line.strip()
        if not stripped:
            continue
        if m := _RE_HEADING.match(stripped):
            out.append(Paragraph(f"<b>{_inline(m.group(1))}</b>", body))
            continue
        if m := _RE_BULLET.match(stripped):
            out.append(Paragraph(_inline(m.group(1)), S["bullet"], bulletText="\u2022"))
            continue
        if m := _RE_NUMBER.match(stripped):
            out.append(Paragraph(_inline(m.group(2)), S["bullet"], bulletText=f"{m.group(1)}."))
            continue
        out.append(Paragraph(_inline(stripped), body))
    return out


def _para(value: Any, style: ParagraphStyle | None = None) -> Paragraph:
    return Paragraph(_inline(value), style or S["body"])


# --------------------------------------------------------------------------
# Shape tolerance
#
# summary_json is validated on write, but a record that has drifted off-schema
# is exactly the record a reader most needs to see. Refusing to typeset it
# would hide the problem behind a failed export, so the renderer coerces what
# it can, skips what it cannot, and says out loud when it skipped something.
# --------------------------------------------------------------------------

def _map(value: Any) -> dict[str, Any]:
    """A mapping, or an empty one."""
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list[Any]:
    """A list, or an empty one."""
    return value if isinstance(value, list) else []


def _maps(value: Any) -> tuple[list[dict[str, Any]], int]:
    """The mapping elements of a list, and how many elements were not mappings."""
    if not isinstance(value, list):
        return [], 0
    kept = [item for item in value if isinstance(item, dict)]
    return kept, len(value) - len(kept)


def _skipped(count: int, noun: str) -> list[Flowable]:
    """Account for entries the renderer could not lay out."""
    if count <= 0:
        return []
    return [
        Paragraph(
            _esc(
                f"{count} {noun} entr{'y' if count == 1 else 'ies'} in this record "
                f"could not be displayed because {'it does' if count == 1 else 'they do'} "
                "not match the expected structure. The raw values are in the "
                "reproducibility packet."
            ),
            S["small"],
        )
    ]


# --------------------------------------------------------------------------
# Small layout primitives
# --------------------------------------------------------------------------

def _chip_row(chips: Sequence[tuple[str, colors.Color]]) -> Flowable | None:
    """A row of status pills, each sized to its own label."""
    if not chips:
        return None
    cells = [
        Paragraph(
            f'<font color="{_hex(c)}" size="7.6"><b>{_esc(label.upper())}</b></font>',
            ParagraphStyle("chip", parent=S["cell"], fontName=FONT_SANS_B, leading=10),
        )
        for label, c in chips
    ]
    widths = [
        min(2.4 * inch, pdfmetrics.stringWidth(label.upper(), FONT_SANS_B, 7.6) + 16)
        for label, _ in chips
    ]
    table = Table([cells], colWidths=widths, hAlign="LEFT")
    style = [
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 3.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3.5),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
    ]
    for i, (_, c) in enumerate(chips):
        style.append(("BOX", (i, 0), (i, 0), 0.6, c))
    table.setStyle(TableStyle(style))
    return table


def _kv_table(rows: Sequence[tuple[str, Any]], label_width: float = 1.5 * inch) -> Flowable | None:
    """Two-column label/value table used for metadata blocks."""
    data = [
        [Paragraph(_esc(k).upper(), S["cellHead"]), Paragraph(_inline(v), S["cell"])]
        for k, v in rows
        if _clean(v)
    ]
    if not data:
        return None
    table = Table(data, colWidths=[label_width, CONTENT_WIDTH - label_width], hAlign="LEFT")
    table.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                ("LINEBELOW", (0, 0), (-1, -2), 0.4, RULE),
            ]
        )
    )
    return table


def _grid_table(
    header: Sequence[str],
    rows: Sequence[Sequence[Any]],
    widths: Sequence[float],
    aligns: Sequence[str] | None = None,
) -> Flowable | None:
    if not rows:
        return None
    data = [[Paragraph(_esc(h).upper(), S["cellHead"]) for h in header]]
    for row in rows:
        data.append([c if isinstance(c, Flowable) else Paragraph(_inline(c), S["cell"]) for c in row])
    table = Table(data, colWidths=list(widths), hAlign="LEFT", repeatRows=1)
    style = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("BACKGROUND", (0, 0), (-1, 0), TINT),
        ("LINEBELOW", (0, 0), (-1, 0), 0.6, RULE),
        ("LINEBELOW", (0, 1), (-1, -2), 0.35, RULE),
        ("BOX", (0, 0), (-1, -1), 0.6, RULE),
    ]
    for i, align in enumerate(aligns or []):
        style.append(("ALIGN", (i, 0), (i, -1), align))
    table.setStyle(TableStyle(style))
    return table


def _callout(
    title: str,
    lines: Iterable[Any],
    accent: colors.Color = TEAL,
    background: colors.Color = TINT_TEAL,
) -> Flowable:
    inner: list[Flowable] = []
    if title:
        inner.append(
            Paragraph(
                f'<font color="{_hex(accent)}">{_esc(title).upper()}</font>',
                S["calloutHead"],
            )
        )
    for line in lines:
        if isinstance(line, Flowable):
            inner.append(line)
        elif _clean(line):
            inner.append(_para(line, S["callout"]))
    table = Table([[inner]], colWidths=[CONTENT_WIDTH], hAlign="LEFT")
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), background),
                ("LINEBEFORE", (0, 0), (0, -1), 2.4, accent),
                ("BOX", (0, 0), (-1, -1), 0.4, RULE),
                ("TOPPADDING", (0, 0), (-1, -1), 9),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
                ("LEFTPADDING", (0, 0), (-1, -1), 11),
                ("RIGHTPADDING", (0, 0), (-1, -1), 11),
            ]
        )
    )
    return table


class SectionHeading(Paragraph):
    """A heading that also registers itself with the table of contents."""

    def __init__(self, label: str, level: int = 0, numbered: str | None = None):
        self.toc_level = level
        # The contents list repeats the body numbering so a reader can match
        # "9 Usage and cost" in the list to the heading on the page.
        self.toc_label = f"{numbered}  {label}" if numbered else label
        style = S["h1"] if level == 0 else S["h2"]
        prefix = f'<font color="{_hex(TEAL)}">{_esc(numbered)}  </font>' if numbered else ""
        super().__init__(prefix + _esc(label), style)


def _section(label: str, numbered: str | None = None) -> list[Flowable]:
    return [
        Spacer(1, 6),
        SectionHeading(label, level=0, numbered=numbered),
        HRFlowable(width="100%", thickness=1.1, color=TEAL, spaceBefore=2, spaceAfter=9),
    ]


def _sub(label: str) -> Flowable:
    return SectionHeading(label, level=1)


# --------------------------------------------------------------------------
# Formatting helpers
# --------------------------------------------------------------------------

def _dt(value: datetime | None, fallback: str = "—") -> str:
    if value is None:
        return fallback
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).strftime("%d %b %Y, %H:%M UTC")


def _duration(seconds: float) -> str:
    seconds = max(0.0, float(seconds or 0))
    if seconds < 60:
        return f"{seconds:.1f}s"
    minutes, rest = divmod(int(round(seconds)), 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}h {minutes:02d}m {rest:02d}s"
    return f"{minutes}m {rest:02d}s"


# Kept character-for-character in step with artifacts/web/src/lib/cost.ts. A
# reader holding the printed report next to the screen must see the same figure
# and the same explanation, so both the placeholder and the hint are copied
# verbatim rather than reworded here.
UNPRICED_COST_DISPLAY = "—"
UNPRICED_COST_HINT = (
    "No pricing configured for this model — tokens were used but cost cannot be computed."
)


def _cost(run: Run) -> tuple[str, str | None]:
    """Mirror the UI's cost rule so paper and screen never disagree.

    A model with no configured pricing records cost 0, which is indistinguishable
    from a genuinely free run — so it is shown as unavailable, with the reason.
    """
    tokens = int(run.input_tokens or 0) + int(run.output_tokens or 0)
    cost = float(run.actual_cost_usd or 0)
    if tokens > 0 and cost == 0 and not run.demo_mode:
        return UNPRICED_COST_DISPLAY, UNPRICED_COST_HINT
    return f"${cost:.2f}", None


_SEVERITY_COLOR = {"critical": RED, "high": RED, "medium": AMBER, "low": MUTED}
_PRIORITY_COLOR = {"now": RED, "next": AMBER, "later": MUTED}
_IMPACT_COLOR = {"high": RED, "medium": AMBER, "low": MUTED}
_SUPPORT_COLOR = {"supports": GREEN, "contradicts": RED, "uncertain": AMBER, "context": MUTED}
_RESOLUTION_COLOR = {
    "resolved": GREEN, "lead_decision": TEAL, "unresolved": RED, "needs_evidence": AMBER,
}


def _tag(value: Any, palette: dict[str, colors.Color]) -> Paragraph:
    label = _clean(value).replace("_", " ")
    if not label:
        return Paragraph("", S["cell"])
    color = palette.get(_clean(value).lower(), MUTED)
    return Paragraph(
        f'<font color="{_hex(color)}"><b>{_esc(label.upper())}</b></font>',
        ParagraphStyle("tag", parent=S["cell"], fontName=FONT_SANS_B, fontSize=7.4, leading=10.5),
    )


# --------------------------------------------------------------------------
# Page furniture
# --------------------------------------------------------------------------

class _NumberedCanvas(Canvas):
    """Two-pass canvas so the footer can print "page X of Y"."""

    def __init__(self, *args: Any, **kwargs: Any):
        self._footer_note: str = kwargs.pop("footer_note", "")
        super().__init__(*args, **kwargs)
        self._pages: list[dict[str, Any]] = []

    def showPage(self) -> None:  # noqa: N802 - reportlab API
        self._pages.append(dict(self.__dict__))
        self._startPage()

    def save(self) -> None:
        total = len(self._pages)
        for state in self._pages:
            self.__dict__.update(state)
            self._draw_footer(total)
            super().showPage()
        super().save()

    def _draw_footer(self, total: int) -> None:
        self.saveState()
        self.setStrokeColor(RULE)
        self.setLineWidth(0.5)
        self.line(MARGIN_X, MARGIN_BOTTOM - 20, PAGE_SIZE[0] - MARGIN_X, MARGIN_BOTTOM - 20)
        self.setFont(FONT_SANS, 7)
        self.setFillColor(MUTED)
        self.drawString(MARGIN_X, MARGIN_BOTTOM - 32, self._footer_note)
        self.drawRightString(
            PAGE_SIZE[0] - MARGIN_X, MARGIN_BOTTOM - 32,
            f"Page {self._pageNumber} of {total}",
        )
        self.restoreState()


def _make_header(title: str, run_label: str):
    def draw(canvas: Canvas, doc: BaseDocTemplate) -> None:
        if doc.page == 1:
            return
        canvas.saveState()
        y = PAGE_SIZE[1] - MARGIN_TOP + 26
        canvas.setFont(FONT_SANS, 7.2)
        canvas.setFillColor(MUTED)
        canvas.drawString(MARGIN_X, y, title[:88])
        canvas.drawRightString(PAGE_SIZE[0] - MARGIN_X, y, run_label)
        canvas.setStrokeColor(RULE)
        canvas.setLineWidth(0.5)
        canvas.line(MARGIN_X, y - 6, PAGE_SIZE[0] - MARGIN_X, y - 6)
        canvas.restoreState()

    return draw


class _ReportDoc(BaseDocTemplate):
    def __init__(self, buffer: io.BytesIO, title: str, run_label: str, **kwargs: Any):
        super().__init__(
            buffer, pagesize=PAGE_SIZE, leftMargin=MARGIN_X, rightMargin=MARGIN_X,
            topMargin=MARGIN_TOP, bottomMargin=MARGIN_BOTTOM,
            title=title, author="Virtual Lab Studio", subject=run_label, **kwargs,
        )
        frame = Frame(
            MARGIN_X, MARGIN_BOTTOM, CONTENT_WIDTH,
            PAGE_SIZE[1] - MARGIN_TOP - MARGIN_BOTTOM, id="content",
            leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0,
        )
        self.addPageTemplates(
            [PageTemplate(id="main", frames=[frame], onPage=_make_header(title, run_label))]
        )

    def afterFlowable(self, flowable: Flowable) -> None:
        if isinstance(flowable, SectionHeading):
            self.notify(
                "TOCEntry", (flowable.toc_level, flowable.toc_label, self.page)
            )


# --------------------------------------------------------------------------
# Data gathering
# --------------------------------------------------------------------------

class _ReportData:
    def __init__(self, **kwargs: Any):
        self.__dict__.update(kwargs)


async def _gather(db: AsyncSession, run: Run) -> _ReportData:
    definition = await db.get(MeetingDefinition, run.meeting_definition_id)
    project = await db.get(Project, run.project_id)
    summary = await db.get(RunSummary, run.id)
    manifest = await db.get(RunManifest, run.id)
    turns = list(
        (
            await db.execute(
                select(RunTurn).where(RunTurn.run_id == run.id).order_by(RunTurn.sequence)
            )
        ).scalars()
    )
    citations = list(
        (
            await db.execute(
                select(RunCitation)
                .where(RunCitation.run_id == run.id)
                .order_by(RunCitation.created_at)
            )
        ).scalars()
    )
    interventions = list(
        (
            await db.execute(
                select(RunIntervention)
                .where(RunIntervention.run_id == run.id)
                .order_by(RunIntervention.created_at)
            )
        ).scalars()
    )
    reviews = list(
        (
            await db.execute(
                select(RunReview).where(RunReview.run_id == run.id).order_by(RunReview.created_at)
            )
        ).scalars()
    )
    agent_rows = (
        await db.execute(
            text(
                """
                SELECT DISTINCT p.id AS profile_id, p.title, v.version_number,
                       v.expertise, v.goal, v.role, v.system_prompt_sha256,
                       min(t.sequence) AS first_turn,
                       max(t.role_type::text) AS role_type
                FROM run_turns t
                JOIN agent_versions v ON v.id = t.agent_version_id
                JOIN agent_profiles p ON p.id = v.agent_profile_id
                WHERE t.run_id = :run_id
                GROUP BY p.id, p.title, v.version_number, v.expertise, v.goal,
                         v.role, v.system_prompt_sha256
                ORDER BY first_turn
                """
            ),
            {"run_id": str(run.id)},
        )
    ).mappings().all()
    titles_by_version = {
        str(r["agent_version_id"]): r["title"]
        for r in (
            await db.execute(
                text(
                    """
                    SELECT DISTINCT v.id AS agent_version_id, p.title
                    FROM run_turns t
                    JOIN agent_versions v ON v.id = t.agent_version_id
                    JOIN agent_profiles p ON p.id = v.agent_profile_id
                    WHERE t.run_id = :run_id
                    """
                ),
                {"run_id": str(run.id)},
            )
        ).mappings()
    }
    return _ReportData(
        definition=definition,
        project=project,
        summary=summary,
        manifest=manifest,
        turns=turns,
        citations=citations,
        interventions=interventions,
        reviews=reviews,
        agents=list(agent_rows),
        titles_by_version=titles_by_version,
        evidence=frozen_evidence(definition) if definition else [],
    )


# --------------------------------------------------------------------------
# Cover
# --------------------------------------------------------------------------

def _cover(run: Run, data: _ReportData, generated_at: datetime, sections: set[str]) -> list[Flowable]:
    definition = data.definition
    title = _clean(definition.title if definition else "") or f"Run {str(run.id)[:8]}"
    story: list[Flowable] = [
        Paragraph("VIRTUAL LAB STUDIO  ·  MEETING REPORT", S["eyebrow"]),
        Paragraph(_esc(title), S["coverTitle"]),
    ]
    if definition and _clean(definition.agenda):
        story.append(_para(definition.agenda, S["coverSub"]))

    chips: list[tuple[str, colors.Color]] = [
        (
            _clean(run.status).replace("_", " "),
            GREEN if run.status == "completed" else RED if run.status in {"failed", "budget_stopped"} else MUTED,
        ),
        (
            f"review: {_clean(run.review_status).replace('_', ' ')}",
            GREEN if run.review_status == "approved" else AMBER,
        ),
        ("simulated · demo mode" if run.demo_mode else "live providers", VIOLET if run.demo_mode else TEAL),
    ]
    chip_row = _chip_row(chips)
    if chip_row is not None:
        story.extend([chip_row, Spacer(1, 18)])

    cost_text, cost_note = _cost(run)
    meta: list[tuple[str, Any]] = [
        ("Project", data.project.name if data.project else "—"),
        ("Meeting type", _clean(definition.meeting_type).replace("_", " ") if definition else "—"),
        ("Run ID", f"`{run.id}`"),
        ("Started", _dt(run.started_at or run.created_at)),
        ("Finished", _dt(run.completed_at)),
        ("Elapsed", _duration(float(run.wall_seconds or 0))),
        ("Rounds", str(definition.rounds) if definition else "—"),
        ("Agent turns", str(len(data.turns))),
        ("Model calls", str(run.provider_call_count)),
        ("Cost", cost_text),
    ]
    if definition and definition.seed is not None:
        meta.append(("Seed", str(definition.seed)))
    table = _kv_table(meta)
    if table is not None:
        story.extend([table, Spacer(1, 8)])
    if cost_note:
        story.extend([Paragraph(_esc(cost_note), S["small"]), Spacer(1, 4)])

    story.append(Spacer(1, 10))

    warnings: list[Any] = [
        "Every finding in this document was produced by large language models. "
        "It is a record of a structured deliberation, not a peer-reviewed result, "
        "and it must be checked by a qualified human expert before it informs any "
        "scientific, clinical, or funding decision.",
    ]
    if run.review_status != "approved":
        warnings.append(
            f"**This run has not been approved by a human reviewer** "
            f"(review status: {_clean(run.review_status).replace('_', ' ')})."
        )
    if run.demo_mode:
        warnings.append(
            "**Simulated run.** The agent responses were generated by the built-in "
            "demo provider, not by a real model. Nothing here reflects real model "
            "capability and it must not be cited as a result."
        )
    story.append(
        _callout(
            "Read this first",
            warnings,
            accent=VIOLET if run.demo_mode else AMBER,
            background=TINT_WARN,
        )
    )

    story.append(Spacer(1, 14))
    included = [SECTION_TITLES[s] for s in PDF_REPORT_SECTIONS if s in sections]
    story.append(
        Paragraph(
            "Generated " + _dt(generated_at) + " · Conclusions record"
            + (" · " + ", ".join(included) if included else " only"),
            S["small"],
        )
    )
    return story


def _toc() -> list[Flowable]:
    toc = TableOfContents()
    toc.levelStyles = [
        ParagraphStyle(
            "toc0", fontName=FONT_SANS_B, fontSize=9.4, leading=17, textColor=INK,
            firstLineIndent=-14, leftIndent=14,
        ),
        ParagraphStyle(
            "toc1", fontName=FONT_BODY, fontSize=8.8, leading=14, textColor=MUTED,
            firstLineIndent=-12, leftIndent=30,
        ),
    ]
    return [
        PageBreak(),
        Paragraph("Contents", S["h1"]),
        HRFlowable(width="100%", thickness=1.1, color=TEAL, spaceBefore=2, spaceAfter=12),
        toc,
    ]


# --------------------------------------------------------------------------
# The conclusions record — always rendered
# --------------------------------------------------------------------------

def _conclusions(run: Run, data: _ReportData) -> list[Flowable]:
    story: list[Flowable] = [PageBreak()]
    summary = data.summary
    if summary is None:
        story.extend(_section("Conclusions", "1"))
        story.append(
            _callout(
                "No structured conclusions were recorded",
                [
                    "This run finished without producing a structured summary, so there "
                    "is no conclusions record to report. The transcript and provenance "
                    "appendices — where selected — still describe what happened.",
                    f"Run status: **{_clean(run.status).replace('_', ' ')}**."
                    + (
                        f" Reported reason: {_esc(run.failure_safe_message)}"
                        if _clean(run.failure_safe_message)
                        else ""
                    ),
                ],
                accent=RED,
                background=TINT_WARN,
            )
        )
        return story

    sj: dict[str, Any] = _map(summary.summary_json)
    story.extend(_section("Conclusions", "1"))

    if summary.validation_status != "valid":
        story.extend(
            [
                _callout(
                    "This record failed schema validation",
                    [
                        "The structured summary did not validate against the meeting "
                        "summary schema, so fields may be missing or malformed. It is "
                        "reproduced here for inspection and must not be cited.",
                    ],
                    accent=RED,
                    background=TINT_WARN,
                ),
                Spacer(1, 10),
            ]
        )

    if exec_summary := _clean(sj.get("executive_summary")):
        story.append(_sub("Executive summary"))
        story.extend(_rich_text(exec_summary, S["lead"]))

    rec = _map(sj.get("recommendation"))
    if decision := _clean(rec.get("decision")):
        story.append(_sub("Recommendation"))
        story.append(
            _callout("Decision", [Paragraph(f"<b>{_inline(decision)}</b>", S["callout"])])
        )
        story.append(Spacer(1, 8))
        story.extend(_rich_text(rec.get("rationale")))
        if conditions := [c for c in _list(rec.get("conditions")) if _clean(c)]:
            story.append(Paragraph("<b>Required conditions</b>", S["body"]))
            story.extend(
                Paragraph(_inline(c), S["bullet"], bulletText="\u2022") for c in conditions
            )
        raw_alts, bad_alts = _maps(rec.get("alternatives_considered"))
        alternatives = [a for a in raw_alts if _clean(a.get("alternative"))]
        if alternatives:
            table = _grid_table(
                ["Alternative", "Why it was not selected"],
                [[a.get("alternative"), a.get("reason_not_selected")] for a in alternatives],
                [CONTENT_WIDTH * 0.38, CONTENT_WIDTH * 0.62],
            )
            if table is not None:
                story.extend([Spacer(1, 6), Paragraph("<b>Alternatives considered</b>", S["body"]), table])
        story.extend(_skipped(bad_alts, "alternative"))

    qas, bad_qas = _maps(sj.get("question_answers"))
    story.append(_sub("Agenda questions"))
    if not qas:
        story.append(
            _para(
                "No agenda questions were set for this meeting, so the record answers "
                "none. The agenda itself is what the team deliberated on.",
                S["quote"],
            )
        )
    else:
        for qa in qas:
            block: list[Flowable] = [
                Paragraph(_inline(qa.get("question")), S["h3"]),
            ]
            block.extend(_rich_text(qa.get("answer")))
            meta: list[str] = []
            confidence = qa.get("confidence")
            if isinstance(confidence, (int, float)):
                meta.append(f"Stated confidence {float(confidence):.2f}")
            if ids := [_clean(i) for i in _list(qa.get("evidence_ids")) if _clean(i)]:
                meta.append("Evidence " + ", ".join(f"`{i}`" for i in ids))
            if meta:
                block.append(_para(" · ".join(meta), S["small"]))
            if open_issue := _clean(qa.get("open_issue")):
                block.append(_para(f"*Open issue: {open_issue}*", S["small"]))
            story.append(KeepTogether(block[:2]) if len(block) > 1 else block[0])
            story.extend(block[2:] if len(block) > 1 else [])
    story.extend(_skipped(bad_qas, "agenda question"))

    disagreements, bad_disagreements = _maps(sj.get("disagreements"))
    if disagreements:
        story.append(_sub("Disagreements"))
        story.append(
            _para(
                "Where the team did not converge. These matter most when deciding how "
                "much weight to give the recommendation.",
                S["small"],
            )
        )
        for item in disagreements:
            positions, _bad_positions = _maps(item.get("positions"))
            rows = [
                [
                    Paragraph(f"<b>{_inline(p.get('agent_title'))}</b>", S["cell"]),
                    Paragraph(_inline(p.get("position")), S["cell"]),
                ]
                for p in positions
            ]
            block: list[Flowable] = [Paragraph(_inline(item.get("topic")), S["h3"])]
            table = _grid_table(
                ["Position held by", "Position"], rows,
                [CONTENT_WIDTH * 0.28, CONTENT_WIDTH * 0.72],
            )
            if table is not None:
                block.append(table)
            status = _clean(item.get("resolution_status"))
            if status:
                resolution = _clean(item.get("resolution"))
                block.append(Spacer(1, 3))
                block.append(
                    Paragraph(
                        f'<font color="{_hex(_RESOLUTION_COLOR.get(status, MUTED))}">'
                        f"<b>{_esc(status.replace('_', ' ').upper())}</b></font>"
                        + (f" — {_inline(resolution)}" if resolution else ""),
                        S["small"],
                    )
                )
            story.append(KeepTogether(block))
            story.append(Spacer(1, 6))
        story.extend(_skipped(bad_disagreements, "disagreement"))

    assumptions, bad_assumptions = _maps(sj.get("assumptions"))
    if assumptions:
        story.append(_sub("Assumptions"))
        table = _grid_table(
            ["Assumption", "Impact", "How to validate"],
            [
                [
                    a.get("assumption"),
                    _tag(a.get("impact"), _IMPACT_COLOR),
                    a.get("validation"),
                ]
                for a in assumptions
            ],
            [CONTENT_WIDTH * 0.42, CONTENT_WIDTH * 0.13, CONTENT_WIDTH * 0.45],
        )
        if table is not None:
            story.append(table)
        story.extend(_skipped(bad_assumptions, "assumption"))

    risks, bad_risks = _maps(sj.get("risks_and_limitations"))
    if risks:
        story.append(_sub("Risks and limitations"))
        table = _grid_table(
            ["Risk", "Severity", "Likelihood", "Mitigation"],
            [
                [
                    r.get("risk"),
                    _tag(r.get("severity"), _SEVERITY_COLOR),
                    _tag(r.get("likelihood"), {"likely": RED, "possible": AMBER, "unlikely": MUTED}),
                    r.get("mitigation"),
                ]
                for r in risks
            ],
            [CONTENT_WIDTH * 0.34, CONTENT_WIDTH * 0.12, CONTENT_WIDTH * 0.13, CONTENT_WIDTH * 0.41],
        )
        if table is not None:
            story.append(table)
        story.extend(_skipped(bad_risks, "risk"))

    next_steps, bad_steps = _maps(sj.get("next_steps"))
    if next_steps:
        story.append(_sub("Next steps"))
        table = _grid_table(
            ["Action", "Owner role", "Priority", "Done when"],
            [
                [
                    s.get("action"),
                    s.get("owner_role"),
                    _tag(s.get("priority"), _PRIORITY_COLOR),
                    s.get("acceptance_criterion"),
                ]
                for s in next_steps
            ],
            [CONTENT_WIDTH * 0.33, CONTENT_WIDTH * 0.16, CONTENT_WIDTH * 0.11, CONTENT_WIDTH * 0.40],
        )
        if table is not None:
            story.append(table)
        story.extend(_skipped(bad_steps, "next step"))

    evidence, bad_evidence = _maps(sj.get("evidence"))
    if evidence:
        story.append(_sub("Evidence cited in the conclusions"))
        table = _grid_table(
            ["ID", "Claim", "Support", "Locator"],
            [
                [
                    Paragraph(_esc(e.get("evidence_id")), S["mono"]),
                    e.get("claim"),
                    _tag(e.get("support_type"), _SUPPORT_COLOR),
                    e.get("locator") or "—",
                ]
                for e in evidence
            ],
            [CONTENT_WIDTH * 0.14, CONTENT_WIDTH * 0.48, CONTENT_WIDTH * 0.13, CONTENT_WIDTH * 0.25],
        )
        if table is not None:
            story.append(table)
        story.extend(_skipped(bad_evidence, "evidence"))

    contributions, bad_contributions = _maps(sj.get("role_contributions"))
    if contributions:
        story.append(_sub("Team member contributions"))
        for item in contributions:
            block = [Paragraph(_inline(item.get("agent_title")), S["h3"])]
            block.extend(_rich_text(item.get("contribution")))
            story.append(KeepTogether(block[:2]) if len(block) > 1 else block[0])
            story.extend(block[2:] if len(block) > 1 else [])
        story.extend(_skipped(bad_contributions, "contribution"))

    conf = _map(sj.get("confidence"))
    overall = conf.get("overall")
    if isinstance(overall, (int, float)):
        story.append(_sub("Confidence"))
        lines: list[Any] = [
            Paragraph(
                f'<font size="15"><b>{float(overall):.2f}</b></font>'
                '<font size="9"> — as stated by the model that held the meeting, '
                "not an independent measure of correctness.</font>",
                S["callout"],
            )
        ]
        if basis := _clean(conf.get("basis")):
            lines.append(f"**Basis.** {basis}")
        if uncertainty := _clean(conf.get("uncertainty")):
            lines.append(f"**Remaining uncertainty.** {uncertainty}")
        story.append(_callout("", lines))

    disclosure = _map(sj.get("disclosure"))
    limitations = [_clean(x) for x in _list(disclosure.get("limitations")) if _clean(x)]
    if limitations or disclosure.get("human_review_required"):
        story.append(_sub("Disclosure"))
        story.extend(
            Paragraph(_inline(x), S["bullet"], bulletText="\u2022") for x in limitations
        )
        if disclosure.get("human_review_required"):
            story.append(
                _para(
                    "Human expert review is required before this result is relied on.",
                    S["body"],
                )
            )
    return story


# --------------------------------------------------------------------------
# Appendices
# --------------------------------------------------------------------------

def _appendix_meeting_brief(data: _ReportData, index: str) -> list[Flowable]:
    definition = data.definition
    story = _section(SECTION_TITLES["meeting_brief"], index)
    if definition is None:
        story.append(_para("The meeting definition for this run is unavailable.", S["quote"]))
        return story
    story.append(_sub("Agenda"))
    story.extend(_rich_text(definition.agenda, S["lead"]))
    questions = [q for q in _list(definition.questions) if _clean(q)]
    story.append(_sub("Agenda questions"))
    if questions:
        story.extend(
            Paragraph(_inline(q), S["bullet"], bulletText=f"{i}.")
            for i, q in enumerate(questions, start=1)
        )
    else:
        story.append(_para("No agenda questions were set for this meeting.", S["quote"]))
    if rules := [r for r in _list(definition.rules) if _clean(r)]:
        story.append(_sub("Meeting rules"))
        story.extend(Paragraph(_inline(r), S["bullet"], bulletText="\u2022") for r in rules)
    story.append(_sub("Settings"))
    budget = _map(definition.budget)
    table = _kv_table(
        [
            ("Rounds", str(definition.rounds)),
            ("Temperature", f"{float(definition.default_temperature):.2f}"),
            ("Seed", str(definition.seed) if definition.seed is not None else "not set"),
            ("Max cost", f"${float(budget['max_cost_usd']):.2f}" if budget.get("max_cost_usd") is not None else ""),
            ("Max wall time", f"{budget['max_wall_seconds']}s" if budget.get("max_wall_seconds") is not None else ""),
            ("Definition SHA-256", f"`{definition.definition_sha256}`"),
        ]
    )
    if table is not None:
        story.append(table)
    return story


def _appendix_question_detail(data: _ReportData, index: str) -> list[Flowable]:
    """Each agenda question on its own, with the evidence it leaned on."""
    story = _section(SECTION_TITLES["question_answers_detail"], index)
    sj = _map(data.summary.summary_json if data.summary else {})
    qas, bad_qas = _maps(sj.get("question_answers"))
    if not qas:
        story.append(
            _para(
                "No agenda questions were set for this meeting, so there are none to "
                "expand on here.",
                S["quote"],
            )
        )
        story.extend(_skipped(bad_qas, "agenda question"))
        return story
    frozen_evidence, _bad_frozen = _maps(data.evidence)
    evidence_by_key = {
        _clean(e.get("evidence_key")): e for e in frozen_evidence if _clean(e.get("evidence_key"))
    }
    for i, qa in enumerate(qas, start=1):
        story.append(_sub(f"Q{i}. {_clean(qa.get('question'))}"))
        story.extend(_rich_text(qa.get("answer")))
        confidence = qa.get("confidence")
        rows: list[tuple[str, Any]] = []
        if isinstance(confidence, (int, float)):
            rows.append(("Stated confidence", f"{float(confidence):.2f}"))
        if open_issue := _clean(qa.get("open_issue")):
            rows.append(("Open issue", open_issue))
        cited = [_clean(x) for x in _list(qa.get("evidence_ids")) if _clean(x)]
        if cited:
            rows.append(
                (
                    "Evidence",
                    "; ".join(
                        f"`{key}` {_clean(_map(evidence_by_key.get(key)).get('title')) or '(not attached to this meeting)'}"
                        for key in cited
                    ),
                )
            )
        table = _kv_table(rows, label_width=1.25 * inch)
        if table is not None:
            story.extend([Spacer(1, 2), table, Spacer(1, 6)])
    story.extend(_skipped(bad_qas, "agenda question"))
    return story


def _appendix_transcript(data: _ReportData, index: str) -> list[Flowable]:
    story = _section(SECTION_TITLES["transcript"], index)
    if not data.turns:
        story.append(_para("This run recorded no agent turns.", S["quote"]))
        return story
    story.append(
        _para(
            f"{len(data.turns)} turns, in the order they were produced. Text is "
            "reproduced verbatim from the run record.",
            S["small"],
        )
    )
    for turn in data.turns:
        title = data.titles_by_version.get(str(turn.agent_version_id), "Agent")
        header = Paragraph(
            f"{_esc(title)} "
            f'<font color="{_hex(MUTED)}" size="8">· turn {turn.sequence} '
            f"· round {turn.round_number} · {_esc(_clean(turn.role_type).replace('_', ' '))}</font>",
            S["h3"],
        )
        body = _rich_text(turn.response_text) or [
            _para(
                f"(no text was recorded for this turn — status {_clean(turn.status)})",
                S["quote"],
            )
        ]
        story.append(KeepTogether([header, body[0]]))
        story.extend(body[1:])
        story.append(Spacer(1, 4))
    return story


def _appendix_final_synthesis(data: _ReportData, index: str) -> list[Flowable]:
    story = _section(SECTION_TITLES["final_synthesis"], index)
    final = next(
        (t for t in reversed(data.turns) if _clean(t.response_text)),
        None,
    )
    if final is None:
        story.append(_para("No final synthesis text was recorded for this run.", S["quote"]))
        return story
    story.append(
        _para(
            "The closing turn exactly as the model wrote it, before it was extracted "
            "into the structured record above.",
            S["small"],
        )
    )
    story.extend(_rich_text(final.response_text))
    return story


def _appendix_evidence(data: _ReportData, index: str) -> list[Flowable]:
    story = _section(SECTION_TITLES["evidence"], index)
    if not data.evidence:
        story.append(
            _para(
                "No evidence was attached to this meeting before it was launched, so "
                "the agents worked from the agenda and their own priors alone. "
                "Statements in this report are not grounded in supplied sources.",
                S["quote"],
            )
        )
        return story
    story.append(
        _para(
            "Sources frozen into the meeting definition at launch. The hash is of the "
            "source text as it stood at that moment, so a later edit to the library "
            "cannot silently change what the agents read.",
            S["small"],
        )
    )
    frozen, bad_frozen = _maps(data.evidence)
    for item in frozen:
        block: list[Flowable] = [
            Paragraph(
                f'<font face="{FONT_MONO}" size="8.4" color="{_hex(TEAL)}">'
                f"{_esc(item.get('evidence_key'))}</font>  {_inline(item.get('title'))}",
                S["h3"],
            )
        ]
        table = _kv_table(
            [
                ("Type", _clean(item.get("source_type")).replace("_", " ")),
                ("Citation", item.get("citation")),
                ("URL", item.get("source_url")),
                ("Content SHA-256", f"`{_clean(item.get('content_sha256'))}`"),
                ("Excerpts frozen", str(len(_list(item.get("chunk_ids"))))),
            ],
            label_width=1.3 * inch,
        )
        if table is not None:
            block.append(table)
        story.append(KeepTogether(block))
        story.append(Spacer(1, 8))
    story.extend(_skipped(bad_frozen, "evidence"))
    return story


def _appendix_citations(data: _ReportData, index: str) -> list[Flowable]:
    story = _section(SECTION_TITLES["citations"], index)
    if not data.citations:
        story.append(
            _para(
                "No citations were recorded. A citation is created when the structured "
                "record points a claim at an evidence ID; with no evidence attached to "
                "the meeting there is nothing to cite.",
                S["quote"],
            )
        )
        return story
    table = _grid_table(
        ["Key", "Claim", "Support", "Validation", "Locator"],
        [
            [
                Paragraph(_esc(c.citation_key), S["mono"]),
                c.claim_text,
                _tag(c.support_type, _SUPPORT_COLOR),
                _tag(
                    c.validation_status,
                    {"validated": GREEN, "unmatched": RED, "unvalidated": AMBER},
                ),
                c.source_locator or "—",
            ]
            for c in data.citations
        ],
        [
            CONTENT_WIDTH * 0.13, CONTENT_WIDTH * 0.42, CONTENT_WIDTH * 0.12,
            CONTENT_WIDTH * 0.14, CONTENT_WIDTH * 0.19,
        ],
    )
    if table is not None:
        story.append(table)
    unmatched = [c for c in data.citations if c.validation_status != "validated"]
    if unmatched:
        story.extend(
            [
                Spacer(1, 8),
                _callout(
                    f"{len(unmatched)} citation(s) could not be matched to attached evidence",
                    [
                        "A claim points at an evidence ID that was not frozen into this "
                        "meeting. Treat those claims as unsupported until the source is "
                        "attached and the run repeated.",
                    ],
                    accent=AMBER,
                    background=TINT_WARN,
                ),
            ]
        )
    return story


def _appendix_agents(data: _ReportData, index: str) -> list[Flowable]:
    story = _section(SECTION_TITLES["agents"], index)
    if not data.agents:
        story.append(_para("No agents are recorded for this run.", S["quote"]))
        return story
    story.append(
        _para(
            "The team that held the meeting. The prompt hash identifies the exact "
            "system prompt version each agent ran with; the full prompt text ships in "
            "the reproducibility packet.",
            S["small"],
        )
    )
    for row in data.agents:
        block: list[Flowable] = [
            Paragraph(
                f"{_esc(row['title'])} "
                f'<font color="{_hex(MUTED)}" size="8">· '
                f"{_esc(_clean(row['role_type']).replace('_', ' '))} · v{row['version_number']}</font>",
                S["h3"],
            )
        ]
        table = _kv_table(
            [
                ("Expertise", row["expertise"]),
                ("Goal", row["goal"]),
                ("Role", row["role"]),
                ("Prompt SHA-256", f"`{row['system_prompt_sha256']}`"),
            ],
            label_width=1.2 * inch,
        )
        if table is not None:
            block.append(table)
        story.append(KeepTogether(block))
        story.append(Spacer(1, 8))
    return story


def _appendix_usage(run: Run, data: _ReportData, index: str) -> list[Flowable]:
    story = _section(SECTION_TITLES["usage"], index)
    cost_text, cost_note = _cost(run)
    table = _kv_table(
        [
            ("Model calls", f"{run.provider_call_count:,}"),
            ("Tool calls", f"{run.tool_call_count:,}"),
            ("Input tokens", f"{int(run.input_tokens or 0):,}"),
            ("Cached input tokens", f"{int(run.cached_input_tokens or 0):,}"),
            ("Output tokens", f"{int(run.output_tokens or 0):,}"),
            ("Recorded cost", cost_text),
            ("Elapsed", _duration(float(run.wall_seconds or 0))),
            ("Attempts", str(run.attempt_count)),
            ("Mode", "simulated (demo provider)" if run.demo_mode else "live providers"),
        ]
    )
    if table is not None:
        story.append(table)
    if cost_note:
        story.extend([Spacer(1, 8), _callout("Cost unavailable", [cost_note], accent=AMBER, background=TINT_WARN)])
    if run.demo_mode:
        story.extend(
            [
                Spacer(1, 8),
                _callout(
                    "Simulated run",
                    [
                        "Token counts and cost for a demo run are synthetic. They describe "
                        "the simulation, not spend with a model provider.",
                    ],
                    accent=VIOLET,
                    background=TINT_WARN,
                ),
            ]
        )
    if data.turns:
        story.append(_sub("Per-turn detail"))
        rows = [
            [
                str(t.sequence),
                data.titles_by_version.get(str(t.agent_version_id), "Agent"),
                f"{int(t.input_tokens or 0):,}",
                f"{int(t.output_tokens or 0):,}",
                f"{int(t.latency_ms or 0):,} ms" if t.latency_ms else "—",
                _clean(t.status),
            ]
            for t in data.turns
        ]
        table = _grid_table(
            ["#", "Agent", "In", "Out", "Latency", "Status"],
            rows,
            [
                CONTENT_WIDTH * 0.07, CONTENT_WIDTH * 0.35, CONTENT_WIDTH * 0.13,
                CONTENT_WIDTH * 0.13, CONTENT_WIDTH * 0.16, CONTENT_WIDTH * 0.16,
            ],
            aligns=["RIGHT", "LEFT", "RIGHT", "RIGHT", "RIGHT", "LEFT"],
        )
        if table is not None:
            story.append(table)
    return story


def _appendix_interventions(data: _ReportData, index: str) -> list[Flowable]:
    story = _section(SECTION_TITLES["interventions"], index)
    if not data.interventions:
        story.append(
            _para(
                "No human interventions were recorded. The meeting ran from its frozen "
                "definition without mid-run steering.",
                S["quote"],
            )
        )
        return story
    table = _grid_table(
        ["When", "Kind", "Checkpoint", "Content"],
        [
            [
                _dt(iv.created_at),
                _clean(iv.kind).replace("_", " "),
                iv.applied_at_checkpoint or "—",
                iv.content or "—",
            ]
            for iv in data.interventions
        ],
        [CONTENT_WIDTH * 0.2, CONTENT_WIDTH * 0.15, CONTENT_WIDTH * 0.17, CONTENT_WIDTH * 0.48],
    )
    if table is not None:
        story.append(table)
    return story


def _appendix_reviews(run: Run, data: _ReportData, index: str) -> list[Flowable]:
    story = _section(SECTION_TITLES["reviews"], index)
    if not data.reviews:
        story.append(
            _callout(
                "Not reviewed by a human",
                [
                    "No reviewer has recorded a decision on this run. Its conclusions "
                    "carry no human endorsement.",
                ],
                accent=AMBER,
                background=TINT_WARN,
            )
        )
        return story
    story.append(
        _para(f"Overall review status: **{_clean(run.review_status).replace('_', ' ')}**.", S["body"])
    )
    for review in data.reviews:
        block: list[Flowable] = [
            Paragraph(
                f"{_esc(_clean(review.status).replace('_', ' ').title())} "
                f'<font color="{_hex(MUTED)}" size="8">· {_esc(_dt(review.created_at))}</font>',
                S["h3"],
            )
        ]
        ratings = _map(review.ratings)
        if ratings:
            rating_table = _grid_table(
                ["Criterion", "Rating"],
                [[k.replace("_", " "), str(v)] for k, v in sorted(ratings.items())],
                [CONTENT_WIDTH * 0.7, CONTENT_WIDTH * 0.3],
            )
            if rating_table is not None:
                block.append(rating_table)
        story.append(KeepTogether(block))
        story.extend(_rich_text(review.comments_markdown))
        story.append(Spacer(1, 6))
    return story


def _appendix_provenance(run: Run, data: _ReportData, index: str) -> list[Flowable]:
    story = _section(SECTION_TITLES["provenance"], index)
    manifest = data.manifest
    if manifest is None:
        story.append(
            _callout(
                "No provenance manifest is available",
                [
                    "A manifest could not be produced for this run, so the integrity "
                    "hashes that would let a third party verify this document are "
                    "missing. Treat the contents as unverified.",
                ],
                accent=RED,
                background=TINT_WARN,
            )
        )
        return story
    mj = _map(manifest.manifest_json)
    software = _map(mj.get("software"))
    # A manifest that fails its own schema cannot be presented as proof of
    # anything, so say so above the hashes rather than beside them.
    if validate_against_schema(mj, "run_manifest.schema.json"):
        story.extend(
            [
                _callout(
                    "This manifest fails schema validation",
                    [
                        "The stored provenance manifest does not conform to the run "
                        "manifest schema. The values below are reproduced for "
                        "inspection but cannot be relied on as an integrity record.",
                    ],
                    accent=RED,
                    background=TINT_WARN,
                ),
                Spacer(1, 10),
            ]
        )
    story.append(
        _para(
            "These hashes bind this report to the exact transcript and summary the run "
            "produced. Recompute them from the reproducibility packet to confirm "
            "nothing has changed.",
            S["small"],
        )
    )
    table = _kv_table(
        [
            ("Manifest version", manifest.manifest_version),
            ("Transcript SHA-256", f"`{manifest.transcript_sha256}`"),
            ("Summary SHA-256", f"`{manifest.summary_sha256}`"),
            ("Manifest payload SHA-256", f"`{manifest.manifest_payload_sha256}`"),
            ("Signature", manifest.signature or "not signed"),
        ],
        label_width=1.9 * inch,
    )
    if table is not None:
        story.append(table)
    story.append(_sub("Software and lineage"))
    upstream = _map(software.get("upstream_package"))
    table = _kv_table(
        [
            ("Application version", software.get("application_version")),
            ("Git commit", f"`{_clean(software.get('git_commit'))}`"),
            ("Python", software.get("python_version")),
            ("Database revision", software.get("database_revision")),
            (
                "Upstream package",
                f"{_clean(upstream.get('name'))} ({_clean(upstream.get('version_or_commit'))}, "
                f"{_clean(upstream.get('license'))}) — {_clean(upstream.get('source_repository'))}"
                if upstream
                else "",
            ),
            ("Parent run", str(run.parent_run_id) if run.parent_run_id else "none"),
        ],
        label_width=1.9 * inch,
    )
    if table is not None:
        story.append(table)
    providers, bad_providers = _maps(mj.get("providers"))
    if providers:
        story.append(_sub("Providers"))
        rows = [
            [
                _clean(p.get("provider_type")),
                _clean(p.get("model_key")) or _clean(p.get("model_id")),
                _clean(p.get("organization")) or "—",
            ]
            for p in providers
        ]
        table = _grid_table(
            ["Provider", "Model", "Organization"],
            rows,
            [CONTENT_WIDTH * 0.28, CONTENT_WIDTH * 0.44, CONTENT_WIDTH * 0.28],
        )
        if table is not None:
            story.append(table)
    story.extend(_skipped(bad_providers, "provider"))
    return story


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------

def _closing(run: Run) -> list[Flowable]:
    return [
        Spacer(1, 18),
        HRFlowable(width="100%", thickness=0.6, color=RULE, spaceAfter=8),
        Paragraph(
            "Produced by Virtual Lab Studio, which wraps the open-source "
            "<i>virtual-lab</i> project (zou-group, MIT). This report is a record of a "
            "model-run deliberation. It is not peer-reviewed, it is not a substitute "
            "for expert judgement, and it must not be presented as an experimental "
            "result. The full reproducibility packet for this run — transcript, frozen "
            "definition, agent prompts, evidence, and provenance manifest — is "
            "available from the run's Exports tab.",
            S["small"],
        ),
        Paragraph(f"Run {run.id}", S["mono"]),
    ]


def _render(run: Run, data: _ReportData, selected: set[str]) -> bytes:
    generated_at = datetime.now(timezone.utc)

    definition_title = _clean(data.definition.title if data.definition else "")
    doc_title = definition_title or f"Run {str(run.id)[:8]}"
    run_label = f"Run {str(run.id)[:8]}"

    story: list[Flowable] = []
    story.extend(_cover(run, data, generated_at, selected))
    story.extend(_toc())
    story.extend(_conclusions(run, data))

    builders = {
        "meeting_brief": lambda i: _appendix_meeting_brief(data, i),
        "question_answers_detail": lambda i: _appendix_question_detail(data, i),
        "transcript": lambda i: _appendix_transcript(data, i),
        "final_synthesis": lambda i: _appendix_final_synthesis(data, i),
        "evidence": lambda i: _appendix_evidence(data, i),
        "citations": lambda i: _appendix_citations(data, i),
        "agents": lambda i: _appendix_agents(data, i),
        "usage": lambda i: _appendix_usage(run, data, i),
        "interventions": lambda i: _appendix_interventions(data, i),
        "reviews": lambda i: _appendix_reviews(run, data, i),
        "provenance": lambda i: _appendix_provenance(run, data, i),
    }
    number = 1
    for section_id in PDF_REPORT_SECTIONS:
        if section_id not in selected:
            continue
        number += 1
        story.append(PageBreak())
        story.extend(builders[section_id](str(number)))

    story.extend(_closing(run))

    # Pages get separated from their cover — photocopied, pasted into a slide,
    # quoted in an email. Each one has to carry the three facts that decide how
    # much weight the reader may put on it: who wrote it, whether a human has
    # signed it off, and whether the run was real.
    review = _clean(run.review_status).replace("_", " ") or "unreviewed"
    parts = (
        ["Simulated demo run", "model-generated", "not a result", f"review: {review}"]
        if run.demo_mode
        else ["Model-generated", f"review: {review}", "requires human expert review"]
    )
    footer_note = " · ".join(parts)

    buffer = io.BytesIO()
    doc = _ReportDoc(buffer, doc_title, run_label)

    def canvasmaker(*args: Any, **kwargs: Any) -> _NumberedCanvas:
        return _NumberedCanvas(*args, footer_note=footer_note, **kwargs)

    # multiBuild resolves the table of contents on the second pass.
    doc.multiBuild(story, canvasmaker=canvasmaker)
    return buffer.getvalue()


async def build_pdf_report(
    db: AsyncSession, run: Run, sections: Sequence[str] = ()
) -> bytes:
    """Render the run's conclusions plus the requested appendices as a PDF.

    Typesetting a long transcript is CPU-bound and would otherwise stall the
    event loop for every other request, so the render runs in a worker thread.
    Everything it touches is already loaded by ``_gather``.
    """
    selected = {s for s in sections if s in SECTION_TITLES}
    data = await _gather(db, run)
    return await asyncio.to_thread(_render, run, data, selected)
