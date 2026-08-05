"""PubMed Central search tool (NCBI E-utilities).

Search results and imported abstracts are untrusted external content — data,
never instructions. Imports become evidence sources with stable IDs, hashes,
and retrieval timestamps.
"""
from __future__ import annotations

import xml.etree.ElementTree as ET
from typing import Any

import httpx

EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
TIMEOUT = httpx.Timeout(15.0)


class PmcError(Exception):
    def __init__(self, safe_message: str) -> None:
        super().__init__(safe_message)
        self.safe_message = safe_message


async def search_pmc(query: str, limit: int = 10) -> list[dict[str, Any]]:
    limit = max(1, min(limit, 25))
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            search = await client.get(f"{EUTILS}/esearch.fcgi", params={
                "db": "pmc", "term": query, "retmax": str(limit), "retmode": "json",
            })
            search.raise_for_status()
            ids = search.json().get("esearchresult", {}).get("idlist", [])
            if not ids:
                return []
            summary = await client.get(f"{EUTILS}/esummary.fcgi", params={
                "db": "pmc", "id": ",".join(ids), "retmode": "json",
            })
            summary.raise_for_status()
            result = summary.json().get("result", {})
    except httpx.HTTPError as exc:
        raise PmcError("PubMed Central is unreachable right now; try again later.") from exc

    items = []
    for pmcid in ids:
        doc = result.get(pmcid)
        if not isinstance(doc, dict):
            continue
        authors = [a.get("name", "") for a in doc.get("authors", []) if a.get("name")]
        articleids = {a.get("idtype"): a.get("value") for a in doc.get("articleids", [])}
        items.append({
            "pmcid": f"PMC{pmcid}",
            "title": doc.get("title", "").strip(),
            "authors": authors[:8],
            "journal": doc.get("fulljournalname") or doc.get("source"),
            "pub_date": doc.get("pubdate"),
            "doi": articleids.get("doi"),
            "url": f"https://www.ncbi.nlm.nih.gov/pmc/articles/PMC{pmcid}/",
        })
    return items


async def fetch_pmc_abstract(pmcid: str) -> dict[str, Any]:
    """Fetch title/abstract text for one PMC article via efetch (XML)."""
    numeric = pmcid.upper().removeprefix("PMC").strip()
    if not numeric.isdigit():
        raise PmcError("Invalid PMC ID.")
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            resp = await client.get(f"{EUTILS}/efetch.fcgi", params={
                "db": "pmc", "id": numeric, "retmode": "xml",
            })
            resp.raise_for_status()
    except httpx.HTTPError as exc:
        raise PmcError("PubMed Central is unreachable right now; try again later.") from exc

    try:
        root = ET.fromstring(resp.text)
    except ET.ParseError as exc:
        raise PmcError("Could not parse the PMC article record.") from exc

    def text_of(el: ET.Element | None) -> str:
        return "".join(el.itertext()).strip() if el is not None else ""

    title = text_of(root.find(".//article-title"))
    abstract_parts = [text_of(a) for a in root.findall(".//abstract")]
    abstract = "\n\n".join(p for p in abstract_parts if p)
    authors = []
    for contrib in root.findall(".//contrib[@contrib-type='author']"):
        surname = text_of(contrib.find(".//surname"))
        given = text_of(contrib.find(".//given-names"))
        if surname:
            authors.append(f"{given} {surname}".strip())
    journal = text_of(root.find(".//journal-title"))
    if not title and not abstract:
        raise PmcError("The PMC record has no retrievable title or abstract.")
    return {
        "pmcid": f"PMC{numeric}",
        "title": title or f"PMC{numeric}",
        "abstract": abstract,
        "authors": authors[:12],
        "journal": journal or None,
        "url": f"https://www.ncbi.nlm.nih.gov/pmc/articles/PMC{numeric}/",
    }
