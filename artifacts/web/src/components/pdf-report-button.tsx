import { useState } from 'react';
import { FileDown, Loader2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useCreateExport,
  getRunExportsQueryKey,
  exportDownloadUrl,
  ExportCreateInFormat,
} from '@/api';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import {
  REPORT_SECTIONS,
  DEFAULT_REPORT_SECTIONS,
  type ReportSection,
} from '@/lib/report-sections';

type Props = {
  runId: string;
  /** Rendered as a full-width primary button instead of a compact one. */
  prominent?: boolean;
  className?: string;
};

/**
 * Builds a typeset PDF of the run's conclusions plus whichever appendices the
 * reader wants, then hands the finished file straight to the browser.
 *
 * The export is created server-side as a normal export job, so the same file
 * stays available (and hash-checked) from the run's Exports tab afterwards.
 */
export function PdfReportButton({ runId, prominent = false, className = '' }: Props) {
  const queryClient = useQueryClient();
  const createExport = useCreateExport();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<ReportSection[]>(DEFAULT_REPORT_SECTIONS);
  const [failure, setFailure] = useState<string | null>(null);

  const toggle = (id: ReportSection) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));

  const allOn = selected.length === REPORT_SECTIONS.length;

  const build = async () => {
    setFailure(null);
    try {
      const job = await createExport.mutateAsync({
        runId,
        data: {
          format: ExportCreateInFormat.report_pdf,
          // Print in the report's own order, not the order they were clicked.
          sections: REPORT_SECTIONS.filter((s) => selected.includes(s.id)).map((s) => s.id),
        },
      });
      await queryClient.invalidateQueries({ queryKey: getRunExportsQueryKey(runId) });
      if (job.status !== 'completed') {
        setFailure(job.error_safe_message ?? 'The report could not be produced. Please try again.');
        return;
      }
      setOpen(false);
      window.location.assign(exportDownloadUrl(job.id));
    } catch {
      setFailure('Could not build the report. Please try again.');
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setFailure(null);
          setOpen(true);
        }}
        data-testid="button-open-pdf-report"
        className={
          prominent
            ? `bg-primary text-primary-foreground px-6 py-2.5 rounded-lg text-sm font-semibold hover:bg-primary/90 transition-colors inline-flex items-center gap-2 ${className}`
            : `vls-glass text-foreground px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-background/50 transition-colors inline-flex items-center gap-2 border border-border ${className}`
        }
      >
        <FileDown className={prominent ? 'w-4 h-4' : 'w-3.5 h-3.5'} />
        Download PDF report
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid="dialog-pdf-report" className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="font-display">Build a PDF report</DialogTitle>
            <DialogDescription>
              The conclusions record — executive summary, recommendation, agenda answers,
              disagreements, assumptions, risks, next steps, contributions, confidence, and
              disclosure — is always included. Choose what to attach after it.
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center justify-between border-y border-border py-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Appendices
            </span>
            <button
              type="button"
              onClick={() => setSelected(allOn ? [] : REPORT_SECTIONS.map((s) => s.id))}
              data-testid="button-toggle-all-sections"
              className="text-xs font-medium text-primary hover:underline"
            >
              {allOn ? 'Clear all' : 'Select all'}
            </button>
          </div>

          <div className="space-y-1 -mt-2 max-h-[45vh] overflow-y-auto pr-1">
            {REPORT_SECTIONS.map((section) => (
              <label
                key={section.id}
                data-testid={`checkbox-section-${section.id}`}
                className="flex items-start gap-3 rounded-lg p-2.5 hover:bg-muted/50 cursor-pointer"
              >
                <Checkbox
                  checked={selected.includes(section.id)}
                  onCheckedChange={() => toggle(section.id)}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium leading-snug">{section.label}</span>
                  <span className="block text-xs text-muted-foreground leading-snug mt-0.5">
                    {section.hint}
                  </span>
                </span>
              </label>
            ))}
          </div>

          {failure && (
            <p className="text-sm text-destructive" data-testid="text-pdf-report-error">
              {failure}
            </p>
          )}

          <DialogFooter className="sm:justify-between items-center gap-3">
            <p className="text-xs text-muted-foreground text-left">
              Every page is marked model-generated and carries the run's review status.
            </p>
            <button
              type="button"
              onClick={build}
              disabled={createExport.isPending}
              data-testid="button-build-pdf-report"
              className="bg-primary text-primary-foreground px-5 py-2 rounded-lg text-sm font-semibold hover:bg-primary/90 transition-colors inline-flex items-center gap-2 disabled:opacity-50 shrink-0"
            >
              {createExport.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <FileDown className="w-4 h-4" />
              )}
              {createExport.isPending ? 'Typesetting…' : 'Build & download'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
