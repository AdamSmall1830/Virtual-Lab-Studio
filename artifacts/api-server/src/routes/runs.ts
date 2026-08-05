import { Router, type IRouter } from "express";
import { db, runsTable, projectsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { LaunchRunBody, ControlRunBody } from "@workspace/api-zod";
import { serializeRun, serializeRunEvent } from "../lib/serialize";
import { appendEvent, buildScript, listEvents, materializeRun } from "../lib/demoEngine";

const router: IRouter = Router();

async function projectNames(): Promise<Map<string, string>> {
  const rows = await db.select({ id: projectsTable.id, name: projectsTable.name }).from(projectsTable);
  return new Map(rows.map((r) => [r.id, r.name]));
}

router.get("/v1/runs", async (_req, res) => {
  const [rows, names] = await Promise.all([
    db.select().from(runsTable).orderBy(desc(runsTable.createdAt)),
    projectNames(),
  ]);
  // materialize any active runs so the list reflects reality
  const out = [];
  for (const r of rows) {
    const fresh = ["queued", "validating", "running", "pause_pending"].includes(r.status)
      ? ((await materializeRun(r.id)) ?? r)
      : r;
    out.push(serializeRun(fresh, names.get(fresh.projectId) ?? null));
  }
  res.json(out);
});

router.post("/v1/runs", async (req, res) => {
  const parsed = LaunchRunBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
    return;
  }
  const d = parsed.data;
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, d.projectId));
  if (!project) {
    res.status(400).json({ error: "Unknown project" });
    return;
  }
  if (d.participants.length < 1) {
    res.status(400).json({ error: "At least one participant is required" });
    return;
  }
  const templateId = d.templateId || null; // treat "" as no template
  const idempotencyKey = d.idempotencyKey || null;
  if (idempotencyKey) {
    const [dup] = await db.select().from(runsTable).where(eq(runsTable.idempotencyKey, idempotencyKey));
    if (dup) {
      res.status(201).json(serializeRun(dup, project.name));
      return;
    }
  }
  const rounds = d.rounds ?? 2;
  const participants = d.participants.map((p) => ({
    agentId: p.agentId,
    roleType: p.roleType,
    title: p.title,
    shortLabel: p.shortLabel ?? null,
    provider: p.provider ?? "demo",
    model: p.model ?? "demo-research-v1",
    accentColor: p.accentColor ?? null,
  }));
  const { script, plannedCallCount } = buildScript({
    title: d.title,
    kind: d.kind,
    rounds,
    agendaObjective: d.agendaObjective ?? null,
    requiredQuestions: d.requiredQuestions ?? [],
    participants,
  });
  const [row] = await db
    .insert(runsTable)
    .values({
      projectId: d.projectId,
      templateId,
      title: d.title,
      kind: d.kind,
      status: "queued",
      agendaObjective: d.agendaObjective ?? null,
      requiredQuestions: d.requiredQuestions ?? [],
      rules: d.rules ?? [],
      rounds,
      participants,
      isSimulation: true,
      plannedCallCount,
      idempotencyKey,
      script,
    })
    .returning();
  req.log.info({ runId: row!.id, plannedCallCount }, "Demo run launched");
  res.status(201).json(serializeRun(row!, project.name));
});

router.get("/v1/runs/:runId", async (req, res) => {
  const run = await materializeRun(req.params.runId);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  const names = await projectNames();
  res.json(serializeRun(run, names.get(run.projectId) ?? null));
});

router.get("/v1/runs/:runId/events", async (req, res) => {
  const run = await materializeRun(req.params.runId);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  const events = await listEvents(req.params.runId);
  res.json(events.map(serializeRunEvent));
});

router.post("/v1/runs/:runId/control", async (req, res) => {
  const parsed = ControlRunBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
    return;
  }
  const run = await materializeRun(req.params.runId);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  const { action, instruction } = parsed.data;
  const active = ["queued", "validating", "running", "pause_pending"].includes(run.status);
  const now = new Date();

  if (action === "pause") {
    if (!active) {
      res.status(409).json({ error: `Cannot pause a run in status "${run.status}"` });
      return;
    }
    await db
      .update(runsTable)
      .set({ status: "paused", pausedAt: now, currentSpeaker: null })
      .where(eq(runsTable.id, run.id));
    await appendEvent(run.id, { type: "run.paused", payload: { by: "human" } });
  } else if (action === "resume") {
    if (run.status !== "paused") {
      res.status(409).json({ error: `Cannot resume a run in status "${run.status}"` });
      return;
    }
    const pausedMs = run.pausedAt ? now.getTime() - run.pausedAt.getTime() : 0;
    await db
      .update(runsTable)
      .set({ status: "running", pausedAt: null, pausedMsTotal: run.pausedMsTotal + pausedMs })
      .where(eq(runsTable.id, run.id));
    await appendEvent(run.id, { type: "run.resumed", payload: { by: "human" } });
  } else if (action === "cancel") {
    if (!active && run.status !== "paused") {
      res.status(409).json({ error: `Cannot cancel a run in status "${run.status}"` });
      return;
    }
    await db
      .update(runsTable)
      .set({ status: "cancelled", completedAt: now, currentSpeaker: null, pausedAt: null })
      .where(eq(runsTable.id, run.id));
    await appendEvent(run.id, { type: "run.cancelled", payload: { by: "human" } });
  } else if (action === "intervene") {
    if (!active && run.status !== "paused") {
      res.status(409).json({ error: `Cannot add an instruction to a run in status "${run.status}"` });
      return;
    }
    if (!instruction || instruction.trim().length === 0) {
      res.status(400).json({ error: "An instruction is required for intervene" });
      return;
    }
    await appendEvent(run.id, {
      type: "human.intervention_added",
      content: instruction.trim(),
      payload: { by: "human" },
    });
  }

  const [fresh] = await db.select().from(runsTable).where(eq(runsTable.id, run.id));
  const names = await projectNames();
  res.json(serializeRun(fresh!, names.get(fresh!.projectId) ?? null));
});

export default router;
