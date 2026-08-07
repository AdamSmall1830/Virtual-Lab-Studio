import { ExportCreateInSectionsItem } from '@/api';

export type ReportSection = ExportCreateInSectionsItem;

export type ReportSectionSpec = {
  id: ReportSection;
  label: string;
  hint: string;
  /** Checked when the picker opens. */
  onByDefault: boolean;
};

/**
 * The optional appendices of the PDF report, in the order they are printed.
 *
 * The conclusions record is not listed: it is the report, and it is always
 * included. Everything here is an appendix the reader can choose to carry
 * along with it. The ids must match `PDF_REPORT_SECTIONS` in the backend —
 * the generated `ExportCreateInSectionsItem` union is what keeps them honest.
 */
export const REPORT_SECTIONS: readonly ReportSectionSpec[] = [
  {
    id: 'meeting_brief',
    label: 'Meeting brief',
    hint: 'The agenda, questions, and settings the run was launched with.',
    onByDefault: true,
  },
  {
    id: 'question_answers_detail',
    label: 'Agenda questions in full',
    hint: 'Each question with its full answer, stated confidence, and cited evidence.',
    onByDefault: true,
  },
  {
    id: 'transcript',
    label: 'Full transcript',
    hint: 'Every agent turn, verbatim. This is usually the longest part by far.',
    onByDefault: false,
  },
  {
    id: 'final_synthesis',
    label: 'Final synthesis (verbatim)',
    hint: 'The closing statement exactly as the model wrote it, before structuring.',
    onByDefault: false,
  },
  {
    id: 'evidence',
    label: 'Attached evidence',
    hint: 'The sources frozen into the run, with their content hashes.',
    onByDefault: true,
  },
  {
    id: 'citations',
    label: 'Citations and validation',
    hint: 'Claims the run cited, and whether each resolved to attached evidence.',
    onByDefault: true,
  },
  {
    id: 'agents',
    label: 'Agents and system prompts',
    hint: 'The roster, and the exact instructions each agent was given.',
    onByDefault: false,
  },
  {
    id: 'usage',
    label: 'Usage and cost',
    hint: 'Token counts, latency, and spend, per turn and in total.',
    onByDefault: true,
  },
  {
    id: 'recursive_execution',
    label: 'Recursive execution',
    hint: 'Turns delegated to an external worker: the limits imposed, and the agent tree it reported.',
    onByDefault: false,
  },
  {
    id: 'interventions',
    label: 'Human interventions',
    hint: 'Notes, redirections, and stops a person added while the run was live.',
    onByDefault: true,
  },
  {
    id: 'reviews',
    label: 'Human reviews',
    hint: 'Reviewer verdicts and comments recorded against this run.',
    onByDefault: true,
  },
  {
    id: 'provenance',
    label: 'Provenance and integrity',
    hint: 'Manifest hashes, software versions, and the providers that were called.',
    onByDefault: true,
  },
] as const;

export const DEFAULT_REPORT_SECTIONS: ReportSection[] = REPORT_SECTIONS.filter(
  (s) => s.onByDefault,
).map((s) => s.id);

const LABELS = new Map(REPORT_SECTIONS.map((s) => [s.id as string, s.label]));

/** Human labels for the sections stored on a finished export job. */
export function describeSections(sections: unknown): string | null {
  if (!Array.isArray(sections)) return null;
  const named = sections
    .map((s) => LABELS.get(String(s)))
    .filter((label): label is string => Boolean(label));
  if (named.length === 0) return 'Conclusions only';
  return `Conclusions + ${named.join(', ').toLowerCase()}`;
}
