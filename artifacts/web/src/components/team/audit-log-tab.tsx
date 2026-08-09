import React, { useState } from 'react';
import { useAuditLog, getAuditLogQueryKey } from '@/api';
import { Loader2, ChevronLeft, ChevronRight, Activity } from 'lucide-react';

export default function AuditLogTab({ workspaceId }: { workspaceId: string }) {
  const [offset, setOffset] = useState(0);
  const limit = 50;

  const { data, isLoading, isError } = useAuditLog(workspaceId, { limit, offset }, {
    query: { enabled: !!workspaceId, queryKey: getAuditLogQueryKey(workspaceId, { limit, offset }) }
  });

  const hasNext = data?.next_offset !== null && data?.next_offset !== undefined;

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <div className="bg-primary/10 border border-primary/20 p-4 rounded-xl flex items-start gap-4">
        <Activity className="w-6 h-6 text-primary shrink-0 mt-0.5" />
        <div>
          <h3 className="font-semibold text-sm text-primary mb-1">Workspace Audit Log</h3>
          <p className="text-xs text-muted-foreground">
            A server-written record of sensitive actions in this workspace. Entries are only ever
            appended: nothing in the application updates or deletes them.
          </p>
        </div>
      </div>

      <div className="vls-reading-surface rounded-xl border overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left border-collapse">
            <thead className="bg-muted/50 text-[10px] text-muted-foreground uppercase tracking-wider font-medium border-b">
              <tr>
                <th className="px-4 py-3 whitespace-nowrap">Time</th>
                <th className="px-4 py-3 whitespace-nowrap">Actor</th>
                <th className="px-4 py-3 whitespace-nowrap">Action</th>
                <th className="px-4 py-3 whitespace-nowrap">Object</th>
                <th className="px-4 py-3 w-full">Metadata</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
               {isLoading && (
                 <tr><td colSpan={5} className="p-8 text-center text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin mx-auto" /></td></tr>
               )}
               {isError && (
                 <tr><td colSpan={5} className="p-8 text-center text-destructive">Failed to load audit log.</td></tr>
               )}
               {data?.events?.map(ev => (
                 <tr key={ev.id} className="hover:bg-muted/10 transition-colors align-top">
                   <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                     {new Date(ev.created_at).toLocaleString()}
                   </td>
                   <td className="px-4 py-3">
                     <div className="font-medium text-xs truncate max-w-[150px]">{ev.actor_email || 'System'}</div>
                   </td>
                   <td className="px-4 py-3 font-mono text-xs whitespace-nowrap">
                     {ev.action}
                   </td>
                   <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                     {ev.object_type} {ev.object_id && <span className="font-mono text-[10px] bg-muted px-1.5 py-0.5 rounded ml-1">{ev.object_id.slice(0, 8)}</span>}
                   </td>
                   <td className="px-4 py-3 text-[10px] font-mono text-muted-foreground break-all max-w-[300px]">
                     {JSON.stringify(ev.metadata)}
                   </td>
                 </tr>
               ))}
               {data?.events?.length === 0 && (
                 <tr><td colSpan={5} className="p-8 text-center text-muted-foreground">No events recorded.</td></tr>
               )}
            </tbody>
          </table>
        </div>
        <div className="p-4 border-t bg-muted/20 flex items-center justify-between text-sm">
           <button
             onClick={() => setOffset(Math.max(0, offset - limit))}
             disabled={offset === 0}
             className="flex items-center gap-1 px-3 py-1.5 border rounded-lg bg-background hover:bg-muted disabled:opacity-50 transition-colors font-medium shadow-sm"
           >
             <ChevronLeft className="w-4 h-4" /> Previous
           </button>
           <span className="text-muted-foreground text-xs font-medium">Offset: {offset}</span>
           <button
             onClick={() => data?.next_offset && setOffset(data.next_offset)}
             disabled={!hasNext}
             className="flex items-center gap-1 px-3 py-1.5 border rounded-lg bg-background hover:bg-muted disabled:opacity-50 transition-colors font-medium shadow-sm"
           >
             Next <ChevronRight className="w-4 h-4" />
           </button>
        </div>
      </div>
    </div>
  );
}
