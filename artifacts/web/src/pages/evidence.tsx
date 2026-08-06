import React, { useState } from 'react';
import {
  Search, Database, Plus, ExternalLink, Hash, X, Save, FileText, Trash2,
  Loader2, XCircle, Upload, BookOpen, AlertTriangle, CheckCircle2, Clock, Download,
} from 'lucide-react';
import { format } from 'date-fns';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/api/session';
import {
  useProjects,
  getProjectsQueryKey,
  useProjectEvidence,
  getProjectEvidenceQueryKey,
  useEvidenceChunks,
  getListEvidenceChunksApiV1EvidenceSourceIdChunksGetQueryKey as getEvidenceChunksQueryKey,
  useArchiveEvidence,
  useCreateEvidenceNote,
  useUploadEvidence,
  useSearchEvidence,
  usePmcSearch,
  usePmcImport,
  type ProjectOut,
  type EvidenceSourceOut,
  type EvidenceSearchHit,
} from '@/api';

type PmcResult = { pmcid: string; title: string; journal?: string | null; authors?: string[] };

function processingBadge(ev: EvidenceSourceOut) {
  switch (ev.processing_status) {
    case 'ready':
      return <span className="inline-flex items-center gap-1 text-xs text-accent"><CheckCircle2 className="w-3.5 h-3.5" /> Ready</span>;
    case 'failed':
    case 'quarantined':
      return <span className="inline-flex items-center gap-1 text-xs text-destructive"><AlertTriangle className="w-3.5 h-3.5" /> {ev.processing_status}</span>;
    default:
      return <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Clock className="w-3.5 h-3.5" /> {ev.processing_status}</span>;
  }
}

