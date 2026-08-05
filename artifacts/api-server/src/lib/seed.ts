import { db, agentsTable, templatesTable, projectsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

function loadSpecJson(name: string): unknown {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, "specs", name);
    if (existsSync(candidate)) return JSON.parse(readFileSync(candidate, "utf-8"));
    dir = path.dirname(dir);
  }
  throw new Error(`Could not locate specs/${name} from ${process.cwd()}`);
}

const seedAgentsJson = loadSpecJson("seed_agents.json");
const seedTemplatesJson = loadSpecJson("seed_meeting_templates.json");

interface SeedAgent {
  slug: string;
  title: string;
  accent?: string;
  expertise: string;
  goal: string;
  role: string;
  default_role_type?: string;
  behavioral_rules?: string[];
  recommended_temperature?: number;
}

interface SeedTemplate {
  slug: string;
  name: string;
  category: string;
  description: string;
  meeting_type: string;
  suggested_agents?: { agent_slug: string; role_type: string; required?: boolean }[];
  default_rounds?: number;
  agenda_template?: string;
  questions?: string[];
  rules?: string[];
  intended_output?: string;
}

const ACCENT_HEX: Record<string, string> = {
  cyan: "#22d3ee",
  blue: "#60a5fa",
  violet: "#a78bfa",
  purple: "#a78bfa",
  mint: "#34d399",
  green: "#34d399",
  amber: "#fbbf24",
  orange: "#fb923c",
  rose: "#fb7185",
  red: "#f87171",
  teal: "#2dd4bf",
  indigo: "#818cf8",
  pink: "#f472b6",
  slate: "#94a3b8",
};

export async function seedDatabase(): Promise<void> {
  const agents = (seedAgentsJson as { agents: SeedAgent[] }).agents;
  for (const a of agents) {
    const [existing] = await db.select().from(agentsTable).where(eq(agentsTable.slug, a.slug));
    if (existing) continue;
    await db.insert(agentsTable).values({
      slug: a.slug,
      title: a.title,
      shortLabel: a.title
        .split(/\s+/)
        .map((w) => w[0])
        .join("")
        .slice(0, 3)
        .toUpperCase(),
      expertise: a.expertise,
      goal: a.goal,
      role: a.role,
      advancedInstructions: a.behavioral_rules?.join("\n") ?? null,
      provider: "demo",
      model: "demo-research-v1",
      temperature: a.recommended_temperature ?? 0.2,
      accentColor: ACCENT_HEX[a.accent ?? ""] ?? "#60a5fa",
      isSystem: true,
    });
  }

  const templates = (seedTemplatesJson as { templates: SeedTemplate[] }).templates;
  const CATEGORY_MAP: Record<string, string> = {
    "research planning": "ideation",
    "literature": "literature",
    "literature review": "literature",
    "ideation": "ideation",
    "methods": "methods",
    "experimental design": "methods",
    "statistics": "statistics",
    "statistical review": "statistics",
    "computational": "computational",
    "code review": "computational",
    "peer review": "peer_review",
    "manuscript review": "peer_review",
    "ethics": "ethics_governance",
    "ethics and governance": "ethics_governance",
    "governance": "ethics_governance",
    "grants": "grants",
    "grant strategy": "grants",
  };
  for (const t of templates) {
    const [existing] = await db.select().from(templatesTable).where(eq(templatesTable.slug, t.slug));
    if (existing) continue;
    await db.insert(templatesTable).values({
      slug: t.slug,
      name: t.name,
      kind: t.meeting_type === "individual" ? "individual" : t.meeting_type === "ensemble_merge" ? "ensemble_merge" : "team",
      category: CATEGORY_MAP[t.category.toLowerCase()] ?? t.category.toLowerCase().replace(/\s+/g, "_"),
      description: t.description,
      objective: t.agenda_template ?? null,
      requiredQuestions: t.questions ?? [],
      rules: t.rules ?? [],
      suggestedAgentSlugs: (t.suggested_agents ?? []).map((s) => s.agent_slug),
      defaultRounds: t.default_rounds ?? 2,
      intendedOutput: t.intended_output ?? null,
    });
  }

  // Seeded neutral demonstration project
  const demoName = "Biodegradable Packaging Film Optimization";
  const [existingProject] = await db.select().from(projectsTable).where(eq(projectsTable.name, demoName));
  if (!existingProject) {
    await db.insert(projectsTable).values({
      name: demoName,
      abstract:
        "A demonstration project exploring how to improve the mechanical strength and shelf stability of a starch-based biodegradable packaging film without compromising compostability. All contents are locally generated sample material for demonstration.",
      domain: "Materials science",
      tags: ["demo", "materials", "sustainability"],
      status: "active",
      researchQuestion:
        "Which formulation and processing changes most improve tensile strength and moisture resistance of a starch-based film while retaining industrial compostability?",
      hypotheses: [
        "Crosslinking with citric acid improves tensile strength without loss of compostability.",
        "A thin bio-based coating reduces water vapor transmission more cost-effectively than bulk formulation changes.",
      ],
      objectives: [
        "Rank candidate formulation changes by expected impact and experimental cost.",
        "Design a pilot experiment isolating the highest-impact variable.",
      ],
      constraints: [
        "Only food-contact-safe additives may be considered.",
        "Processing must remain compatible with existing extrusion equipment.",
      ],
      ethicsNotes: "No human or animal subjects. Environmental claims must be evidence-qualified.",
      disclosureNotes: "Demonstration project with locally generated sample content; no external funding.",
      humanDecision: "Whether to commit pilot-line time to a revised formulation next quarter.",
    });
  }

  logger.info("Seed check complete (idempotent by slug/name)");
}
