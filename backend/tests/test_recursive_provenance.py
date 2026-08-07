"""The permanent record of a recursive turn: manifest, packet and paper.

A recursive turn is the one part of a meeting this deployment did not execute.
That makes its record load-bearing in a way an ordinary turn's is not, and it
has to satisfy two things at once:

* it must be *complete enough* to be read as an account of what an outside
  machine was asked to do and what it claimed to have done;
* it must be *narrow enough* that nothing which reaches the record can carry a
  worker credential, a host path, or the coordinator's private reasoning.

These tests also pin the invariant that makes the packet checkable at all: the
manifest embeds the digest of each recursive packet file, so a reader who
hashes a file from the ZIP finds that hash inside the signed payload. That only
holds while one renderer produces both, which is why the record owns the text.
"""
from __future__ import annotations

import io
import json
import sys
from contextlib import asynccontextmanager
import zipfile
from datetime import UTC, datetime
from pathlib import Path

import pypdf
from sqlalchemy import update

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.exports import build_export_packet  # noqa: E402
from app.models import Run  # noqa: E402
from app.pdf_report import build_pdf_report  # noqa: E402
from app.provenance import build_manifest, sha256_text, validate_against_schema  # noqa: E402
from app.recursive import broker, fake_worker  # noqa: E402
from app.recursive.record import (  # noqa: E402
    EXPORTED_EVENT_TYPES,
    emitted_recursive_event_types,
    load_recursive_record,
)
from recursive_support import (  # noqa: E402
    PEPPER,
    Planned,
    cleanup,
    recursive_settings,  # noqa: F401 -- imported for use as a fixture
    scaffold,
)


def _pdf_text(payload: bytes) -> str:
    reader = pypdf.PdfReader(io.BytesIO(payload))
    return "\n".join(page.extract_text() or "" for page in reader.pages)


async def _terminalise(db, run) -> None:
    """End the run ourselves so the development engine stops touching it.

    A completed recursive job requeues its run, and this same database is
    polled by the running dev server. Taking the row terminal here is what
    makes the assertions below about a finished run stable.
    """
    await db.execute(
        update(Run)
        .where(Run.id == run.id)
        .values(
            status="completed",
            lease_owner=None,
            lease_expires_at=None,
            completed_at=datetime.now(UTC),
        )
    )
    await db.commit()
    await db.refresh(run)


@asynccontextmanager
async def _simulated_recursive_run(db):
    """One meeting whose single turn was executed by the built-in simulator.

    A context manager rather than a plain helper because the rows are real: if
    the scaffold succeeds and the dispatch then fails, the leftovers stay in
    the development database and the *next* run of this suite leases the wrong
    worker. Cleanup has to be owned by whoever created the rows.
    """
    worker, definition, da, run, version = await scaffold(
        db,
        model_key=fake_worker.FAKE_MODEL_KEY,
        adapter_version="simulated",
        display_name=fake_worker.FAKE_WORKER_NAME,
    )
    try:
        await broker.dispatch_or_resume_recursive_turn(
            db, run=run, definition=definition, planned=Planned(), da=da, av=version,
            agent_title="Test Lead", messages=[], prompt="Open the meeting.",
            worker_id="broker-test",
        )
        job_id = (await broker.active_job_for_run(db, run.id)).id
        assert await fake_worker.run_once(db, run.workspace_id) == job_id, (
            "the simulator did not pick up the queued job"
        )
        await _terminalise(db, run)
        yield worker, definition, run, job_id
    finally:
        await cleanup(db, worker, definition, run)


def _packet_files(payload: bytes) -> dict[str, str]:
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        return {name: archive.read(name).decode("utf-8") for name in archive.namelist()}


# ---------------------------------------------------------------------------
# The absence of recursive work is itself a statement
# ---------------------------------------------------------------------------


