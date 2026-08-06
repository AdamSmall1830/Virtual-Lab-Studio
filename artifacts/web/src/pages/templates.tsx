import React from 'react';
import { Link } from 'wouter';
import { useTemplates, getListTemplatesApiV1WorkspacesWorkspaceIdTemplatesGetQueryKey } from '@/api';
import { useSession } from '@/api/session';
import type { TemplateProfileOut } from '@/api';
import { LayoutTemplate, Play, Loader2, AlertTriangle, ListChecks, MessageSquare } from 'lucide-react';

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function TemplateSkeleton() {
  return (
    <div className="vls-reading-surface rounded-xl p-6 animate-pulse">
      <div className="h-4 w-28 bg-muted rounded mb-4" />
      <div className="h-6 w-2/3 bg-muted rounded mb-4" />
      <div className="h-3 w-full bg-muted rounded mb-2" />
      <div className="h-3 w-5/6 bg-muted rounded mb-6" />
      <div className="h-9 w-full bg-muted rounded" />
    </div>
  );
}

export default function Templates() {
  const { workspaceId } = useSession();
  const templatesQuery = useTemplates(workspaceId ?? '', {
    query: {
      enabled: Boolean(workspaceId),
      queryKey: getListTemplatesApiV1WorkspacesWorkspaceIdTemplatesGetQueryKey(workspaceId ?? ''),
    },
  });

  const templates = templatesQuery.data ?? [];

  return (
    <div className="space-y-6 animate-in fade-in duration-500 max-w-6xl mx-auto">
      <header>
        <h1 className="text-3xl font-display font-bold">Template Library</h1>
        <p className="text-sm text-muted-foreground mt-1">Standardized academic and analytical meeting patterns.</p>
      </header>

      {templatesQuery.isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {Array.from({ length: 4 }).map((_, i) => (
            <TemplateSkeleton key={i} />
          ))}
        </div>
      ) : templatesQuery.isError ? (
        <div className="vls-glass rounded-xl p-12 text-center border border-destructive/30">
          <AlertTriangle className="w-8 h-8 text-destructive mx-auto mb-3" />
          <h2 className="text-lg font-display font-semibold mb-1">Couldn't load templates</h2>
          <p className="text-muted-foreground text-sm mb-4">There was a problem reaching the workspace.</p>
          <button
            onClick={() => templatesQuery.refetch()}
            className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90"
          >
            Retry
          </button>
        </div>
      ) : templates.length === 0 ? (
        <div className="vls-glass rounded-xl p-12 text-center border-dashed">
          <div className="w-16 h-16 bg-primary/10 text-primary rounded-2xl flex items-center justify-center mx-auto mb-4">
            <LayoutTemplate className="w-8 h-8" />
          </div>
          <h2 className="text-xl font-display font-semibold mb-2">No templates available</h2>
          <p className="text-muted-foreground max-w-md mx-auto">
            Meeting templates are seeded server-side. None are currently available for this workspace.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {templates.map((template: TemplateProfileOut) => {
            const version = template.latest_version ?? null;
            const def = (version?.definition_json ?? {}) as Record<string, unknown>;
            const questions = asStringArray(def.questions);
            const rules = asStringArray(def.rules);
            const rounds = typeof def.default_rounds === 'number' ? def.default_rounds : null;

            return (
              <div key={template.id} className="vls-reading-surface rounded-xl p-6 flex flex-col">
                <div className="flex items-start justify-between mb-3 gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                      <LayoutTemplate className="w-4 h-4" />
                    </div>
                    {template.category && (
                      <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground truncate">
                        {template.category}
                      </span>
                    )}
                  </div>
                  {version && (
                    <div className="text-xs font-medium bg-background px-2 py-1 rounded border border-border capitalize shrink-0">
                      {version.meeting_type} · v{version.version_number}
                    </div>
                  )}
                </div>

                <h2 className="text-xl font-display font-semibold mb-2">{template.name}</h2>
                <p className="text-sm text-muted-foreground mb-6 flex-1">
                  {template.description || 'No description provided.'}
                </p>

                {(questions.length > 0 || rules.length > 0) && (
                  <div className="bg-background/50 rounded-lg p-4 mb-6 border border-border/50 space-y-3">
                    {questions.length > 0 && (
                      <div>
                        <div className="text-xs font-semibold text-foreground mb-2 flex items-center gap-2">
                          <MessageSquare className="w-4 h-4 text-secondary" /> Agenda questions
                        </div>
                        <ul className="text-xs text-muted-foreground space-y-1 list-disc pl-4">
                          {questions.slice(0, 3).map((q, i) => (
                            <li key={i} className="line-clamp-1">{q}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {rules.length > 0 && (
                      <div>
                        <div className="text-xs font-semibold text-foreground mb-2 flex items-center gap-2">
                          <ListChecks className="w-4 h-4 text-accent" /> Rules
                        </div>
                        <ul className="text-xs text-muted-foreground space-y-1 list-disc pl-4">
                          {rules.slice(0, 3).map((r, i) => (
                            <li key={i} className="line-clamp-1">{r}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}

                <div className="flex items-center justify-between pt-4 border-t border-border mt-auto">
                  <div className="text-xs text-muted-foreground">
                    {rounds !== null ? `Default: ${rounds} rounds` : 'Meeting template'}
                  </div>
                  <Link
                    href={`/app/meetings/new?template=${template.slug}`}
                    className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 flex items-center gap-2 transition-transform active:scale-95"
                  >
                    <Play className="w-4 h-4" /> Use Template
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {templatesQuery.isFetching && !templatesQuery.isLoading && (
        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="w-3 h-3 animate-spin" /> Refreshing…
        </div>
      )}
    </div>
  );
}
