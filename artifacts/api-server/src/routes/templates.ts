import { Router, type IRouter } from "express";
import { db, templatesTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { serializeTemplate } from "../lib/serialize";

const router: IRouter = Router();

router.get("/v1/templates", async (_req, res) => {
  const rows = await db.select().from(templatesTable).orderBy(asc(templatesTable.name));
  res.json(rows.map(serializeTemplate));
});

router.get("/v1/templates/:templateId", async (req, res) => {
  const [row] = await db
    .select()
    .from(templatesTable)
    .where(eq(templatesTable.id, req.params.templateId));
  if (!row) {
    res.status(404).json({ error: "Template not found" });
    return;
  }
  res.json(serializeTemplate(row));
});

export default router;
