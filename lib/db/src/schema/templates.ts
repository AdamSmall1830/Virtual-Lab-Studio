import { pgTable, text, timestamp, uuid, integer, jsonb } from "drizzle-orm/pg-core";

export const templatesTable = pgTable("meeting_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  kind: text("kind").notNull(), // team | individual | ensemble_merge
  category: text("category").notNull(),
  description: text("description").notNull(),
  objective: text("objective"),
  requiredQuestions: jsonb("required_questions").$type<string[]>().notNull().default([]),
  rules: jsonb("rules").$type<string[]>().notNull().default([]),
  suggestedAgentSlugs: jsonb("suggested_agent_slugs").$type<string[]>().notNull().default([]),
  defaultRounds: integer("default_rounds").notNull().default(2),
  intendedOutput: text("intended_output"),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type TemplateRow = typeof templatesTable.$inferSelect;
