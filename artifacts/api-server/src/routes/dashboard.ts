import { Router, type IRouter } from "express";
import { db, projectsTable, agentsTable, templatesTable, runsTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { serializeRun } from "../lib/serialize";

const router: IRouter = Router();

router.get("/v1/dashboard/summary", async (_req, res) => {
  const [projects, agents, templates, runs] = await Promise.all([
    db.select({ id: projectsTable.id, name: projectsTable.name }).from(projectsTable),
    db.select({ id: agentsTable.id }).from(agentsTable),
    db.select({ id: templatesTable.id }).from(templatesTable),
    db.select().from(runsTable).orderBy(desc(runsTable.createdAt)),
  ]);
  const names = new Map(projects.map((p) => [p.id, p.name]));
  const runCounts: Record<string, number> = {};
  let totalTokens = 0;
  let totalCalls = 0;
  for (const r of runs) {
    runCounts[r.status] = (runCounts[r.status] ?? 0) + 1;
    totalTokens += r.tokensUsed;
    totalCalls += r.callCount;
  }
  res.json({
    projectCount: projects.length,
    agentCount: agents.length,
    templateCount: templates.length,
    runCounts,
    totalTokens,
    totalCalls,
    estimatedCost: 0,
    recentRuns: runs.slice(0, 8).map((r) => serializeRun(r, names.get(r.projectId) ?? null)),
  });
});

export default router;
