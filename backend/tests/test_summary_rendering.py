"""The readable document must carry the whole structured record.

A finding that exists only in ``summary_json`` is invisible in practice: the
markdown is what exports ship and what a reader quotes. These tests pin the
sections that were previously dropped — disagreements, assumptions, risks,
next steps and the stated confidence — so they cannot silently fall out again.
"""
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace

from app.engine import _accumulate_wall_seconds, _summary_markdown

DISCLOSURE = "AI-generated decision support. Requires human review."

FULL_RECORD = {
    "agenda": "Can we deploy the assay?",
    "executive_summary": "The team recommends a limited pilot.",
    "recommendation": {
        "decision": "Approve a limited pilot.",
        "rationale": "Bounded risk with reversible commitments.",
        "conditions": ["Use synthetic data only.", "Stop on any safety signal."],
    },
    "question_answers": [
        {
            "question": "Is the assay ready?",
            "answer": "Not without an independent replication.",
            "evidence_ids": ["EV-1"],
            "confidence": 0.62,
            "open_issue": "No replication has been scheduled.",
        }
    ],
    "evidence": [
        {
            "evidence_id": "EV-1",
            "claim": "Prior work reports 40% variance between labs.",
            "support_type": "supports",
            "locator": "p. 12",
        }
    ],
    "assumptions": [
        {
            "assumption": "The reagent supply is stable.",
            "impact": "high",
            "validation": "Confirm with the vendor before the pilot.",
        }
    ],
    "disagreements": [
        {
            "topic": "Whether the control arm is adequate",
            "resolution_status": "needs_evidence",
            "positions": [
                {"agent_title": "Biostatistician", "position": "Underpowered as designed."},
                {"agent_title": "Domain Expert", "position": "Adequate for a feasibility read."},
            ],
        }
    ],
    "risks_and_limitations": [
        {
            "risk": "Batch effects may dominate the signal.",
            "severity": "high",
            "likelihood": "possible",
            "mitigation": "Randomise across batches and pre-register the analysis.",
        }
    ],
    "next_steps": [
        {
            "action": "Schedule an independent replication.",
            "priority": "now",
            "owner_role": "Principal Investigator",
            "acceptance_criterion": "A second lab has agreed in writing.",
        }
    ],
    "confidence": {
        "overall": 0.71,
        "basis": "The team converged on a bounded recommendation.",
        "uncertainty": "No replication data exists yet.",
    },
    "disclosure": {
        "model_generated": True,
        "human_review_required": True,
        "limitations": ["Not experimentally validated."],
    },
    "role_contributions": [
        {"agent_id": "a-1", "agent_title": "Biostatistician", "contribution": "Framed the estimand."}
    ],
}


def test_markdown_carries_every_section_of_the_record():
    md = _summary_markdown("Assay Review", DISCLOSURE, FULL_RECORD, "The final word.")

    for heading in (
        "## Executive summary",
        "## Recommendation",
        "## Agenda questions",
        "## Disagreements",
        "## Assumptions",
        "## Risks and limitations",
        "## Next steps",
        "## Evidence cited",
        "## Team member contributions",
        "## Confidence",
        "## Disclosure",
        "## Final synthesis (verbatim)",
    ):
        assert heading in md, f"{heading} missing from the rendered document"


def test_markdown_carries_the_substance_not_just_the_headings():
    md = _summary_markdown("Assay Review", DISCLOSURE, FULL_RECORD, "The final word.")

    # Disagreement positions, previously dropped entirely.
    assert "Whether the control arm is adequate" in md
    assert "Underpowered as designed." in md
    assert "needs evidence" in md  # underscores humanised

    # Risk qualifiers and mitigation.
    assert "Batch effects may dominate the signal." in md
    assert "severity: high" in md
    assert "Randomise across batches" in md

    # Next steps with owner and acceptance criterion.
    assert "Schedule an independent replication." in md
    assert "Principal Investigator" in md
    assert "A second lab has agreed in writing." in md

    # Assumptions.
    assert "The reagent supply is stable." in md
    assert "Confirm with the vendor" in md

    # Stated confidence is labelled as the model's own, never as a measurement.
    assert "0.71" in md
    assert "as stated by the model that held the meeting" in md
    assert "No replication data exists yet." in md

    # Per-question findings with their own confidence and citation.
    assert "Is the assay ready?" in md
    assert "Stated confidence 0.62" in md
    assert "`EV-1`" in md
    assert "Open issue: No replication has been scheduled." in md

    # Disclosure.
    assert "Not experimentally validated." in md
    assert "Human expert review is required" in md


def test_empty_sections_are_omitted_rather_than_rendered_hollow():
    sparse = {
        "agenda": "A question",
        "executive_summary": "A short summary.",
        "recommendation": {"decision": "", "rationale": "", "conditions": []},
        "question_answers": [],
        "evidence": [],
        "assumptions": [],
        "disagreements": [],
        "risks_and_limitations": [],
        "next_steps": [],
        "confidence": {},
        "disclosure": {},
        "role_contributions": [],
    }
    md = _summary_markdown("Sparse", DISCLOSURE, sparse, "")

    assert "## Executive summary" in md
    for heading in (
        "## Recommendation",
        "## Agenda questions",
        "## Disagreements",
        "## Assumptions",
        "## Risks and limitations",
        "## Next steps",
        "## Evidence cited",
        "## Confidence",
        "## Disclosure",
        "## Final synthesis",
    ):
        assert heading not in md, f"{heading} rendered as an empty section"


def test_unextracted_confidence_of_zero_is_still_shown():
    """0.0 is a real, meaningful value here — it means 'not extracted'."""
    record = dict(FULL_RECORD)
    record["confidence"] = {"overall": 0.0, "basis": "No record was produced.", "uncertainty": "n/a"}
    md = _summary_markdown("Zero", DISCLOSURE, record, "")
    assert "## Confidence" in md
    assert "**0.00**" in md


def test_wall_seconds_accumulate_across_attempts():
    """A resumed run reports total time, not just its final attempt."""
    started = datetime.now(UTC) - timedelta(seconds=10)

    first = _accumulate_wall_seconds(SimpleNamespace(wall_seconds=None), started)
    assert 9 <= float(first) <= 12

    resumed = _accumulate_wall_seconds(SimpleNamespace(wall_seconds=Decimal("100.0")), started)
    assert 109 <= float(resumed) <= 112, "prior attempts must be included"
