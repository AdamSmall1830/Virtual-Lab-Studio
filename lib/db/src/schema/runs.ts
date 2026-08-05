import {
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  jsonb,
  boolean,
  real,
} from "drizzle-orm/pg-core";

export interface RunParticipantJson {
  agentId: string;
  roleType: "lead" | "member" | "expert" | "critic" | "merger";
  title: string;
  shortLabel?: string | null;
  provider?: string | null;
  model?: string | null;
  accentColor?: string | null;
}

export interface ScriptedEventJson {
  offsetMs: number;
  type: string;
  round?: number | null;
  agentId?: string | null;
  agentTitle?: string | null;
  roleType?: string | null;
  content?: string | null;
  payload?: Record<string, unknown> | null;
}

export const runsTable = pgTable("runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull(),
  templateId: uuid("template_id"),
  title: text("title").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull().default("queued"),
  agendaObjective: text("agenda_objective"),
  requiredQuestions: jsonb("required_questions").$type<string[]>().notNull().default([]),
  rules: jsonb("rules").$type<string[]>().notNull().default([]),
  rounds: integer("rounds").notNull().default(2),
  currentRound: integer("current_round").notNull().default(0),
  currentSpeaker: text("current_speaker"),
  participants: jsonb("participants").$type<RunParticipantJson[]>().notNull().default([]),
  isSimulation: boolean("is_simulation").notNull().default(true),
  callCount: integer("call_count").notNull().default(0),
  plannedCallCount: integer("planned_call_count"),
  tokensUsed: integer("tokens_used").notNull().default(0),
  estimatedCost: real("estimated_cost"),
  summary: jsonb("summary").$type<Record<string, unknown> | null>(),
  failureReason: text("failure_reason"),
  idempotencyKey: text("idempotency_key").unique(),
  // Deterministic demo script + lazy materialization cursor
  script: jsonb("script").$type<ScriptedEventJson[]>().notNull().default([]),
  scriptCursor: integer("script_cursor").notNull().default(0),
  pausedAt: timestamp("paused_at", { withTimezone: true }),
  pausedMsTotal: integer("paused_ms_total").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const runEventsTable = pgTable("run_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull(),
  seq: integer("seq").notNull(),
  type: text("type").notNull(),
  round: integer("round"),
  agentId: text("agent_id"),
  agentTitle: text("agent_title"),
  roleType: text("role_type"),
  content: text("content"),
  payload: jsonb("payload").$type<Record<string, unknown> | null>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type RunRow = typeof runsTable.$inferSelect;
export type RunEventRow = typeof runEventsTable.$inferSelect;