export default function Evidence() {
  const { workspaceId } = useSession();
  const queryClient = useQueryClient();

  const projectsQuery = useProjects(workspaceId ?? '', {
    query: { enabled: Boolean(workspaceId), queryKey: getProjectsQueryKey(workspaceId ?? '') },
  });
  const projects: ProjectOut[] = projectsQuery.data ?? [];

  const [projectId, setProjectId] = useState<string | null>(null);
  const activeProjectId = projectId ?? projects[0]?.id ?? null;

  const [drawer, setDrawer] = useState<'add' | 'pmc' | null>(null);
  const [chunksFor, setChunksFor] = useState<EvidenceSourceOut | null>(null);

  const evidenceQuery = useProjectEvidence(activeProjectId ?? '', {
    query: { enabled: Boolean(activeProjectId), queryKey: getProjectEvidenceQueryKey(activeProjectId ?? '') },
  });
  const evidence = evidenceQuery.data ?? [];

  const archive = useArchiveEvidence();

  const invalidateEvidence = () =>
    queryClient.invalidateQueries({ queryKey: getProjectEvidenceQueryKey(activeProjectId ?? '') });

  const handleArchive = async (ev: EvidenceSourceOut) => {
    if (!confirm(`Archive "${ev.title}"? It will no longer be available for future runs.`)) return;
    await archive.mutateAsync({ sourceId: ev.id });
    await invalidateEvidence();
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500 max-w-6xl mx-auto pb-12 relative h-full">
      <header className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-display font-bold">Evidence Library</h1>
          <p className="text-sm text-muted-foreground mt-1">Per-project repository of literature, data, and notes.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setDrawer('pmc')}
            disabled={!activeProjectId}
            className="vls-glass text-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-background/50 transition-colors flex items-center gap-2 border border-border disabled:opacity-50"
          >
            <BookOpen className="w-4 h-4" /> PubMed Central
          </button>
          <button
            onClick={() => setDrawer('add')}
            disabled={!activeProjectId}
            className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors flex items-center gap-2 disabled:opacity-50"
          >
            <Plus className="w-4 h-4" /> Add Source
          </button>
        </div>
      </header>

      {/* Project selector */}
      {projectsQuery.isLoading ? (
        <div className="h-10 w-64 bg-muted rounded-lg animate-pulse" />
      ) : projectsQuery.isError ? (
        <div className="text-sm text-destructive">Could not load projects.</div>
      ) : projects.length === 0 ? (
        <div className="vls-glass rounded-xl p-12 text-center border-dashed">
          <Database className="w-10 h-10 mx-auto mb-3 opacity-30 text-muted-foreground" />
          <p className="text-muted-foreground">Create a project first to add evidence.</p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-medium text-muted-foreground">Project</span>
            <select
              value={activeProjectId ?? ''}
              onChange={(e) => setProjectId(e.target.value)}
              className="bg-background border border-input rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-primary/50 outline-none"
            >
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>

          <WorkspaceSearch workspaceId={workspaceId} />

          {/* Evidence list */}
          {evidenceQuery.isLoading ? (
            <div className="space-y-4">
              {[0, 1].map((i) => (
                <div key={i} className="vls-reading-surface rounded-xl p-6 h-32 animate-pulse bg-muted/30" />
              ))}
            </div>
          ) : evidenceQuery.isError ? (
            <div className="vls-glass rounded-xl p-12 text-center border border-destructive/30 bg-destructive/5">
              <XCircle className="w-8 h-8 text-destructive mx-auto mb-3" />
              <p className="text-sm text-muted-foreground mb-4">Could not load evidence for this project.</p>
              <button
                onClick={() => evidenceQuery.refetch()}
                className="bg-foreground text-background px-4 py-2 rounded-lg text-sm font-semibold inline-flex items-center gap-2"
              >
                Retry
              </button>
            </div>
          ) : evidence.length === 0 ? (
            <div className="text-center py-20 text-muted-foreground vls-glass rounded-xl border-dashed">
              <Database className="w-10 h-10 mx-auto mb-3 opacity-20" />
              No evidence in this project yet.
            </div>
          ) : (
            <div className="space-y-4">
              {evidence.map((ev) => (
                <div key={ev.id} className="vls-reading-surface rounded-xl p-6 border-l-4 border-l-accent flex flex-col md:flex-row gap-6 group">
                  <div className="flex-1 space-y-3 min-w-0">
                    <div>
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <Database className="w-4 h-4 text-accent" />
                        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{ev.source_type}</span>
                        <span className="text-muted-foreground">•</span>
                        <span className="text-xs text-muted-foreground flex items-center gap-1 font-mono">
                          <Hash className="w-3 h-3" /> {ev.evidence_key}
                        </span>
                        <span className="text-muted-foreground">•</span>
                        {processingBadge(ev)}
                      </div>
                      <h3 className="text-lg font-display font-semibold">{ev.title}</h3>
                      {ev.citation && (
                        <div className="text-sm text-muted-foreground mt-1 italic border-l-2 border-border pl-3 ml-1 py-0.5">
                          {ev.citation}
                        </div>
                      )}
                    </div>
                    {(ev.processing_status === 'failed' || ev.processing_status === 'quarantined') && ev.processing_error_safe_message && (
                      <div className="text-sm text-destructive bg-destructive/5 border border-destructive/20 rounded-lg p-3">
                        {ev.processing_error_safe_message}
                      </div>
                    )}
                    {ev.source_url && (
                      <a href={ev.source_url} target="_blank" rel="noreferrer" className="text-primary text-sm inline-flex items-center gap-1 hover:underline w-fit">
                        {ev.source_url} <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>

                  <div className="w-full md:w-56 shrink-0 space-y-3 border-t md:border-t-0 md:border-l border-border pt-4 md:pt-0 md:pl-6 text-sm flex flex-col">
                    <div>
                      <div className="text-xs font-semibold text-muted-foreground mb-1">Added</div>
                      <div>{format(new Date(ev.created_at), 'PP')}</div>
                    </div>
                    {ev.original_filename && (
                      <div>
                        <div className="text-xs font-semibold text-muted-foreground mb-1">File</div>
                        <div className="truncate font-mono text-xs">{ev.original_filename}</div>
                      </div>
                    )}
                    <div className="pt-2 flex-1 flex flex-col justify-end gap-2">
                      <button
                        onClick={() => setChunksFor(ev)}
                        className="text-primary font-medium flex items-center gap-1 hover:underline w-fit text-sm"
                      >
                        View chunks <ExternalLink className="w-3 h-3" />
                      </button>
                      <button
                        onClick={() => handleArchive(ev)}
                        disabled={archive.isPending}
                        className="text-xs font-medium text-destructive hover:underline flex items-center gap-1 w-fit disabled:opacity-50"
                      >
                        <Trash2 className="w-3 h-3" /> Archive
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {drawer === 'add' && activeProjectId && (
        <AddSourceDrawer projectId={activeProjectId} onClose={() => setDrawer(null)} onDone={invalidateEvidence} />
      )}
      {drawer === 'pmc' && activeProjectId && (
        <PmcDrawer workspaceId={workspaceId} projectId={activeProjectId} onClose={() => setDrawer(null)} onDone={invalidateEvidence} />
      )}
      {chunksFor && <ChunksDialog evidence={chunksFor} onClose={() => setChunksFor(null)} />}
    </div>
  );
}

// -------------------------------------------------------------------------
// Workspace-wide full-text search
// -------------------------------------------------------------------------

function WorkspaceSearch({ workspaceId }: { workspaceId: string | null }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<EvidenceSearchHit[] | null>(null);
  const search = useSearchEvidence();

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspaceId || !query.trim()) return;
    const result = await search.mutateAsync({ workspaceId, data: { query: query.trim(), limit: 15 } });
    setHits(result as EvidenceSearchHit[]);
  };

  return (
    <div className="space-y-3">
      <form onSubmit={run} className="vls-glass p-2 rounded-xl flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="w-5 h-5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search all workspace evidence (full text)…"
            className="w-full bg-transparent border-none focus:ring-0 pl-10 pr-4 py-2 text-sm text-foreground outline-none"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button
          type="submit"
          disabled={search.isPending || !query.trim() || !workspaceId}
          className="bg-foreground text-background px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-2 disabled:opacity-50"
        >
          {search.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          Search
        </button>
      </form>

      {search.isError && <p className="text-sm text-destructive">Search failed. Please try again.</p>}

      {hits !== null && (
        <div className="border border-border rounded-xl divide-y divide-border overflow-hidden">
          {hits.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground text-center">No matches found.</div>
          ) : (
            hits.map((h) => (
              <div key={h.chunk_id} className="p-4 bg-background/50">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-mono text-xs bg-accent/10 text-accent px-1.5 py-0.5 rounded border border-accent/20">{h.evidence_key}</span>
                  <span className="text-sm font-medium">{h.title}</span>
                  {h.locator && <span className="text-xs text-muted-foreground font-mono">{h.locator}</span>}
                </div>
                <p className="text-sm text-muted-foreground">{renderSnippet(h.snippet)}</p>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Render a Postgres ts_headline snippet safely. The snippet may contain
 * arbitrary user-uploaded text plus `<b>...</b>` highlight markers — we never
 * inject it as HTML; we only split on the markers and render everything as text.
 */
function renderSnippet(snippet: string): React.ReactNode {
  const parts = snippet.split(/<\/?b>/g);
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="bg-primary/20 text-foreground rounded px-0.5">
        {part}
      </mark>
    ) : (
      <React.Fragment key={i}>{part}</React.Fragment>
    ),
  );
}

// -------------------------------------------------------------------------
// Chunks dialog
// -------------------------------------------------------------------------

function ChunksDialog({ evidence, onClose }: { evidence: EvidenceSourceOut; onClose: () => void }) {
  const q = useEvidenceChunks(evidence.id, { query: { enabled: Boolean(evidence.id), queryKey: getEvidenceChunksQueryKey(evidence.id) } });
  const chunks = q.data ?? [];

  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex justify-center p-4 sm:p-8">
      <div className="w-full max-w-3xl h-full bg-background border border-border shadow-2xl rounded-xl flex flex-col animate-in zoom-in-95">
        <header className="flex items-center justify-between p-4 sm:p-6 border-b border-border shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <FileText className="w-6 h-6 text-accent shrink-0" />
            <h2 className="text-xl font-display font-semibold truncate">{evidence.title}</h2>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-muted rounded-lg text-muted-foreground hover:text-foreground">
            <X className="w-5 h-5" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
          {q.isLoading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="w-6 h-6 animate-spin" />
            </div>
          ) : q.isError ? (
            <p className="text-sm text-destructive text-center py-8">Could not load chunks.</p>
          ) : chunks.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No chunks available for this source.</p>
          ) : (
            chunks.map((c) => (
              <div key={c.id} className="border border-border rounded-lg p-4 bg-secondary/5">
                <div className="flex items-center gap-2 mb-2 text-xs text-muted-foreground font-mono">
                  <span className="bg-muted px-1.5 py-0.5 rounded">#{c.chunk_index}</span>
                  {c.locator && <span>{c.locator}</span>}
                  {c.token_count != null && <span className="ml-auto">{c.token_count} tok</span>}
                </div>
                <p className="text-sm font-serif leading-relaxed whitespace-pre-wrap">{c.content_text}</p>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------
// Add source drawer (note + file upload)
// -------------------------------------------------------------------------

function AddSourceDrawer({ projectId, onClose, onDone }: { projectId: string; onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<'note' | 'file'>('note');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [citation, setCitation] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);

  const createNote = useCreateEvidenceNote();
  const upload = useUploadEvidence();
  const busy = createNote.isPending || upload.isPending;
  const error = createNote.isError || upload.isError;

  const save = async () => {
    if (mode === 'note') {
      if (!title.trim() || !content.trim()) return;
      await createNote.mutateAsync({
        projectId,
        data: {
          title: title.trim(),
          content: content.trim(),
          citation: citation.trim() || null,
          source_url: sourceUrl.trim() || null,
        },
      });
    } else {
      if (!file) return;
      await upload.mutateAsync({
        projectId,
        data: { file, title: title.trim() || null, citation: citation.trim() || null },
      });
    }
    onDone();
    onClose();
  };

  const canSave = mode === 'note' ? Boolean(title.trim() && content.trim()) : Boolean(file);

  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex justify-end">
      <div className="w-full max-w-md h-full bg-background border-l border-border shadow-2xl flex flex-col animate-in slide-in-from-right">
        <header className="flex items-center justify-between p-4 border-b border-border shrink-0">
          <h2 className="text-lg font-display font-semibold">Add Source</h2>
          <button onClick={onClose} className="p-2 hover:bg-muted rounded-lg text-muted-foreground hover:text-foreground">
            <X className="w-5 h-5" />
          </button>
        </header>

        <div className="flex gap-1 p-4 border-b border-border">
          {(['note', 'file'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-colors ${
                mode === m ? 'bg-primary text-primary-foreground border-primary' : 'bg-background border-border hover:border-primary/50'
              }`}
            >
              {m === 'note' ? 'Text Note' : 'File Upload'}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Title {mode === 'note' && '*'}</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={mode === 'file' ? 'Defaults to filename' : ''}
              className="w-full bg-transparent border border-input rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-primary/50 outline-none"
            />
          </div>

          {mode === 'note' ? (
            <>
              <div className="space-y-2">
                <label className="text-sm font-medium">Source URL (optional)</label>
                <input
                  type="text"
                  value={sourceUrl}
                  onChange={(e) => setSourceUrl(e.target.value)}
                  className="w-full bg-transparent border border-input rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-primary/50 outline-none"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Content *</label>
                <textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  className="w-full bg-transparent border border-input rounded-md px-3 py-2 text-sm min-h-[200px] focus:ring-2 focus:ring-primary/50 outline-none"
                />
              </div>
            </>
          ) : (
            <div className="space-y-2">
              <label className="text-sm font-medium">File *</label>
              <label className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-border rounded-lg p-8 cursor-pointer hover:border-primary/50 transition-colors">
                <Upload className="w-8 h-8 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">{file ? file.name : 'Click to choose a file'}</span>
                <input
                  type="file"
                  className="hidden"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </label>
            </div>
          )}

          <div className="space-y-2">
            <label className="text-sm font-medium">Citation (optional)</label>
            <input
              type="text"
              value={citation}
              onChange={(e) => setCitation(e.target.value)}
              className="w-full bg-transparent border border-input rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-primary/50 outline-none"
            />
          </div>

          {error && <p className="text-sm text-destructive">Could not save the source. Please try again.</p>}
        </div>

        <div className="p-4 border-t border-border shrink-0 flex justify-end">
          <button
            onClick={save}
            disabled={!canSave || busy}
            className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-semibold hover:bg-primary/90 flex items-center gap-2 disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save Source
          </button>
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------
// PubMed Central drawer
// -------------------------------------------------------------------------

function PmcDrawer({
  workspaceId, projectId, onClose, onDone,
}: { workspaceId: string | null; projectId: string; onClose: () => void; onDone: () => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PmcResult[] | null>(null);
  const [importingId, setImportingId] = useState<string | null>(null);

  const pmcSearch = usePmcSearch();
  const pmcImport = usePmcImport();

  const runSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspaceId || !query.trim()) return;
    const raw = await pmcSearch.mutateAsync({ workspaceId, data: { query: query.trim(), limit: 15 } });
    const list = Array.isArray(raw) ? raw : ((raw as any)?.results ?? []);
    setResults(list as PmcResult[]);
  };

  const runImport = async (pmcid: string) => {
    setImportingId(pmcid);
    try {
      await pmcImport.mutateAsync({ projectId, data: { pmcid } });
      onDone();
    } finally {
      setImportingId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex justify-end">
      <div className="w-full max-w-md h-full bg-background border-l border-border shadow-2xl flex flex-col animate-in slide-in-from-right">
        <header className="flex items-center justify-between p-4 border-b border-border shrink-0">
          <h2 className="text-lg font-display font-semibold flex items-center gap-2">
            <BookOpen className="w-5 h-5 text-primary" /> PubMed Central
          </h2>
          <button onClick={onClose} className="p-2 hover:bg-muted rounded-lg text-muted-foreground hover:text-foreground">
            <X className="w-5 h-5" />
          </button>
        </header>

        <form onSubmit={runSearch} className="p-4 border-b border-border flex gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search open-access articles…"
            className="flex-1 bg-transparent border border-input rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-primary/50 outline-none"
          />
          <button
            type="submit"
            disabled={pmcSearch.isPending || !query.trim() || !workspaceId}
            className="bg-foreground text-background px-3 py-2 rounded-lg text-sm font-semibold flex items-center gap-2 disabled:opacity-50"
          >
            {pmcSearch.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          </button>
        </form>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {pmcSearch.isError && <p className="text-sm text-destructive">PubMed Central is unavailable right now.</p>}
          {pmcImport.isError && <p className="text-sm text-destructive">Import failed. Please try another article.</p>}

          {results === null ? (
            <p className="text-sm text-muted-foreground text-center py-12">Search PubMed Central to import an abstract as evidence.</p>
          ) : results.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-12">No articles found.</p>
          ) : (
            results.map((r) => (
              <div key={r.pmcid} className="border border-border rounded-lg p-4 bg-background/50">
                <div className="text-sm font-medium mb-1">{r.title}</div>
                <div className="text-xs text-muted-foreground mb-3">
                  <span className="font-mono">{r.pmcid}</span>
                  {r.journal && ` • ${r.journal}`}
                  {r.authors && r.authors.length > 0 && ` • ${r.authors.slice(0, 3).join(', ')}`}
                </div>
                <button
                  onClick={() => runImport(r.pmcid)}
                  disabled={importingId === r.pmcid}
                  className="bg-primary text-primary-foreground px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-primary/90 flex items-center gap-2 disabled:opacity-50"
                >
                  {importingId === r.pmcid ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                  Import
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
