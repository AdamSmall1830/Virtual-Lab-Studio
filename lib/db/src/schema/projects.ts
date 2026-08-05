import { pgTable, text, timestamp, jsonb, uuid } from "drizzle-orm/pg-core";

export const projectsTable = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  abstract: text("abstract"),
  domain: text("domain"),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  status: text("status").notNull().default("active"),
  researchQuestion: text("research_question"),
  hypotheses: jsonb("hypotheses").$type<string[]>().notNull().default([]),
  objectives: jsonb("objectives").$type<string[]>().notNull().default([]),
  constraints: jsonb("constraints").$type<string[]>().notNull().default([]),
  ethicsNotes: text("ethics_notes"),
  disclosureNotes: text("disclosure_notes"),
  humanDecision: text("human_decision"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ProjectRow = typeof projectsTable.$inferSelect;
