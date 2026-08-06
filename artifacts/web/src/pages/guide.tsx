import React from 'react';
import { Link } from 'wouter';
import {
  ArrowLeft,
  ArrowRight,
  Compass,
  FolderOpen,
  Users,
  Library,
  ClipboardList,
  Radio,
  FileCheck,
  Plug,
  ShieldCheck,
} from 'lucide-react';

type Chapter = {
  id: string;
  num: string;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
};

const CHAPTERS: Chapter[] = [
  { id: 'orientation', num: '01', title: 'Orientation', icon: Compass },
  { id: 'first-project', num: '02', title: 'Your first project', icon: FolderOpen },
  { id: 'agents', num: '03', title: 'Assemble the team', icon: Users },
  { id: 'evidence', num: '04', title: 'Ground it in evidence', icon: Library },
  { id: 'compose', num: '05', title: 'Compose a meeting', icon: ClipboardList },
  { id: 'live', num: '06', title: 'Run it live', icon: Radio },
  { id: 'results', num: '07', title: 'Results & exports', icon: FileCheck },
  { id: 'providers', num: '08', title: 'Connecting real AI', icon: Plug },
  { id: 'intended-use', num: '09', title: 'Using it as intended', icon: ShieldCheck },
];

function ChapterHeading({ chapter }: { chapter: Chapter }) {
  const Icon = chapter.icon;
  return (
    <div className="flex items-center gap-4 mb-6">
      <div className="h-11 w-11 rounded-xl bg-primary/15 border border-primary/25 flex items-center justify-center shrink-0">
        <Icon className="w-5 h-5 text-primary" />
      </div>
      <div>
        <div className="text-xs font-mono text-primary tracking-widest">CHAPTER {chapter.num}</div>
        <h2 className="text-2xl font-display font-semibold">{chapter.title}</h2>
      </div>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4">
      <div className="flex flex-col items-center">
        <div className="h-7 w-7 rounded-full bg-secondary/20 border border-secondary/40 text-secondary text-sm font-semibold flex items-center justify-center shrink-0">
          {n}
        </div>
        <div className="w-px flex-1 bg-border/60 mt-1" />
      </div>
      <div className="pb-6">
        <div className="font-medium text-foreground mb-1">{title}</div>
        <div className="text-sm text-muted-foreground leading-relaxed">{children}</div>
      </div>
    </div>
  );
}

function TryIt({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-2 mt-2 text-sm font-medium text-primary hover:underline"
    >
      {label} <ArrowRight className="w-4 h-4" />
    </Link>
  );
}

