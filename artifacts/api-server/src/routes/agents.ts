import { Router, type IRouter } from "express";
import { db, agentsTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { CreateAgentBody, UpdateAgentBody } from "@workspace/api-zod";
import { serializeAgent } from "../lib/serialize";

const router: IRouter = Router();

router.get("/v1/agents", async (_req, res) => {
  const rows = await db.select().from(agentsTable).orderBy(asc(agentsTable.title));
  res.json(rows.map(serializeAgent));
});

router.post("/v1/agents", async (req, res) => {
  const parsed = CreateAgentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
    return;
  }
  const d = parsed.data;
  const [row] = await db
    .insert(agentsTable)
    .values({
      title: d.title,
      shortLabel: d.shortLabel ?? null,
      expertise: d.expertise,
      goal: d.goal,
      role: d.role,
      advancedInstructions: d.advancedInstructions ?? null,
      limitations: d.limitations ?? null,
      provider: d.provider ?? "demo",
      model: d.model ?? "demo-research-v1",
      temperature: d.temperature ?? null,
      accentColor: d.accentColor ?? null,
    })
    .returning();
  res.status(201).json(serializeAgent(row!));
});

router.get("/v1/agents/:agentId", async (req, res) => {
  const [row] = await db.select().from(agentsTable).where(eq(agentsTable.id, req.params.agentId));
  if (!row) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  res.json(serializeAgent(row));
});

router.patch("/v1/agents/:agentId", async (req, res) => {
  const parsed = UpdateAgentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
    return;
  }
  const [existing] = await db
    .select()
    .from(agentsTable)
    .where(eq(agentsTable.id, req.params.agentId));
  if (!existing) {
    res.status(404).json({ error: "Agent not found" });
    return;
  }
  const contentChanged =
    parsed.data.title !== undefined ||
    parsed.data.expertise !== undefined ||
    parsed.data.goal !== undefined ||
    parsed.data.role !== undefined ||
    parsed.data.advancedInstructions !== undefined;
  const [row] = await db
    .update(agentsTable)
    .set({ ...parsed.data, version: contentChanged ? existing.version + 1 : existing.version })
    .where(eq(agentsTable.id, req.params.agentId))
    .returning();
  res.json(serializeAgent(row!));
});

export default router;
