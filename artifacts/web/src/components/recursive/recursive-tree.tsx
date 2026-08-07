import React from 'react';
import { Coins, Cpu, Wrench } from 'lucide-react';
import {
  buildNodeTree,
  formatUsd,
  nodeStatusPresentation,
  type TreeNode,
} from '@/lib/recursive';
import type { RecursiveAgentNodeOut } from '@/api';
import { StatusChip } from './status-chip';

function NodeRow({ entry }: { entry: TreeNode }) {
  const n = entry.node;
  const presentation = nodeStatusPresentation(n.status);
  const tokens = (n.input_tokens ?? 0) + (n.output_tokens ?? 0);

  return (
    <li>
      <div
        className="rounded-lg border border-border/70 bg-background/40 p-3"
        style={{ marginLeft: entry.depth * 20 }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-semibold text-sm truncate">{n.display_name}</div>
            {n.model_key && (
              <div className="text-[11px] font-mono text-muted-foreground truncate mt-0.5">
                {n.model_key}
              </div>
            )}
          </div>
          <StatusChip presentation={presentation} size="xs" className="shrink-0" />
        </div>

        {n.task_summary && (
          <p className="text-xs text-muted-foreground mt-2 leading-relaxed">{n.task_summary}</p>
        )}
        {n.result_summary && (
          <p className="text-xs mt-2 leading-relaxed border-l-2 border-primary/30 pl-2">
            {n.result_summary}
          </p>
        )}
        {n.failure_safe_message && (
          <p className="text-xs mt-2 leading-relaxed text-destructive">{n.failure_safe_message}</p>
        )}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-[11px] text-muted-foreground font-mono">
          <span className="inline-flex items-center gap-1">
            <Cpu className="w-3 h-3" aria-hidden />
            {n.model_call_count ?? 0} calls
          </span>
          <span>{tokens.toLocaleString()} tokens</span>
          <span className="inline-flex items-center gap-1">
            <Coins className="w-3 h-3" aria-hidden />
            {formatUsd(n.cost_usd)}
          </span>
          {(n.tool_labels ?? []).length > 0 && (
            <span className="inline-flex items-center gap-1">
              <Wrench className="w-3 h-3" aria-hidden />
              {n.tool_labels.join(', ')}
            </span>
          )}
          {(n.cited_evidence_keys ?? []).length > 0 && (
            <span>Cited: {n.cited_evidence_keys.join(', ')}</span>
          )}
        </div>
      </div>
      {entry.children.length > 0 && (
        <ul className="space-y-2 mt-2">
          {entry.children.map((child) => (
            <NodeRow key={child.node.id ?? child.node.external_node_id} entry={child} />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * The agent tree for one recursive turn.
 *
 * Every field here comes from the server's node records, which are rebuilt
 * from a fixed allow-list of worker-reported fields. Nothing on this screen is
 * derived from raw coordinator output.
 */
export function RecursiveTree({
  nodes,
  emptyMessage = 'The worker has not reported any agents for this turn yet.',
}: {
  nodes: RecursiveAgentNodeOut[];
  emptyMessage?: string;
}) {
  const roots = React.useMemo(() => buildNodeTree(nodes), [nodes]);
  if (roots.length === 0) {
    return <p className="text-xs text-muted-foreground italic">{emptyMessage}</p>;
  }
  return (
    <ul className="space-y-2">
      {roots.map((root) => (
        <NodeRow key={root.node.id ?? root.node.external_node_id} entry={root} />
      ))}
    </ul>
  );
}