export default function Guide() {
  return (
    <div className="min-h-screen max-w-6xl mx-auto p-6 md:p-12">
      <Link
        href="/"
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-8"
      >
        <ArrowLeft className="w-4 h-4" /> Back
      </Link>

      {/* Hero */}
      <div className="mb-14">
        <div className="text-xs font-mono text-primary tracking-widest mb-3">FIELD MANUAL</div>
        <h1 className="text-4xl md:text-5xl font-display font-bold mb-4">
          The guided tour of Virtual Lab Studio
        </h1>
        <p className="text-lg text-muted-foreground max-w-2xl leading-relaxed">
          Nine short chapters, in the order a real study unfolds: set up a project, assemble an
          agent team, ground it in evidence, run a structured deliberation, and walk away with an
          auditable, reproducible record.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[240px_1fr] gap-10">
        {/* Chapter index */}
        <nav className="hidden lg:block">
          <div className="sticky top-8 vls-glass rounded-xl p-4 space-y-1">
            {CHAPTERS.map((c) => (
              <a
                key={c.id}
                href={`#${c.id}`}
                className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
              >
                <span className="font-mono text-xs text-primary/70">{c.num}</span>
                {c.title}
              </a>
            ))}
          </div>
        </nav>

        {/* Chapters */}
        <div className="space-y-16 min-w-0">
          {/* 01 Orientation */}
          <section id="orientation" className="scroll-mt-8">
            <ChapterHeading chapter={CHAPTERS[0]} />
            <div className="vls-reading-surface rounded-xl p-6 space-y-4">
              <p className="leading-relaxed">
                Virtual Lab Studio turns the{' '}
                <a
                  href="https://github.com/zou-group/virtual-lab"
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline font-medium"
                >
                  Virtual Lab
                </a>{' '}
                research pattern — a Lead Investigator, domain specialists, and a Scientific Critic
                debating in structured rounds — into a graphical instrument. You pose a research
                agenda; the team deliberates in front of you; you can pause, redirect, and resume;
                and every run ends in a structured record you can export and verify. A completed
                run carries the lead's synthesis; a run that fails, is cancelled, or hits its
                budget instead gets a terminal-outcome record that states plainly that no
                scientific conclusions were produced.
              </p>
              <div className="grid sm:grid-cols-3 gap-3 text-sm">
                <div className="bg-background/50 rounded-lg p-4">
                  <strong className="block text-foreground mb-1">Meetings, not chats</strong>
                  <span className="text-muted-foreground">
                    Fixed rounds, defined roles, a final synthesis. Every run has a beginning and an
                    end.
                  </span>
                </div>
                <div className="bg-background/50 rounded-lg p-4">
                  <strong className="block text-foreground mb-1">You stay in charge</strong>
                  <span className="text-muted-foreground">
                    Pause mid-deliberation, add instructions, resume. Interventions are recorded in
                    the transcript.
                  </span>
                </div>
                <div className="bg-background/50 rounded-lg p-4">
                  <strong className="block text-foreground mb-1">Auditable by design</strong>
                  <span className="text-muted-foreground">
                    Transcripts, citations, costs, and reproducibility manifests are first-class
                    outputs.
                  </span>
                </div>
              </div>
            </div>
          </section>

          {/* 02 First project */}
          <section id="first-project" className="scroll-mt-8">
            <ChapterHeading chapter={CHAPTERS[1]} />
            <div className="vls-reading-surface rounded-xl p-6">
              <Step n={1} title="Enter the workspace">
                Sign in from the landing page. You land on the Dashboard — your recent projects and
                runs at a glance.
              </Step>
              <Step n={2} title="Create a project">
                A project is the container for one line of inquiry: its meetings, evidence,
                comparisons, and exports live together. Go to <em>Projects → New Project</em>, give
                it a name and a one-line research goal.
              </Step>
              <Step n={3} title="Skim the seeded examples">
                The workspace ships with baseline agents and meeting templates so your first meeting
                takes minutes, not hours.
                <div>
                  <TryIt href="/app/projects/new" label="Create your first project" />
                </div>
              </Step>
            </div>
          </section>

          {/* 03 Agents */}
          <section id="agents" className="scroll-mt-8">
            <ChapterHeading chapter={CHAPTERS[2]} />
            <div className="vls-reading-surface rounded-xl p-6 space-y-4">
              <p className="text-sm text-muted-foreground leading-relaxed">
                Agents are role-conditioned model personas — a title, expertise, goals, and
                constraints. A good team mirrors a real research group:
              </p>
              <div className="grid sm:grid-cols-3 gap-3 text-sm">
                <div className="bg-background/50 rounded-lg p-4">
                  <strong className="block text-foreground mb-1">Lead Investigator</strong>
                  <span className="text-muted-foreground">
                    Frames each round, integrates the team's input, writes the final synthesis.
                  </span>
                </div>
                <div className="bg-background/50 rounded-lg p-4">
                  <strong className="block text-foreground mb-1">Specialists</strong>
                  <span className="text-muted-foreground">
                    Two to four domain experts chosen for the question — not more. Focus beats
                    headcount.
                  </span>
                </div>
                <div className="bg-background/50 rounded-lg p-4">
                  <strong className="block text-foreground mb-1">Scientific Critic</strong>
                  <span className="text-muted-foreground">
                    Challenges weak reasoning and unsupported claims every round. Never skip the
                    critic.
                  </span>
                </div>
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Browse the seeded roster in the Agent Studio, then clone and edit — sharpening an
                agent's expertise statement is the single highest-leverage edit you can make. When a
                meeting launches, agent definitions are <strong className="text-foreground">frozen
                into the run</strong>, so later edits never silently change past results.
              </p>
              <TryIt href="/app/agents" label="Open the Agent Studio" />
            </div>
          </section>

          {/* 04 Evidence */}
          <section id="evidence" className="scroll-mt-8">
            <ChapterHeading chapter={CHAPTERS[3]} />
            <div className="vls-reading-surface rounded-xl p-6">
              <Step n={1} title="Add sources to the Evidence Library">
                Upload papers, notes, and datasets. Each source gets a stable identity and a
                SHA-256 checksum, so you can confirm a cited source is byte-for-byte the one that
                was attached.
              </Step>
              <Step n={2} title="Attach evidence when composing a meeting">
                Selected sources are frozen into the meeting definition at launch — the run's
                evidence set can never drift afterwards.
              </Step>
              <Step n={3} title="Read citations in the synthesis">
                Each citation in the synthesis names an evidence ID and the support type the agent
                claimed. Validation checks whether that ID was frozen into this meeting: a citation
                is marked <strong className="text-foreground">validated</strong> when it resolves to
                attached evidence, and flagged when it points to a library item that was not
                attached or to an ID that does not exist. Validation confirms the reference, not
                that the cited passage actually supports the claim — that judgment is yours.
                <div>
                  <TryIt href="/app/evidence" label="Open the Evidence Library" />
                </div>
              </Step>
            </div>
          </section>

          {/* 05 Compose */}
          <section id="compose" className="scroll-mt-8">
            <ChapterHeading chapter={CHAPTERS[4]} />
            <div className="vls-reading-surface rounded-xl p-6">
              <Step n={1} title="Choose the meeting shape">
                <strong className="text-foreground">Team Council</strong> — lead plus specialists
                debate in rounds; with M members and R rounds the run makes R×(M+1)+1 model calls.{' '}
                <strong className="text-foreground">Expert &amp; Critic</strong> — one expert and a
                critic alternate; 2R+1 calls. Start with 2 rounds; add more only when the agenda
                genuinely needs them.
              </Step>
              <Step n={2} title="Write the agenda, questions, and rules">
                The agenda is the meeting's north star. Required questions force the team to answer
                what you actually need; rules constrain style and scope.
              </Step>
              <Step n={3} title="Pick the roster and evidence">
                Designate the lead, add specialists, attach evidence sources. Templates prefill all
                of this for common study shapes.
              </Step>
              <Step n={4} title="Set the budget">
                Cap provider calls and cost per run. The engine validates the whole definition
                before launch and stops the meeting if a budget would be exceeded.
                <div>
                  <TryIt href="/app/meetings/new" label="Compose a meeting" />
                </div>
              </Step>
            </div>
          </section>

          {/* 06 Live */}
          <section id="live" className="scroll-mt-8">
            <ChapterHeading chapter={CHAPTERS[5]} />
            <div className="vls-reading-surface rounded-xl p-6">
              <Step n={1} title="Watch the deliberation stream">
                The Live Meeting Room streams each turn as it happens — who is speaking, which
                round you're in, calls and cost so far.
              </Step>
              <Step n={2} title="Pause when the discussion drifts">
                Hit pause at any point. The run freezes mid-deliberation and waits for you.
              </Step>
              <Step n={3} title="Intervene with an instruction">
                Add guidance — "prioritize cost analysis", "drop approach B" — and it's injected
                into the meeting <em>and</em> recorded as a human intervention in the permanent
                transcript.
              </Step>
              <Step n={4} title="Resume, or stop early">
                Resume to continue from exactly where the team paused. A run you let finish ends
                with the lead's structured synthesis; one you stop early is recorded with a
                terminal-outcome summary instead.
                <div>
                  <TryIt href="/app/runs" label="See your runs" />
                </div>
              </Step>
            </div>
          </section>

          {/* 07 Results */}
          <section id="results" className="scroll-mt-8">
            <ChapterHeading chapter={CHAPTERS[6]} />
            <div className="vls-reading-surface rounded-xl p-6 space-y-4">
              <p className="text-sm text-muted-foreground leading-relaxed">
                A finished run is a durable, hash-verified record:
              </p>
              <div className="grid sm:grid-cols-2 gap-3 text-sm">
                <div className="bg-background/50 rounded-lg p-4">
                  <strong className="block text-foreground mb-1">Transcript & synthesis</strong>
                  <span className="text-muted-foreground">
                    Every turn, every intervention, and the final structured summary. The manifest
                    records SHA-256 hashes over the ordered transcript and the summary, so you can
                    detect if either was altered after the run.
                  </span>
                </div>
                <div className="bg-background/50 rounded-lg p-4">
                  <strong className="block text-foreground mb-1">Reproducibility packet</strong>
                  <span className="text-muted-foreground">
                    Export the frozen definition — agents, evidence, settings, and SHA-256 content
                    hashes — so a reviewer can inspect exactly what was configured. The hashes let
                    you verify the packet's contents; they are content checksums, not a
                    cryptographic signature.
                  </span>
                </div>
                <div className="bg-background/50 rounded-lg p-4">
                  <strong className="block text-foreground mb-1">Blinded comparisons</strong>
                  <span className="text-muted-foreground">
                    Put several runs side by side with identities hidden; the labels reveal only
                    after you submit your evaluation, so scoring stays honest.
                  </span>
                </div>
                <div className="bg-background/50 rounded-lg p-4">
                  <strong className="block text-foreground mb-1">Cost accounting</strong>
                  <span className="text-muted-foreground">
                    Tokens, calls, and dollar cost per run — visible live and in the record.
                  </span>
                </div>
              </div>
            </div>
          </section>

          {/* 08 Providers */}
          <section id="providers" className="scroll-mt-8">
            <ChapterHeading chapter={CHAPTERS[7]} />
            <div className="vls-glass border-warning/20 rounded-xl p-6 space-y-4">
              <p className="leading-relaxed">
                Every meeting runs through a <strong>provider</strong> — the engine that powers the
                agents. The built-in <strong className="text-foreground">Demo Provider</strong> is
                a deterministic, zero-cost simulation for learning the platform with no API keys.
                Real model providers — OpenAI and any OpenAI-compatible endpoint — run genuine
                deliberations with real models, real token accounting, and real dollar costs.
              </p>
              <div className="space-y-2 text-sm text-muted-foreground">
                <div className="flex gap-3">
                  <span className="font-mono text-primary shrink-0">1.</span>
                  <span>
                    Open <em>Settings → Providers &amp; Models</em> and add a provider with your
                    own API key (OpenAI, or a custom base URL for any OpenAI-compatible endpoint).
                    Keys are write-only: sent once on save, encrypted server-side, and never
                    returned to the browser. Use <em>Test</em> to verify the connection before
                    running anything.
                  </span>
                </div>
                <div className="flex gap-3">
                  <span className="font-mono text-primary shrink-0">2.</span>
                  <span>
                    Register the models you want under the provider, with their per-million-token
                    pricing. Pricing drives the composer's pre-launch cost estimate; models without
                    complete pricing are estimated honestly as incomplete rather than pretending
                    they're free.
                  </span>
                </div>
                <div className="flex gap-3">
                  <span className="font-mono text-primary shrink-0">3.</span>
                  <span>
                    In the meeting composer, pick the provider and model under{' '}
                    <em>Advanced Controls</em>. Validation shows the expected call count and a real
                    cost estimate before you launch.
                  </span>
                </div>
                <div className="flex gap-3">
                  <span className="font-mono text-primary shrink-0">4.</span>
                  <span>
                    Budgets do the guarding: per-run call caps and cost ceilings are enforced at
                    every checkpoint, and a run that would exceed them is stopped with its partial
                    record intact.
                  </span>
                </div>
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed">
                <strong className="text-foreground">Replit AI (no key)</strong> is a special
                zero-key option that routes through the workspace's Replit AI integration. Because
                usage is billed to the workspace owner's Replit account, it is restricted to an
                explicit allowlist of accounts (set by the operator via the{' '}
                <code className="text-foreground">REPLIT_AI_ALLOWED_EMAILS</code> environment
                variable). If your account isn't allowlisted, the option simply isn't available —
                add your own API key instead.
              </p>
              <p className="text-sm text-muted-foreground leading-relaxed">
                <strong className="text-foreground">Labeling never lies.</strong> Only demo runs
                carry the <em>Simulation</em> label. Real runs are never labeled as simulation —
                their syntheses are genuine model output and instead carry the human-review
                disclosure: results may contain errors and require qualified review before any
                external use.
              </p>
              <TryIt href="/app/settings/providers" label="Open provider settings" />
            </div>
          </section>

          {/* 09 Intended use */}
          <section id="intended-use" className="scroll-mt-8">
            <ChapterHeading chapter={CHAPTERS[8]} />
            <div className="vls-reading-surface rounded-xl p-6 space-y-4">
              <p className="leading-relaxed font-medium">
                The platform is an ideation and planning instrument — it accelerates the thinking
                around research; it does not replace it.
              </p>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li className="flex gap-3">
                  <span className="text-primary shrink-0">•</span>
                  Agent agreement is not independent validation — all roles share one transcript and
                  one underlying model. The Critic reduces, but does not eliminate, this limit.
                </li>
                <li className="flex gap-3">
                  <span className="text-primary shrink-0">•</span>
                  Treat qualified human review as a prerequisite before any external use. The
                  system does not block export or download of unreviewed output — that discipline
                  is yours to keep. Interventions and reviews exist so that review, when done,
                  becomes part of the record.
                </li>
                <li className="flex gap-3">
                  <span className="text-primary shrink-0">•</span>
                  No clinical claims, no autonomous lab control, no presenting AI personas as real
                  credentialed experts.
                </li>
                <li className="flex gap-3">
                  <span className="text-primary shrink-0">•</span>
                  Reproducibility is the point: prefer frozen definitions, exported manifests, and
                  blinded comparisons over ad-hoc reruns.
                </li>
              </ul>
              <div className="flex flex-wrap gap-4 pt-2">
                <Link
                  href="/methodology"
                  className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline"
                >
                  Read the full methodology <ArrowRight className="w-4 h-4" />
                </Link>
                <Link
                  href="/app"
                  className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline"
                >
                  Enter the workspace <ArrowRight className="w-4 h-4" />
                </Link>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
