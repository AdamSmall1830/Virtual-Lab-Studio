import { Router, type IRouter } from "express";
import { db, projectsTable, runsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { CreateProjectBody, UpdateProjectBody } from "@workspace/api-zod";
import { serializeProject, serializeRun } from "../lib/serialize";

const router: IRouter = Router();

async function runCounts(): Promise<Map<string, number>> {
  const rows = await db.select({ projectId: runsTable.projectId }).from(runsTable);
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.projectId, (m.get(r.projectId) ?? 0) + 1);
  return m;
}

router.get("/v1/projects", async (_req, res) => {
  const [rows, counts] = await Promise.all([
    db.select().from(projectsTable).orderBy(desc(projectsTable.updatedAt)),
    runCounts(),
  ]);
  res.json(rows.map((p) => serializeProject(p, counts.get(p.id) ?? 0)));
});

router.post("/v1/projects", async (req, res) => {
  const parsed = CreateProjectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
    return;
  }
  const [row] = await db.insert(projectsTable).values(parsed.data).returning();
  res.status(201).json(serializeProject(row!, 0));
});

router.get("/v1/projects/:projectId", async (req, res) => {
  const [row] = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, req.params.projectId));
  if (!row) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const counts = await runCounts();
  res.json(serializeProject(row, counts.get(row.id) ?? 0));
});

router.patch("/v1/projects/:projectId", async (req, res) => {
  const parsed = UpdateProjectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
    return;
  }
  const [row] = await db
    .update(projectsTable)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(projectsTable.id, req.params.projectId))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const counts = await runCounts();
  res.json(serializeProject(row, counts.get(row.id) ?? 0));
});

router.get("/v1/projects/:projectId/runs", async (req, res) => {
  const [project] = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, req.params.projectId));
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const rows = await db
    .select()
    .from(runsTable)
    .where(eq(runsTable.projectId, req.params.projectId))
    .orderBy(desc(runsTable.createdAt));
  res.json(rows.map((r) => serializeRun(r, project.name)));
});

export default router;
