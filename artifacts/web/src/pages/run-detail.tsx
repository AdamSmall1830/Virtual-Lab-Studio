import React, { useState, useEffect } from 'react';
import { useRoute, Link } from 'wouter';
import { useWorkspace } from '@/demo/useWorkspace';
import { ArrowLeft, CheckCircle2, FileText, Database, ShieldCheck, Download, Code, GitMerge, FileTerminal, AlertTriangle, ChevronRight, ChevronDown, Bot, Users } from 'lucide-react';
import { format } from 'date-fns';
import { downloadRunExport, buildRunExport, type RunExportPacket } from '@/demo/exportPacket';

export default function RunDetail() {
  const [, params] = useRoute('/app/runs/:runId');
  const runId = params?.runId;
  const workspace = useWorkspace();
  const run = workspace.runs.find(r => r.id === runId);
  
  const [tab, setTab] = useState('summary');
  const [packet, setPacket] = useState<RunExportPacket | null>(null);
  const [expandedEvents, setExpandedEvents] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  useEffect(() => {
    if (runId) {
      buildRunExport(runId).then(p => setPacket(p));
    }
  }, [runId, run?.status]); // Re-build if status changes (e.g. completes)

  if (!run) return <div className="p-8 text-center text-muted-foreground">Run not found</div>;

  const tabs = [
    { id: 'summary', label: 'Summary' },
    { id: 'transcript', label: 'Transcript' },
    { id: 'evidence', label: 'Evidence & Citations' },
    { id: 'usage', label: 'Usage & Cost' },
    { id: 'manifest', label: 'Reproducibility Manifest' },
    { id: 'exports', label: 'Exports' },
  ];

  const handleExport = async () => {
    if (!run) return;
    setIsExporting(true);
    await downloadRunExport(run.id);
    setIsExporting(false);
  };

  return (
    <div className="animate-in fade-in duration-300 max-w-5xl mx-auto h-full flex flex-col pb-12">
      <header className="mb-6">
        <Link href={`/app/projects/${run.projectId}/meetings`} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-4">
          <ArrowLeft className="w-4 h-4" /> Back to Project
        </Link>
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded text-xs font-semibold uppercase tracking-wider ${
                run.status === 'completed' ? 'bg-accent/10 text-accent border border-accent/20' : 
                'bg-muted text-muted-foreground'
              }`}>
                {run.status === 'completed' && <CheckCircle2 className="w-3.5 h-3.5" />}
                {run.status}
              </span>
              {run.simulated && (
                <span className="bg-primary/10 text-primary border border-primary/20 px-2 py-0.5 rounded text-xs font-mono font-bold">
                  SIMULATION
                </span>
              )}
            </div>
            <h1 className="text-3xl font-display font-bold">{run.title}</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Executed {format(new Date(run.createdAt), 'PPpp')} • {run.meetingType} mode
            </p>
          </div>
          
          <button onClick={handleExport} disabled={isExporting} className="vls-glass text-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-background/50 flex items-center gap-2 border border-border disabled:opacity-50">
            <Download className="w-4 h-4" /> Export Packet
          </button>
        </div>
      </header>

      <div className="flex items-center gap-1 border-b border-border mb-6 overflow-x-auto pb-px">
        {tabs.map(t => (
          <button 
            key={t.id} 
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
              tab === t.id 
                ? 'border-primary text-foreground' 
                : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1">
        {run.failure && (
          <div className="mb-6 p-6 rounded-xl border-2 border-destructive/30 bg-destructive/5 flex items-start gap-4">
            <AlertTriangle className="w-8 h-8 text-destructive shrink-0" />
            <div>
              <h3 className="text-lg font-display font-bold text-destructive mb-1">Run Failed</h3>
              <p className="text-foreground font-medium mb-1">{run.failure.message}</p>
              <p className="text-xs text-muted-foreground font-mono">Correlation ID: {run.failure.correlationId}</p>
            </div>
          </div>
        )}

        {tab === 'summary' && run.summary && (
          <div className="space-y-6">
            <div className="vls-reading-surface p-8 rounded-xl border border-border shadow-sm space-y-8">
              
              <section>
                <h3 className="text-xs font-bold uppercase tracking-wider text-primary mb-3">Executive Summary</h3>
                <p className="text-lg leading-relaxed text-foreground font-serif">{run.summary.executive_summary}</p>
              </section>

              <div className="w-full h-px bg-border" />

              <section>
                <h3 className="text-xs font-bold uppercase tracking-wider text-secondary mb-4">Recommendation & Decision</h3>
                <div className="bg-secondary/5 border border-secondary/20 p-5 rounded-lg space-y-3">
                  <div className="font-semibold text-lg">{run.summary.recommendation.decision}</div>
                  <p className="text-sm text-muted-foreground">{run.summary.recommendation.rationale}</p>
                  
                  {run.summary.recommendation.conditions?.length > 0 && (
                    <div className="mt-4 pt-4 border-t border-secondary/10">
                      <div className="text-xs font-semibold mb-2">Required Conditions:</div>
                      <ul className="list-disc list-inside text-sm text-foreground space-y-1">
                        {run.summary.recommendation.conditions.map((c, i) => <li key={i}>{c}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              </section>

              <section>
                <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-4">Role Contributions</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {run.summary.role_contributions.map((rc, i) => (
                    <div key={i} className="border border-border rounded-lg p-4 bg-background">
                      <div className="font-semibold text-sm mb-2">{rc.agent_title}</div>
                      <p className="text-sm text-muted-foreground mb-3">{rc.contribution}</p>
                      {rc.evidence_ids.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-auto">
                          {rc.evidence_ids.map(id => (
                            <span key={id} className="text-[10px] font-mono bg-accent/10 text-accent px-1.5 py-0.5 rounded border border-accent/20">
                              {id}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
              
            </div>
          </div>
        )}
        {tab === 'summary' && !run.summary && (
          <div className="p-12 text-center text-muted-foreground vls-glass rounded-xl border-dashed">
            Summary not available for this run.
          </div>
        )}

        {tab === 'transcript' && (
          <div className="vls-reading-surface rounded-xl border border-border p-6 space-y-6">
            {run.turns.map((turn, i) => (
              <div key={i} className={`flex flex-col gap-2 max-w-3xl ${turn.agentSlug ? '' : 'mx-auto text-center'}`}>
                {turn.agentSlug && (
                  <div className="flex items-center gap-2">
                    <span className="font-display font-semibold text-sm">{turn.speaker}</span>
                    <span className="text-xs text-muted-foreground font-mono bg-muted/50 px-1.5 py-0.5 rounded">R{turn.round}</span>
                  </div>
                )}
                <div className={`p-4 rounded-xl text-[15px] leading-relaxed ${turn.agentSlug ? 'bg-background border border-border' : 'bg-primary/5 border border-primary/10 font-medium'}`}>
                  {turn.content}
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'manifest' && packet && (
          <div className="space-y-6">
            <div className="bg-primary/10 border border-primary/20 p-4 rounded-xl flex items-start gap-4">
              <ShieldCheck className="w-6 h-6 text-primary shrink-0 mt-0.5" />
              <div>
                <h3 className="font-semibold text-sm text-primary mb-1">Reproducibility Manifest</h3>
                <p className="text-xs text-muted-foreground">
                  This manifest contains the exact frozen agent snapshots, configuration parameters, full raw event log, and SHA-256 content hashes to verifiably reproduce this meeting state. No cryptographic signatures are provided; hashes are computed client-side. All AI output is generated by the deterministic Demo Provider.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="vls-reading-surface p-5 rounded-xl border border-border">
                <h4 className="font-semibold text-sm mb-4 flex items-center gap-2">
                  <Users className="w-4 h-4 text-secondary" /> Frozen Agent Snapshots
                </h4>
                <div className="space-y-3">
                  {run.frozenAgents?.map(agent => (
                    <div key={agent.slug} className="text-sm bg-background p-3 rounded-lg border border-border/50">
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-medium">{agent.title}</span>
                        <span className="text-xs font-mono text-muted-foreground">v{agent.version}</span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Temp: {agent.recommended_temperature} • Tools: {agent.default_tools.length > 0 ? agent.default_tools.join(', ') : 'none'}
                      </div>
                    </div>
                  ))}
                  {(!run.frozenAgents || run.frozenAgents.length === 0) && (
                    <div className="text-sm text-muted-foreground">No frozen agents stored for this run.</div>
                  )}
                </div>
              </div>

              <div className="vls-reading-surface p-5 rounded-xl border border-border">
                <h4 className="font-semibold text-sm mb-4 flex items-center gap-2">
                  <FileTerminal className="w-4 h-4 text-accent" /> SHA-256 Hashes
                </h4>
                <div className="space-y-3 font-mono text-xs">
                  <div>
                    <div className="text-muted-foreground mb-0.5">Frozen Definition</div>
                    <div className="bg-background p-2 rounded border border-border/50 break-all">{packet.hashes.frozenDefinition}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground mb-0.5">Transcript</div>
                    <div className="bg-background p-2 rounded border border-border/50 break-all">{packet.hashes.transcript}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground mb-0.5">Events Log</div>
                    <div className="bg-background p-2 rounded border border-border/50 break-all">{packet.hashes.events}</div>
                  </div>
                  {packet.hashes.summary && (
                    <div>
                      <div className="text-muted-foreground mb-0.5">Summary</div>
                      <div className="bg-background p-2 rounded border border-border/50 break-all">{packet.hashes.summary}</div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="vls-reading-surface rounded-xl border border-border overflow-hidden">
              <button 
                onClick={() => setExpandedEvents(!expandedEvents)} 
                className="w-full p-4 flex items-center justify-between bg-background/50 hover:bg-background/80 transition-colors text-left"
              >
                <div className="font-semibold text-sm flex items-center gap-2">
                  <Code className="w-4 h-4" /> Raw Event Log ({run.events.length} events)
                </div>
                {expandedEvents ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              </button>
              
              {expandedEvents && (
                <div className="bg-black text-green-400 font-mono text-xs p-4 overflow-auto border-t border-border max-h-[500px]">
                  {run.events.map((ev, i) => (
                    <div key={i} className="mb-2 pb-2 border-b border-green-900/30 last:border-0 last:pb-0 last:mb-0">
                      <div className="flex gap-4 mb-1">
                        <span className="opacity-50 w-8">{ev.seq}</span>
                        <span className="font-bold w-32">{ev.type}</span>
                        <span className="opacity-70">{format(new Date(ev.at), 'HH:mm:ss.SSS')}</span>
                      </div>
                      <div className="pl-12 opacity-80 whitespace-pre-wrap">
                        {JSON.stringify(ev.data)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'usage' && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="vls-glass p-6 rounded-xl text-center">
              <div className="text-3xl font-mono font-bold mb-1">{run.usage.providerCalls}</div>
              <div className="text-sm text-muted-foreground">Provider Calls</div>
            </div>
            <div className="vls-glass p-6 rounded-xl text-center">
              <div className="text-3xl font-mono font-bold mb-1">{(run.usage.tokensIn + run.usage.tokensOut).toLocaleString()}</div>
              <div className="text-sm text-muted-foreground">Total Tokens</div>
            </div>
            <div className="vls-glass p-6 rounded-xl text-center">
              <div className="text-3xl font-mono font-bold mb-1">{run.usage.wallSeconds}s</div>
              <div className="text-sm text-muted-foreground">Duration</div>
            </div>
            <div className="vls-glass p-6 rounded-xl text-center">
              <div className="text-3xl font-mono font-bold mb-1 text-accent">${run.usage.costUsd.toFixed(2)}</div>
              <div className="text-sm text-muted-foreground">Cost USD</div>
            </div>
          </div>
        )}
        
        {tab === 'evidence' && (
          <div className="space-y-4">
            {(run.frozenEvidence ?? []).map(ev => (
              <div key={ev.evidence_id} className="vls-reading-surface p-4 rounded-xl border border-border flex items-start gap-4">
                <Database className="w-5 h-5 text-accent shrink-0 mt-1" />
                <div className="min-w-0">
                  <div className="font-semibold mb-1">{ev.title}</div>
                  <div className="text-sm text-muted-foreground font-mono">{ev.evidence_id}</div>
                  {ev.citation && <div className="text-xs text-muted-foreground mt-1">{ev.citation}</div>}
                  <p className="text-sm text-muted-foreground mt-2 whitespace-pre-wrap">{ev.content}</p>
                  <p className="text-xs text-muted-foreground mt-2">Snapshot captured at launch — later edits to the evidence library do not alter this record.</p>
                </div>
              </div>
            ))}
            {run.frozenDefinition.evidenceIds.length === 0 && (
              <div className="p-8 text-center text-muted-foreground vls-glass rounded-xl border-dashed">
                No evidence was attached to this run.
              </div>
            )}
          </div>
        )}

        {tab === 'exports' && (
          <div className="space-y-6 max-w-2xl mx-auto mt-8">
            <div className="vls-glass p-8 rounded-xl text-center border-dashed border-2">
              <Download className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
              <h2 className="text-xl font-display font-semibold mb-2">Export Data Packet</h2>
              <p className="text-muted-foreground mb-6">
                Download a complete, offline-readable JSON bundle containing the frozen definition, full transcript, generated summary, embedded evidence, usage metrics, and SHA-256 hashes for reproduction. 
              </p>
              <button onClick={handleExport} disabled={isExporting} className="bg-primary text-primary-foreground px-6 py-2.5 rounded-lg text-sm font-semibold hover:bg-primary/90 transition-colors inline-flex items-center gap-2 disabled:opacity-50">
                <Download className="w-4 h-4" /> Download .json
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}