// Live run event streaming over Server-Sent Events with replay.
//
// The backend replays all events strictly after `last_event_id`
// (a run_sequence number), then pushes live events until the run ends.
// We use fetch + a stream parser (rather than EventSource) so we can
// handle arbitrary named event types generically.

import { apiBase } from './index';
import type { RunEventOut } from '@workspace/api-client-react';

export interface RunStreamHandle {
  close: () => void;
}

interface SubscribeOptions {
  lastEventId?: number;
  onEvent: (event: RunEventOut) => void;
  /** Called when the stream ends because the run reached a terminal state. */
  onDone?: () => void;
  /** Called on network/parse errors (after reconnect attempts stop). */
  onError?: (error: unknown) => void;
}

const TERMINAL_EVENTS = new Set(['run.completed', 'run.failed', 'run.cancelled']);
const MAX_RETRIES = 5;

export function subscribeRunEvents(runId: string, opts: SubscribeOptions): RunStreamHandle {
  const controller = new AbortController();
  let lastId = opts.lastEventId ?? 0;
  let closed = false;
  let retries = 0;

  const connect = async () => {
    while (!closed) {
      try {
        const url = `${apiBase()}/v1/runs/${runId}/events/stream?last_event_id=${lastId}`;
        const res = await fetch(url, {
          headers: { Accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`);
        retries = 0;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let sawTerminal = false;

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let sep: number;
          while ((sep = buffer.indexOf('\n\n')) !== -1) {
            const raw = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            let data = '';
            let eventType = '';
            for (const line of raw.split('\n')) {
              if (line.startsWith(':')) continue; // heartbeat/comment
              if (line.startsWith('id:')) lastId = Number(line.slice(3).trim()) || lastId;
              else if (line.startsWith('event:')) eventType = line.slice(6).trim();
              else if (line.startsWith('data:')) data += line.slice(5).trim();
            }
            if (!data) continue;
            try {
              const parsed = JSON.parse(data) as RunEventOut;
              opts.onEvent(parsed);
              if (TERMINAL_EVENTS.has(parsed.event_type ?? eventType)) sawTerminal = true;
            } catch {
              // Ignore malformed frames.
            }
          }
        }

        if (sawTerminal || closed) {
          if (sawTerminal) opts.onDone?.();
          return;
        }
        // Stream closed without a terminal event (proxy timeout etc.) — reconnect.
      } catch (err) {
        if (closed || controller.signal.aborted) return;
        retries += 1;
        if (retries > MAX_RETRIES) {
          opts.onError?.(err);
          return;
        }
      }
      await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** retries, 10000)));
    }
  };

  void connect();

  return {
    close: () => {
      closed = true;
      controller.abort();
    },
  };
}
