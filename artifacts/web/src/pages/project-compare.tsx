import React, { useState } from 'react';
import { useRoute, Link } from 'wouter';
import { useWorkspace } from '@/demo/useWorkspace';
import { GitMerge, ArrowLeft, Plus, EyeOff, Save, Check } from 'lucide-react';
import { mutate, uid } from '@/demo/store';
import { format } from 'date-fns';
import type { Comparison, Run } from '@/demo/types';

export default function ProjectCompare() {
  const [, params] = useRoute('/app/projects/:projectId/compare');
  const projectId = params?.projectId;
  const workspace = useWorkspace();
  
  const project = workspace.projects.find(p => p.id === projectId || p.slug === projectId);
  const projectRuns = workspace.runs.filter(r => r.projectId === projectId && r.status === 'completed');
  const projectComparisons = workspace.comparisons.filter(c => c.projectId === projectId);

  const [selectedRunIds, setSelectedRunIds] = useState<string[]>([]);
  const [comparing, setComparing] = useState(false);
  const [blinded, setBlind] = useState(false);
  const [rubricScores, setRubricScores] = useState<Record<string, { criterion: string; score: number }[]>>({});
  const [preferredRunId, setPreferredRunId] = useState<string | null>(null);
  const [rationale, setRationale] = useState('');

  if (!project) return null;

  const toggleRun = (id: string) => {
    setSelectedRunIds(prev => 
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const startComparison = () => {
    if (selectedRunIds.length < 2) return;
    setComparing(true);
    const initialScores: Record<string, any[]> = {};
    selectedRunIds.forEach(id => {
      initialScores[id] = [
        { criterion: 'Evidence Use', score: 0 },
        { criterion: 'Actionability', score: 0 }
      ];
    });
    setRubricScores(initialScores);
    setPreferredRunId(null);
    setRationale('');
  };

  const handleScoreChange = (runId: string, idx: number, val: number) => {
    setRubricScores(prev => {
      const copy = { ...prev };
      copy[runId][idx].score = val;
      return copy;
    });
  };

  const handleSave = () => {
    if (!preferredRunId) return;
    mutate(s => {
      s.comparisons.push({
        id: uid('cmp'),
        projectId: project.id,
        runIds: selectedRunIds,
        blinded,
        rubricScores,
        preferredRunId,
        rationale,
        createdAt: new Date().toISOString()
      });
    });
    setComparing(false);
    setSelectedRunIds([]);
  };

  const activeRuns = selectedRunIds.map(id => projectRuns.find(r => r.id === id)).filter(Boolean) as Run[];

  return (
    <div className="animate-in fade-in duration-300 h-full flex flex-col max-w-6xl mx-auto pb-12">
      <header className="mb-6">
        <Link href={`/app/projects/${project.id}/meetings`} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-4">
          <ArrowLeft className="w-4 h-4" /> Back to Project
        </Link>
        <h1 className="text-3xl font-display font-bold">Compare Runs</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Evaluate multiple generated recommendations side-by-side.
        </p>
      </header>

      {!comparing ? (
        <div className="space-y-8">
          {projectRuns.length < 2 ? (
            <div className="vls-glass rounded-xl p-16 text-center border-dashed">
              <GitMerge className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
              <h2 className="text-xl font-display font-semibold mb-2">Not enough data to compare</h2>
              <p className="text-muted-foreground max-w-sm mx-auto mb-6">
                You need at least two completed runs in this project to run a comparison or blinded A/B test.
              </p>
              <Link href={`/app/meetings/new?project=${project.id}`} className="bg-primary text-primary-foreground px-6 py-2.5 rounded-lg text-sm font-semibold inline-flex items-center gap-2 hover:bg-primary/90 transition-colors">
                <Plus className="w-4 h-4" /> Start a New Run
              </Link>
            </div>
          ) : (
            <div className="vls-reading-surface rounded-xl p-8">
              <h2 className="text-xl font-display font-semibold mb-4">Select Runs to Compare</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 text-left">
                {projectRuns.map(run => {
                  const isSelected = selectedRunIds.includes(run.id);
                  return (
                    <label key={run.id} className={`flex items-start gap-4 p-4 rounded-xl border cursor-pointer transition-all ${isSelected ? 'border-primary bg-primary/5' : 'border-border bg-background hover:border-primary/50'}`}>
                      <input 
                        type="checkbox" 
                        checked={isSelected}
                        onChange={() => toggleRun(run.id)}
                        className="mt-1 w-4 h-4 rounded border-border text-primary focus:ring-primary" 
                      />
                      <div>
                        <div className="font-medium text-foreground mb-1">{run.title}</div>
                        <div className="text-xs text-muted-foreground capitalize">{run.meetingType} • {run.usage.providerCalls} calls</div>
                      </div>
                    </label>
                  );
                })}
              </div>
              <div className="mt-8 flex items-center justify-center gap-6">
                <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
                  <input type="checkbox" checked={blinded} onChange={e => setBlind(e.target.checked)} className="rounded border-border text-primary" />
                  <EyeOff className="w-4 h-4 text-muted-foreground" /> Blinded Mode (A/B/C/D)
                </label>
                <button 
                  onClick={startComparison}
                  disabled={selectedRunIds.length < 2}
                  className="bg-primary text-primary-foreground px-6 py-2.5 rounded-lg text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-50"
                >
                  Start Comparison
                </button>
              </div>
            </div>
          )}

          {projectComparisons.length > 0 && (
            <div>
              <h3 className="font-display font-semibold text-lg mb-4">Saved Comparisons</h3>
              <div className="grid grid-cols-1 gap-4">
                {projectComparisons.map(cmp => (
                  <div key={cmp.id} className="vls-glass p-5 rounded-xl border border-border">
                    <div className="flex items-center gap-2 mb-2">
                      <GitMerge className="w-4 h-4 text-secondary" />
                      <span className="font-semibold">{cmp.runIds.length} Runs Compared</span>
                      {cmp.blinded && <span className="text-xs bg-muted px-2 py-0.5 rounded font-mono">BLINDED</span>}
                      <span className="text-xs text-muted-foreground ml-auto">{format(new Date(cmp.createdAt), 'PP')}</span>
                    </div>
                    <div className="text-sm">
                      <span className="text-muted-foreground">Preferred: </span> 
                      <span className="font-medium text-primary">
                        {projectRuns.find(r => r.id === cmp.preferredRunId)?.title || 'Unknown'}
                      </span>
                    </div>
                    <div className="text-sm mt-2 p-3 bg-background rounded-lg border border-border/50 text-muted-foreground italic">
                      "{cmp.rationale}"
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <button onClick={() => setComparing(false)} className="text-sm text-muted-foreground hover:text-foreground">Cancel Comparison</button>
            <div className="text-sm font-medium bg-background px-3 py-1 rounded-full border">
              {blinded ? 'Blinded A/B Mode Active' : 'Open Comparison'}
            </div>
          </div>

          <div className="grid gap-6 overflow-x-auto" style={{ gridTemplateColumns: `repeat(${activeRuns.length}, minmax(300px, 1fr))` }}>
            {activeRuns.map((run, idx) => {
              const label = blinded ? `Run ${String.fromCharCode(65 + idx)}` : run.title;
              const scores = rubricScores[run.id] || [];
              
              return (
                <div key={run.id} className={`vls-reading-surface rounded-xl flex flex-col border-2 transition-all ${preferredRunId === run.id ? 'border-primary shadow-[0_0_20px_rgba(var(--primary),0.2)]' : 'border-border'}`}>
                  <div className="p-4 border-b border-border bg-background/50">
                    <h3 className="font-display font-bold text-lg mb-1">{label}</h3>
                    {!blinded && (
                      <div className="text-xs text-muted-foreground flex flex-col gap-1">
                        <span>{run.meetingType} • {run.frozenDefinition.rounds} rounds • Temp {run.frozenDefinition.temperature}</span>
                        <span>{run.usage.providerCalls} calls • {run.usage.wallSeconds}s elapsed</span>
                      </div>
                    )}
                  </div>
                  
                  <div className="p-4 flex-1 space-y-4">
                    <div>
                      <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">Summary Decision</div>
                      <div className="text-sm bg-background p-3 rounded-lg border border-border/50">
                        {run.summary?.recommendation?.decision || 'No summary'}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">Rationale</div>
                      <div className="text-sm text-muted-foreground h-32 overflow-y-auto">
                        {run.summary?.recommendation?.rationale || 'No rationale'}
                      </div>
                    </div>
                  </div>

                  <div className="p-4 border-t border-border bg-background/50 space-y-4">
                    <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Rubric Scoring</div>
                    {scores.map((s, i) => (
                      <div key={i} className="space-y-1">
                        <div className="flex justify-between text-xs">
                          <span>{s.criterion}</span>
                          <span className="font-mono">{s.score || '-'} / 5</span>
                        </div>
                        <input 
                          type="range" min="0" max="5" step="1"
                          value={s.score}
                          onChange={e => handleScoreChange(run.id, i, parseInt(e.target.value))}
                          className="w-full accent-primary"
                        />
                      </div>
                    ))}
                    
                    <button 
                      onClick={() => setPreferredRunId(run.id)}
                      className={`w-full py-2 rounded-lg text-sm font-semibold transition-all ${preferredRunId === run.id ? 'bg-primary text-primary-foreground' : 'bg-background border border-border hover:border-primary/50'}`}
                    >
                      {preferredRunId === run.id ? <span className="flex items-center justify-center gap-2"><Check className="w-4 h-4" /> Preferred Selection</span> : 'Select as Preferred'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {preferredRunId && (
            <div className="vls-glass p-6 rounded-xl border border-primary/30 animate-in slide-in-from-bottom-4">
              <h3 className="font-semibold mb-3">Provide Rationale for Selection</h3>
              <textarea 
                className="w-full bg-background border border-input rounded-md px-3 py-2 text-sm min-h-[80px] focus:ring-2 focus:ring-primary outline-none mb-4"
                placeholder="Why is this run the best outcome?"
                value={rationale}
                onChange={e => setRationale(e.target.value)}
              />
              <div className="flex justify-end">
                <button 
                  onClick={handleSave}
                  disabled={!rationale.trim()}
                  className="bg-primary text-primary-foreground px-6 py-2.5 rounded-lg text-sm font-semibold hover:bg-primary/90 flex items-center gap-2 disabled:opacity-50"
                >
                  <Save className="w-4 h-4" /> Save Comparison
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}