async def test_a_standard_run_records_that_nothing_was_delegated(
    sessionmaker, recursive_settings
):
    """An ordinary meeting still carries the section, saying zero.

    A missing section would be ambiguous -- old export, disabled feature, or
    nothing to report -- so the record always answers the question.
    """
    async with sessionmaker() as db:
        worker, definition, da, run, version = await scaffold(db, model_key="ollama/unused")
        try:
            await _terminalise(db, run)
            record = await load_recursive_record(db, run)
            assert record.is_empty
            assert not record.simulated

            manifest = await build_manifest(db, run)
            block = manifest["recursive_execution"]
            assert block["job_count"] == 0
            assert block["jobs"] == [] and block["workers"] == []
            assert block["simulated"] is False
            assert validate_against_schema(manifest, "run_manifest.schema.json") == []

            files = _packet_files(await build_export_packet(db, run))
            # Present and empty, so the packet's shape does not depend on
            # whether the feature was ever used.
            assert json.loads(files["recursive/jobs.json"]) == []
            assert json.loads(files["recursive/nodes.json"]) == []
            assert json.loads(files["recursive/events.json"]) == []
            assert json.loads(files["recursive/workers.json"]) == []
            assert not any(n.startswith("recursive/results/") for n in files)
        finally:
            await cleanup(db, worker, definition, run)


async def test_paper_says_plainly_that_no_external_machine_was_involved(
    sessionmaker, recursive_settings
):
    async with sessionmaker() as db:
        worker, definition, da, run, version = await scaffold(db, model_key="ollama/unused")
        try:
            await _terminalise(db, run)
            text = _pdf_text(await build_pdf_report(db, run, ["recursive_execution"]))
            assert "Recursive execution" in text
            assert "No participant in this meeting was executed by an external worker" in text
        finally:
            await cleanup(db, worker, definition, run)


# ---------------------------------------------------------------------------
# A delegated turn
# ---------------------------------------------------------------------------


async def test_the_manifest_carries_the_execution_and_validates(
    sessionmaker, recursive_settings
):
    async with sessionmaker() as db:
        async with _simulated_recursive_run(db) as (worker, definition, run, job_id):
            manifest = await build_manifest(db, run)
            assert validate_against_schema(manifest, "run_manifest.schema.json") == [], (
                "the recursive block must satisfy the published manifest schema"
            )

            block = manifest["recursive_execution"]
            assert block["job_count"] == 1
            assert block["node_count"] >= 2
            # The simulator declares itself, and the declaration survives into
            # the permanent record rather than being inferred at display time.
            assert block["simulated"] is True

            job = block["jobs"][0]
            assert job["status"] == "completed"
            assert job["limits"]["max_children"] == 3
            assert job["limits"]["max_depth"] == 1
            assert job["request_sha256"] and job["result_sha256"]
            assert block["workers"][0]["display_name"] == fake_worker.FAKE_WORKER_NAME

            # The manifest is hashed as a whole, so the block is inside the
            # integrity guarantee rather than beside it.
            assert "recursive_execution" in manifest
            assert manifest["integrity"]["manifest_payload_sha256"]


async def test_every_recursive_packet_file_is_bound_by_the_manifest(
    sessionmaker, recursive_settings
):
    """Hash a file out of the ZIP and the manifest already knows the answer."""
    async with sessionmaker() as db:
        async with _simulated_recursive_run(db) as (worker, definition, run, job_id):
            manifest = await build_manifest(db, run)
            digests = manifest["recursive_execution"]["packet_digests"]
            files = _packet_files(await build_export_packet(db, run))

            expected = {
                "recursive/jobs.json",
                "recursive/nodes.json",
                "recursive/events.json",
                "recursive/workers.json",
                f"recursive/results/{job_id}.json",
            }
            assert expected <= set(files)
            assert set(digests) == expected

            for name in expected:
                assert sha256_text(files[name]) == digests[name], (
                    f"{name} in the packet does not hash to the manifest's digest"
                )

            # The packet's own hash index covers them too, so a reader who only
            # trusts hashes.json reaches the same files.
            hashes = json.loads(files["hashes.json"])
            assert expected <= set(hashes)

            jobs = json.loads(files["recursive/jobs.json"])
            assert len(jobs) == 1 and jobs[0]["status"] == "completed"
            result = json.loads(files[f"recursive/results/{job_id}.json"])
            assert result["runtime"]["is_simulation"] is True
            assert isinstance(result["citations"], list)
            assert result["final_text_sha256"]
            events = json.loads(files["recursive/events.json"])
            assert events, "the delegated turn produced no exportable events"
            assert {e["event_type"] for e in events} <= EXPORTED_EVENT_TYPES


