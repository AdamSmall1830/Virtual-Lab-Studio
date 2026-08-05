import React from 'react';
import { Link } from 'wouter';
import { Bot, Users, Workflow, ArrowRight, Activity, ShieldCheck, Microscope } from 'lucide-react';
import { GlassPanel } from '@/components/ui/glass-panel';

export default function Home() {
  return (
    <div className="min-h-screen bg-background text-foreground vls-app-background flex flex-col font-sans">
      <header className="px-6 py-6 flex items-center justify-between z-10">
        <div className="flex items-center gap-2 text-primary font-display font-bold text-xl">
          <div className="w-8 h-8 rounded bg-primary/20 flex items-center justify-center border border-primary/30">
            <Bot className="w-5 h-5 text-primary" />
          </div>
          Virtual Lab Studio
        </div>
        <div className="flex gap-6 items-center">
          <Link href="/methodology" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors hidden sm:block">Methodology</Link>
          <Link href="/app" className="text-sm font-medium px-4 py-2 bg-primary/10 text-primary border border-primary/20 rounded-md hover:bg-primary hover:text-primary-foreground transition-colors">
            Enter Workspace
          </Link>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center px-4 z-10 text-center relative max-w-5xl mx-auto py-20">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full vls-glass text-xs font-medium text-primary mb-8 border-primary/20">
          <Activity className="w-3 h-3" /> Based on Nature 2025: The Virtual Lab of AI agents
        </div>
        
        <h1 className="text-5xl md:text-7xl font-display font-extrabold tracking-tight mb-6 leading-tight text-transparent bg-clip-text bg-gradient-to-br from-foreground to-foreground/60">
          Human-guided research,<br />powered by model ensembles.
        </h1>
        
        <p className="text-lg md:text-xl text-muted-foreground max-w-3xl mb-10 font-sans leading-relaxed">
          Assemble a team of model-driven research roles—specialists, leads, and scientific critics. Pose a research agenda, and watch a structured multi-round deliberation unfold live, ending in an evidence-linked structured synthesis.
        </p>
        
        <div className="flex flex-col sm:flex-row gap-4 justify-center mb-24 w-full sm:w-auto">
          <Link href="/app/meetings/new" className="px-8 py-4 bg-primary text-primary-foreground rounded-lg font-medium text-lg hover:bg-primary/90 transition-all shadow-lg hover:shadow-primary/25 flex items-center justify-center gap-2">
            Start a Meeting <ArrowRight className="w-5 h-5" />
          </Link>
          <Link href="/methodology" className="px-8 py-4 vls-glass rounded-lg font-medium text-lg hover:bg-muted/50 transition-all flex items-center justify-center gap-2 border-border/50">
            Read the Methodology
          </Link>
        </div>

        <div className="grid md:grid-cols-3 gap-6 text-left w-full">
          <GlassPanel className="p-6 flex flex-col gap-4">
            <div className="w-12 h-12 rounded-lg bg-secondary/10 flex items-center justify-center border border-secondary/20 text-secondary">
              <Users className="w-6 h-6" />
            </div>
            <h3 className="text-xl font-bold font-display">Structured Teams</h3>
            <p className="text-muted-foreground leading-relaxed text-sm">Assign specific expertise, goals, and roles to different models. The structured speaking order ensures systematic critique and synthesis.</p>
          </GlassPanel>
          <GlassPanel className="p-6 flex flex-col gap-4">
            <div className="w-12 h-12 rounded-lg bg-accent/10 flex items-center justify-center border border-accent/20 text-accent">
              <Workflow className="w-6 h-6" />
            </div>
            <h3 className="text-xl font-bold font-display">Live Transparency</h3>
            <p className="text-muted-foreground leading-relaxed text-sm">Watch the deliberation token-by-token. Pause, intervene, inject context, or redirect the conversation as it happens.</p>
          </GlassPanel>
          <GlassPanel className="p-6 flex flex-col gap-4">
            <div className="w-12 h-12 rounded-lg bg-info/10 flex items-center justify-center border border-info/20 text-info">
              <Microscope className="w-6 h-6" />
            </div>
            <h3 className="text-xl font-bold font-display">Reproducible Findings</h3>
            <p className="text-muted-foreground leading-relaxed text-sm">Every turn, summary, and hypothesis is logged. The resulting artifact includes dissenting views and rationale for confidence.</p>
          </GlassPanel>
        </div>
      </main>

      <footer className="border-t border-border/40 vls-glass mt-auto py-8 px-6 text-center text-sm text-muted-foreground relative z-10 flex flex-col gap-4">
        <div className="max-w-4xl mx-auto flex items-start gap-3 bg-warning/5 border border-warning/20 p-4 rounded-lg text-left">
          <ShieldCheck className="w-5 h-5 text-warning shrink-0 mt-0.5" />
          <p className="leading-relaxed">
            <strong className="text-warning-foreground font-semibold">Disclosure:</strong> Virtual Lab Studio supports human-guided research deliberation. Its agents are model-driven roles, not independent human experts. Outputs may contain errors and do not replace experimental validation, peer review, ethics review, clinical judgment, or other qualified professional oversight.
          </p>
        </div>
        <p className="mt-4">
          Upstream engine based on <a href="https://github.com/zou-group/virtual-lab" target="_blank" rel="noreferrer" className="text-primary hover:underline">zou-group/virtual-lab</a> (MIT). Reference: <em>The Virtual Lab of AI agents designs new SARS-CoV-2 nanobodies</em> (Nature, 2025).
        </p>
      </footer>
    </div>
  );
}
