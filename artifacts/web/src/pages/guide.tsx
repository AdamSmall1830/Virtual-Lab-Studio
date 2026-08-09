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
  Cpu,
  UserPlus,
  FileLock2,
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
  { id: 'recursive', num: '09', title: 'Delegating to your own machine', icon: Cpu },
  { id: 'team', num: '10', title: 'Working as a team', icon: UserPlus },
  { id: 'pre-registration', num: '11', title: 'Committing to the question', icon: FileLock2 },
  { id: 'intended-use', num: '12', title: 'Using it as intended', icon: ShieldCheck },
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
          Twelve short chapters, in the order a real study unfolds: set up a project, assemble an
          agent team, ground it in evidence, run a structured deliberation, work as a team, and
          walk away with an auditable, reproducible record.
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
          {/* 09 Recursive execution on your own machine */}
          <section id="recursive" className="scroll-mt-8">
            <ChapterHeading chapter={CHAPTERS[8]} />
            <div className="vls-reading-surface rounded-xl p-6 space-y-4">
              <p className="leading-relaxed">
                Some questions deserve a participant that can work at them for a while — think for
                several turns, split the question into parts, and hand those parts to child agents.
                That is a <strong className="text-foreground">recursive participant</strong>, and
                Virtual Lab Studio does not run one here. It runs on{' '}
                <strong className="text-foreground">your machine</strong>: your GPU, your local
                models, your electricity.
              </p>
              <p className="text-sm text-muted-foreground leading-relaxed">
                The reason is plain. An agent that plans its own sub-tasks is agent-generated code
                in all but name, and the studio will not run that on shared infrastructure. So the
                studio queues the turn and waits. A small program called the{' '}
                <strong className="text-foreground">bridge worker</strong>, running on your
                hardware, reaches out, collects the turn, does the work, and posts back the answer.
                Nothing listens on your machine and nothing dials into your network.
              </p>

              <div className="grid sm:grid-cols-2 gap-3 text-sm">
                <div className="bg-background/50 rounded-lg p-4">
                  <strong className="block text-foreground mb-1">What you need</strong>
                  <span className="text-muted-foreground">
                    A machine with a reasonable GPU, a local model server such as Ollama or LM
                    Studio, Docker, and Node. A 24 GB card runs a 32B model comfortably; smaller
                    cards simply think more slowly.
                  </span>
                </div>
                <div className="bg-background/50 rounded-lg p-4">
                  <strong className="block text-foreground mb-1">Setting it up</strong>
                  <span className="text-muted-foreground">
                    Enrol the worker from <strong className="text-foreground">Settings</strong>,
                    paste the enrollment token into its config, and start it. It appears as{' '}
                    <em>online</em> with the models it can actually serve.
                  </span>
                </div>
                <div className="bg-background/50 rounded-lg p-4">
                  <strong className="block text-foreground mb-1">Using it in a meeting</strong>
                  <span className="text-muted-foreground">
                    In the composer's advanced controls, mark a seat as recursive and set its
                    ceilings — children, depth, turns, tokens, cost, runtime. The meeting pauses at
                    that seat, waits for your worker, then carries on with the rest of the team.
                  </span>
                </div>
                <div className="bg-background/50 rounded-lg p-4">
                  <strong className="block text-foreground mb-1">Watching it work</strong>
                  <span className="text-muted-foreground">
                    The live room shows the delegated turn as a tree — the coordinator, its
                    children, and what each was asked. Every event is timestamped in the same
                    stream as the rest of the meeting.
                  </span>
                </div>
              </div>

              <div className="rounded-lg border border-warning/25 bg-warning/5 p-4 space-y-2">
                <div className="text-sm font-medium text-foreground">
                  What the record can and cannot claim
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  Work done on your machine is work this deployment did not observe. It records
                  what your worker reported — the shape of the tree, the limits in force, the
                  tokens and cost claimed, hashes of the request and the answer — and it says on
                  the page that this is the operator's account rather than an independent
                  measurement. Every export carries the recursive files whether or not you used
                  the feature, so a meeting with no delegation states that plainly instead of
                  leaving a gap. The typeset report has a{' '}
                  <strong className="text-foreground">Recursive execution</strong> appendix you can
                  switch on when you need the detail in print.
                </p>
              </div>

              <p className="text-sm text-muted-foreground leading-relaxed">
                The feature is off unless an administrator has enabled it for this deployment. If
                you do not see it, that is why.
              </p>
              <TryIt href="/settings" label="Open Settings" />
            </div>
          </section>

          {/* 10 Team */}
          <section id="team" className="scroll-mt-8">
            <ChapterHeading chapter={CHAPTERS[9]} />
            <div className="vls-reading-surface rounded-xl p-6 space-y-4">
              <p className="leading-relaxed">
                A workspace can hold a whole group — co-authors, a supervisor, a reviewer who
                only reads. Invite people from{' '}
                <span className="font-medium text-foreground">Settings &rarr; Team</span> by email
                address. The invitation is bound to that address and carries the role it will
                grant, so the link is not a skeleton key: signing in as anyone else will not
                redeem it.
              </p>
              <p className="leading-relaxed">
                You will see the invite link exactly once, at the moment you create it. Only a
                fingerprint of it is kept, so nobody — including you — can retrieve it
                afterwards. Send it, and if it goes astray, revoke it and issue another.
              </p>
              <h3 className="font-semibold pt-2">Who can do what</h3>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li className="flex gap-3"><span className="text-primary shrink-0">&bull;</span>
                  <span><span className="text-foreground font-medium">Viewer</span> reads runs and results.</span></li>
                <li className="flex gap-3"><span className="text-primary shrink-0">&bull;</span>
                  <span><span className="text-foreground font-medium">Reviewer</span> also signs off on them — the human review that turns a draft into a record.</span></li>
                <li className="flex gap-3"><span className="text-primary shrink-0">&bull;</span>
                  <span><span className="text-foreground font-medium">Researcher</span> designs and launches meetings.</span></li>
                <li className="flex gap-3"><span className="text-primary shrink-0">&bull;</span>
                  <span><span className="text-foreground font-medium">Admin</span> manages the workspace and its people.</span></li>
                <li className="flex gap-3"><span className="text-primary shrink-0">&bull;</span>
                  <span><span className="text-foreground font-medium">Owner</span> holds the workspace, including what it spends.</span></li>
              </ul>
              <h3 className="font-semibold pt-2">Whose money is it</h3>
              <p className="leading-relaxed">
                Model calls cost real money, so the platform never leaves that ambiguous. A{' '}
                <span className="font-medium text-foreground">workspace</span> key is funded by
                the owner and usable by everyone. A{' '}
                <span className="font-medium text-foreground">personal</span> key belongs to one
                person: nobody else can read it or spend against it, and what it costs is
                between them and their provider.
              </p>
              <p className="leading-relaxed">
                Against workspace money the owner can set a monthly cap per member. It is checked
                when a run is launched, against that run's estimated cost — a launch that would
                take you past your cap is refused rather than quietly started and abandoned
                halfway. Spending on your own personal key never counts against it.
              </p>
              <p className="text-sm text-muted-foreground leading-relaxed">
                One honest caveat: a personal key is confidential, not secret. The audit log
                records that you added one, and a run that used it can be traced to it. Money
                spent outside the workspace's control is precisely what a governance record
                ought to show.
              </p>
              <TryIt href="/app/settings/team" label="Open Team settings" />
            </div>
          </section>

          {/* 11 Pre-registration */}
          <section id="pre-registration" className="scroll-mt-8">
            <ChapterHeading chapter={CHAPTERS[10]} />
            <div className="vls-reading-surface rounded-xl p-6 space-y-4">
              <p className="leading-relaxed font-medium">
                Pre-registration is writing down what you expect to find, before you find it.
              </p>
              <p className="leading-relaxed">
                It is the cheapest defence there is against fooling yourself. Agents are fluent
                and agreeable; it is remarkably easy to run a meeting, read a persuasive answer,
                and decide in hindsight that it was the question you meant to ask all along. A
                pre-registration removes that option by fixing the hypothesis, the protocol and
                the analysis plan in advance.
              </p>
              <h3 className="font-semibold pt-2">How it works here</h3>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li className="flex gap-3"><span className="text-primary shrink-0">&bull;</span>
                  Write it on the project's Pre-registration tab. While it is a draft, edit it freely.</li>
                <li className="flex gap-3"><span className="text-primary shrink-0">&bull;</span>
                  Registering it takes a fingerprint of the text and freezes it. Registered documents are never edited.</li>
                <li className="flex gap-3"><span className="text-primary shrink-0">&bull;</span>
                  Changed your mind? Register an <span className="text-foreground font-medium">amendment</span>: a new version that supersedes the old one and has to say why. The earlier version stays visible — the chain of amendments is the evidence, not an embarrassment to be hidden.</li>
                <li className="flex gap-3"><span className="text-primary shrink-0">&bull;</span>
                  Every run records which document and which exact text it launched under, and the exported manifest reports it — including whether that document has been amended since.</li>
              </ul>
              <h3 className="font-semibold pt-2">Making it binding</h3>
              <p className="leading-relaxed">
                A project can be switched to{' '}
                <span className="font-medium text-foreground">require</span> pre-registration.
                After that, no run launches without an active registered document — the platform
                refuses, rather than trusting everyone to remember. Turn the requirement on
                before you have registered anything and runs are blocked from that moment; the
                page tells you so at the time rather than letting you discover it at launch.
              </p>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Worth being clear about what this proves. It proves what you committed to and
                when, and that the text has not changed since. It does not make a claim true, and
                it is not a registry entry with an outside body — if your field expects one of
                those, this complements it rather than replacing it.
              </p>
              <TryIt href="/app/projects" label="Open a project" />
            </div>
          </section>

          {/* 12 Intended use */}
          <section id="intended-use" className="scroll-mt-8">
            <ChapterHeading chapter={CHAPTERS[11]} />
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