async def test_the_packet_holds_no_credential_host_path_or_hidden_reasoning(
    sessionmaker, recursive_settings
):
    async with sessionmaker() as db:
        async with _simulated_recursive_run(db) as (worker, definition, run, job_id):
            token_prefix = worker.token_prefix
            files = _packet_files(await build_export_packet(db, run))
            recursive_text = "\n".join(
                text for name, text in files.items() if name.startswith("recursive/")
            )
            manifest_text = files["manifest.json"]

            for blob in (recursive_text, manifest_text):
                assert token_prefix not in blob
                assert PEPPER not in blob
                assert "token_hash" not in blob
                assert "/home/" not in blob and "C:\\" not in blob
                # The coordinator's own working text never enters the record:
                # the result keeps a hash of the final text, not the text, and
                # no reasoning field exists to copy.
                assert '"final_text"' not in blob
                assert "reasoning" not in blob
                assert "system_prompt" not in blob


async def test_the_appendix_is_optional_and_states_what_cannot_be_verified(
    sessionmaker, recursive_settings
):
    async with sessionmaker() as db:
        async with _simulated_recursive_run(db) as (worker, definition, run, job_id):
            # Callout headings are drawn upper-case, so the comparison is
            # made on lowered text rather than pinning the typography.
            with_section = _pdf_text(
                await build_pdf_report(db, run, ["recursive_execution"])
            ).lower()
            without = _pdf_text(await build_pdf_report(db, run, ["usage"])).lower()

            assert "recursive execution" not in without

            assert "recursive execution" in with_section
            # The name is drawn inside a table cell, so it may be wrapped
            # across lines by the time it reaches extracted text.
            assert "simulated recursive" in with_section
            # The honesty requirements of the section, on the page itself.
            assert "what this deployment can and cannot attest to" in with_section
            assert "did not observe the work itself" in with_section
            assert "simulated recursive output" in with_section
            # The ceilings the turn ran under, so a reader can judge the scope.
            assert "children" in with_section and "depth" in with_section

            # Every aggregate in the summary table is an addition of what the
            # workers said. A row labelled plainly "Model calls" reads as this
            # deployment's own count, and a reader who skips the callout would
            # never learn otherwise -- so the qualifier lives in the label.
            # A long label is wrapped inside its table cell, so the comparison
            # is made on text with its line breaks collapsed.
            flowed = " ".join(with_section.split())
            for claimed in ("agents", "model calls", "input tokens", "output tokens", "cost"):
                assert f"reported {claimed}" in flowed, (
                    f"the {claimed} total is worker-supplied and must be labelled as reported"
                )


# ---------------------------------------------------------------------------
# The allow-list cannot silently fall behind the broker
# ---------------------------------------------------------------------------


def test_no_broker_event_type_escapes_the_export_decision():
    """A new ``recursive.*`` event must be classified, not defaulted.

    The export allow-list is a safety boundary. Adding an event type to the
    broker without deciding whether it belongs in a permanent record is the
    mistake this test exists to catch.
    """
    emitted = emitted_recursive_event_types()
    assert emitted, "the source scan found no event types -- the scan itself is broken"
    missing = sorted(emitted - EXPORTED_EVENT_TYPES)
    assert not missing, (
        f"broker emits {missing} but the export allow-list does not classify them"
    )
