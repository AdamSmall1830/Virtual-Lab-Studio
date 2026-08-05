"""Evidence library: extraction, chunking, hashing, and stable IDs.

- Upload bytes live in App Storage; PostgreSQL holds metadata, chunks, and
  SHA-256 hashes.
- Every source gets a stable workspace-scoped evidence key (S-0001, S-0002…)
  used in prompts, citations, summaries, and manifests.
- All source content is untrusted data, never instructions.
"""
from __future__ import annotations

import hashlib
import io
import re
import uuid
from dataclasses import dataclass

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from .models import EvidenceChunk, EvidenceSource

MAX_UPLOAD_BYTES = 25 * 1024 * 1024
CHUNK_TARGET_CHARS = 1600
CHUNK_MAX_CHARS = 2400

ALLOWED_UPLOADS = {
    "application/pdf": ("upload_pdf", ".pdf"),
    "text/markdown": ("upload_markdown", ".md"),
    "text/plain": ("upload_text", ".txt"),
}

EXTENSION_TYPES = {
    ".pdf": "application/pdf",
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".txt": "text/plain",
    ".text": "text/plain",
}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


class ExtractionError(Exception):
    def __init__(self, code: str, safe_message: str) -> None:
        super().__init__(safe_message)
        self.code = code
        self.safe_message = safe_message


def resolve_content_type(filename: str, declared: str | None) -> str:
    if declared in ALLOWED_UPLOADS:
        return declared
    ext = ("." + filename.rsplit(".", 1)[-1].lower()) if "." in filename else ""
    resolved = EXTENSION_TYPES.get(ext)
    if resolved is None:
        raise ExtractionError(
            "unsupported_type",
            "Unsupported file type. Upload PDF, Markdown, or plain text.",
        )
    return resolved


@dataclass
class ExtractedSegment:
    locator: str
    text: str


def extract_segments(data: bytes, content_type: str) -> list[ExtractedSegment]:
    """Extract text segments with human-auditable locators."""
    if content_type == "application/pdf":
        try:
            from pypdf import PdfReader

            reader = PdfReader(io.BytesIO(data))
            segments = []
            for page_number, page in enumerate(reader.pages, start=1):
                page_text = (page.extract_text() or "").strip()
                if page_text:
                    segments.append(ExtractedSegment(locator=f"page {page_number}", text=page_text))
            if not segments:
                raise ExtractionError(
                    "no_extractable_text",
                    "No extractable text found in the PDF (it may be scanned images).",
                )
            return segments
        except ExtractionError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise ExtractionError("pdf_parse_failed", "Could not parse the PDF file.") from exc
    try:
        full_text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ExtractionError("encoding_error", "File is not valid UTF-8 text.") from exc
    full_text = full_text.strip()
    if not full_text:
        raise ExtractionError("empty_file", "The file contains no text.")
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", full_text) if p.strip()]
    return [
        ExtractedSegment(locator=f"paragraph {i}", text=p)
        for i, p in enumerate(paragraphs, start=1)
    ]


def build_chunks(segments: list[ExtractedSegment]) -> list[tuple[str, str]]:
    """Merge segments into chunks of ~CHUNK_TARGET_CHARS; returns (locator, text)."""
    chunks: list[tuple[str, str]] = []
    buffer: list[str] = []
    buffer_locators: list[str] = []
    buffer_len = 0

    def flush() -> None:
        nonlocal buffer, buffer_locators, buffer_len
        if not buffer:
            return
        locator = buffer_locators[0] if len(buffer_locators) == 1 else f"{buffer_locators[0]}–{buffer_locators[-1]}"
        chunks.append((locator, "\n\n".join(buffer)))
        buffer, buffer_locators, buffer_len = [], [], 0

    for seg in segments:
        pieces = (
            [seg.text[i:i + CHUNK_MAX_CHARS] for i in range(0, len(seg.text), CHUNK_MAX_CHARS)]
            if len(seg.text) > CHUNK_MAX_CHARS
            else [seg.text]
        )
        for idx, piece in enumerate(pieces):
            loc = seg.locator if len(pieces) == 1 else f"{seg.locator} (part {idx + 1})"
            if buffer_len + len(piece) > CHUNK_TARGET_CHARS:
                flush()
            buffer.append(piece)
            buffer_locators.append(loc)
            buffer_len += len(piece)
    flush()
    return chunks


async def allocate_evidence_key(db: AsyncSession, workspace_id: uuid.UUID) -> str:
    """Allocate the next stable S-XXXX key for a workspace (serialized)."""
    # Advisory lock scoped to the transaction keeps allocation race-free.
    await db.execute(
        text("SELECT pg_advisory_xact_lock(hashtext('evidence_key:' || :ws))"),
        {"ws": str(workspace_id)},
    )
    row = (
        await db.execute(
            text(
                "SELECT max((substring(evidence_key from '^S-(\\d+)$'))::int) "
                "FROM evidence_sources WHERE workspace_id = :ws AND evidence_key ~ '^S-\\d+$'"
            ),
            {"ws": str(workspace_id)},
        )
    ).scalar_one_or_none()
    return f"S-{(row or 0) + 1:04d}"


async def persist_chunks(
    db: AsyncSession, source: EvidenceSource, segments: list[ExtractedSegment]
) -> int:
    chunks = build_chunks(segments)
    for index, (locator, chunk_text) in enumerate(chunks):
        db.add(EvidenceChunk(
            workspace_id=source.workspace_id,
            evidence_source_id=source.id,
            chunk_index=index,
            locator=locator,
            content_text=chunk_text,
            content_sha256=sha256_text(chunk_text),
            token_count=max(1, len(chunk_text) // 4),
        ))
    return len(chunks)


async def get_source_chunks(db: AsyncSession, source_id: uuid.UUID) -> list[EvidenceChunk]:
    return list(
        (
            await db.execute(
                select(EvidenceChunk)
                .where(EvidenceChunk.evidence_source_id == source_id)
                .order_by(EvidenceChunk.chunk_index)
            )
        ).scalars()
    )


def source_excerpt(chunks: list[EvidenceChunk], max_chars: int = 2000) -> str:
    parts: list[str] = []
    used = 0
    for chunk in chunks:
        remaining = max_chars - used
        if remaining <= 0:
            parts.append("…")
            break
        piece = chunk.content_text[:remaining]
        parts.append(piece)
        used += len(piece)
    return "\n\n".join(parts)
