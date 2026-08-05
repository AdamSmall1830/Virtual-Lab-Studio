import React from 'react';
import { useParams, Link } from 'wouter';
import { useGetProject, useListProjectRuns, getGetProjectQueryKey, getListProjectRunsQueryKey } from '@workspace/api-client-react';
import { PageHeader } from '@/components/ui/page-header';
import { GlassPanel } from '@/components/ui/glass-panel';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Play, Tag, Target, AlertTriangle, Activity, Clock } from 'lucide-react';
import { RunStatusBadge } from '@/components/ui/run-status-badge';
import { format } from 'date-fns';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export default function ProjectDetail() {
  const { projectId } = useParams<{ projectId: string }>();
  const { data: project, isLoading: loadingProject } = useGetProject(projectId, { query: { enabled: !!projectId, queryKey: getGetProjectQueryKey(projectId) }});
  const { data: runs, isLoading: loadingRuns } = useListProjectRuns(projectId, { query: { enabled: !!projectId, queryKey: getListProjectRunsQueryKey(projectId) }});

  if (loadingProject) {
    return <div className="p-8 animate-pulse"><div className="h-12 bg-muted/50 rounded w-1/3 mb-8"></div></div>;
  }

  if (!project) return <div className="p-8">Project not found</div>;

  return (
    <div className="p-6 md:p-8 max-w-6xl mx-auto w-full">
      <Link href="/app/projects" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors">
        <ArrowLeft className="w-4 h-4" /> Back to Projects
      </Link>
      
      <PageHeader 
        title={project.name} 
        description={project.abstract}
      >
        <Link href={`/app/meetings/new?projectId=${project.id}`}>
          <Button><Play className="w-4 h-4 mr-2" /> Start New Meeting</Button>
        </Link>
      </PageHeader>

      <div className="flex flex-wrap gap-2 mb-8">
        <span className="px-2 py-1 rounded bg-surface-strong border border-border text-xs font-medium capitalize">{project.status}</span>
        {project.domain && <span className="px-2 py-1 rounded bg-muted text-muted-foreground text-xs border border-border">{project.domain}</span>}
        {project.tags?.map(t => (
          <span key={t} className="px-2 py-1 rounded bg-secondary/10 text-secondary text-xs flex items-center gap-1 border border-secondary/20">
            <Tag className="w-3 h-3" /> {t}
          </span>
        ))}
      </div>

      <Tabs defaultValue="overview" className="w-full">
        <TabsList className="mb-6 vls-glass p-1">
          <TabsTrigger value="overview" className="rounded-md data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow">Overview</TabsTrigger>
          <TabsTrigger value="runs" className="rounded-md data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow">Runs ({runs?.length || 0})</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          <div className="grid md:grid-cols-2 gap-6">
            <GlassPanel className="p-6">
              <h3 className="text-lg font-display font-semibold mb-4 flex items-center gap-2"><Target className="w-5 h-5 text-primary" /> Research Context</h3>
              <div className="space-y-4">
                <div>
                  <h4 className="text-sm font-medium text-foreground/80 mb-1">Research Question</h4>
                  <p className="text-muted-foreground text-sm leading-relaxed">{project.researchQuestion || 'Not specified'}</p>
                </div>
                <div>
                  <h4 className="text-sm font-medium text-foreground/80 mb-1">Human Decision Supported</h4>
                  <p className="text-muted-foreground text-sm leading-relaxed">{project.humanDecision || 'Not specified'}</p>
                </div>
                {project.hypotheses && project.hypotheses.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium text-foreground/80 mb-1">Hypotheses</h4>
                    <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-1">
                      {project.hypotheses.map((h, i) => <li key={i}>{h}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            </GlassPanel>

            <GlassPanel className="p-6">
              <h3 className="text-lg font-display font-semibold mb-4 flex items-center gap-2"><AlertTriangle className="w-5 h-5 text-warning" /> Governance</h3>
              <div className="space-y-4">
                <div>
                  <h4 className="text-sm font-medium text-foreground/80 mb-1">Ethics Notes</h4>
                  <p className="text-muted-foreground text-sm leading-relaxed">{project.ethicsNotes || 'None recorded'}</p>
                </div>
                <div>
                  <h4 className="text-sm font-medium text-foreground/80 mb-1">Required Disclosures</h4>
                  <p className="text-muted-foreground text-sm leading-relaxed">{project.disclosureNotes || 'None recorded'}</p>
                </div>
              </div>
            </GlassPanel>
          </div>
        </TabsContent>

        <TabsContent value="runs">
          <GlassPanel className="overflow-hidden">
            {loadingRuns ? (
              <div className="p-8 text-center animate-pulse text-muted-foreground">Loading runs...</div>
            ) : runs?.length === 0 ? (
              <div className="p-12 text-center text-muted-foreground flex flex-col items-center">
                <Play className="w-8 h-8 opacity-20 mb-4" />
                <p>No meetings run for this project yet.</p>
                <Link href={`/app/meetings/new?projectId=${project.id}`}>
                  <Button variant="outline" className="mt-4">Start New Meeting</Button>
                </Link>
              </div>
            ) : (
              <div className="divide-y divide-border/40">
                {runs?.map(run => (
                  <Link key={run.id} href={['running', 'paused', 'queued', 'validating', 'pause_pending', 'cancelling'].includes(run.status) ? `/app/runs/${run.id}/live` : `/app/runs/${run.id}`} className="flex flex-col sm:flex-row sm:items-center justify-between p-5 hover:bg-muted/50 transition-colors gap-4">
                    <div>
                      <div className="font-medium text-foreground mb-1 text-lg">{run.title}</div>
                      <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
                        <span className="flex items-center"><Clock className="w-3.5 h-3.5 mr-1" /> {format(new Date(run.createdAt), 'MMM d, yyyy HH:mm')}</span>
                        <span className="flex items-center"><Activity className="w-3.5 h-3.5 mr-1" /> {run.rounds} rounds</span>
                        <span>{run.callCount} calls</span>
                      </div>
                    </div>
                    <RunStatusBadge status={run.status} isSimulation={run.isSimulation} />
                  </Link>
                ))}
              </div>
            )}
          </GlassPanel>
        </TabsContent>
      </Tabs>
    </div>
  );
}
