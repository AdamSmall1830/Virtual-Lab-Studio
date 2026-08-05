import { pgTable, text, timestamp, uuid, integer, boolean, real } from "drizzle-orm/pg-core";

export const agentsTable = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").unique(),
  title: text("title").notNull(),
  shortLabel: text("short_label"),
  expertise: text("expertise").notNull(),
  goal: text("goal").notNull(),
  role: text("role").notNull(),
  advancedInstructions: text("advanced_instructions"),
  limitations: text("limitations"),
  provider: text("provider").notNull().default("demo"),
  model: text("model").notNull().default("demo-research-v1"),
  temperature: real("temperature"),
  accentColor: text("accent_color"),
  version: integer("version").notNull().default(1),
  archived: boolean("archived").notNull().default(false),
  isSystem: boolean("is_system").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AgentRow = typeof agentsTable.$inferSelect;
