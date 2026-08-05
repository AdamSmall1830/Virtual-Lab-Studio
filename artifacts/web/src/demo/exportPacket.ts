// Reproducibility packet builder. Produces a truthful export of everything
// the demo store knows about a run: frozen meeting definition, frozen agent
// snapshots, full transcript, the complete raw event log, interventions,
// usage, reviews, referenced evidence, and SHA-256 content hashes computed
// client-side. No cryptographic signatures are produced or claimed.

import { getRun, getState } from './store';

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface RunExportPacket {
  format: 'vls-reproducibility-packet';
  formatVersion: 1;
  generatedAt: string;
  simulationNotice: string;
  run: {
    id: string;
    title: string;
    status: string;
    meetingType: string;
    provider: string;
    model: string;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
    failure: unknown;
  };
  frozenDefinition: unknown;
  frozenAgents: unknown[];
  transcript: unknown[];
  events: unknown[];
  interventions: unknown[];
  usage: unknown;
  summary: unknown;
  reviews: unknown[];
  evidence: unknown[];
  hashes: {
    algorithm: 'SHA-256';
    transcript: string;
    events: string;
    frozenDefinition: string;
    summary: string | null;
  };
}

/** Build a complete, truthful reproducibility packet for a run. */
export async function buildRunExport(runId: string): Promise<RunExportPacket | null> {
  const run = getRun(runId);
  if (!run) return null;
  const state = getState();
  const reviews = state.reviews.filter((r) => r.runId === runId);
  // Prefer the launch-time evidence snapshot so later edits/deletions of
  // evidence items cannot change what this run's packet reports.
  const evidence =
    run.frozenEvidence ??
    state.evidence.filter((e) =>
      run.frozenDefinition.evidenceIds.includes(e.evidence_id),
    );
  const transcriptJson = JSON.stringify(run.turns);
  const eventsJson = JSON.stringify(run.events);
  const defJson = JSON.stringify(run.frozenDefinition);
  const summaryJson = run.summary ? JSON.stringify(run.summary) : null;
  return {
    format: 'vls-reproducibility-packet',
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    simulationNotice:
      'All model output in this run was produced by the deterministic Demo Provider (simulation). No external AI provider was called. This packet is unsigned; hashes below are SHA-256 content digests computed client-side.',
    run: {
      id: run.id,
      title: run.title,
      status: run.status,
      meetingType: run.meetingType,
      provider: run.provider,
      model: run.model,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      failure: run.failure,
    },
    frozenDefinition: run.frozenDefinition,
    frozenAgents: run.frozenAgents ?? [],
    transcript: run.turns,
    events: run.events,
    interventions: run.interventions,
    usage: run.usage,
    summary: run.summary,
    reviews,
    evidence,
    hashes: {
      algorithm: 'SHA-256',
      transcript: await sha256Hex(transcriptJson),
      events: await sha256Hex(eventsJson),
      frozenDefinition: await sha256Hex(defJson),
      summary: summaryJson ? await sha256Hex(summaryJson) : null,
    },
  };
}

/** Trigger a browser download of the packet as JSON. */
export async function downloadRunExport(runId: string): Promise<boolean> {
  const packet = await buildRunExport(runId);
  if (!packet) return false;
  const blob = new Blob([JSON.stringify(packet, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${packet.run.id}-reproducibility-packet.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return true;
}
