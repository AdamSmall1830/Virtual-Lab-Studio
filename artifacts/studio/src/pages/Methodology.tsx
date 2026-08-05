import React from 'react';
import { Link } from 'wouter';
import { GlassPanel } from '@/components/ui/glass-panel';
import { ArrowLeft, Calculator, BookOpen, AlertTriangle } from 'lucide-react';

export default function Methodology() {
  return (
    <div className="min-h-screen bg-background text-foreground vls-app-background flex flex-col font-sans">
      <header className="px-6 py-6 z-10 max-w-4xl mx-auto w-full flex justify-between items-center">
        <Link href="/" className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="w-4 h-4" /> Back to Home
        </Link>
        <Link href="/app" className="text-sm font-medium text-primary hover:underline">
          Go to Workspace
        </Link>
      </header>

      <main className="flex-1 z-10 max-w-4xl mx-auto w-full px-6 py-8 pb-24">
        <h1 className="text-4xl font-display font-bold tracking-tight mb-4">Methodology</h1>
        <p className="text-lg text-muted-foreground mb-12">
          Understanding how Virtual Lab models deliberate, compute call counts, and synthesize findings.
        </p>

        <div className="space-y-12">
          <section>
            <h2 className="text-2xl font-display font-semibold mb-6 flex items-center gap-2">
              <BookOpen className="w-5 h-5 text-primary" />
              The Meeting Method
            </h2>
            <div className="prose prose-invert max-w-none text-muted-foreground prose-p:leading-relaxed">
              <p>
                Virtual Lab Studio implements the core engine of the <em>Virtual Lab</em> system, where research deliberation is modeled as a structured multi-round meeting. Instead of creating autonomous software agents that run indefinitely, the system defines <strong>roles</strong> (Lead, Specialist, Critic) that are invoked in a deterministic sequence.
              </p>
              <p>
                These model-driven roles share a single transcript. They are not independent persistent entities; they are role-conditioned prompt executions that observe the growing context window and add their designated contribution. This ensures the reasoning trace is perfectly linear, fully reproducible, and bounded.
              </p>
            </div>
          </section>

          <section>
            <h2 className="text-2xl font-display font-semibold mb-6 flex items-center gap-2">
              <Calculator className="w-5 h-5 text-secondary" />
              Call Count Formulas
            </h2>
            <div className="grid md:grid-cols-2 gap-6">
              <GlassPanel className="p-6">
                <h3 className="font-semibold mb-2 text-foreground">Team Meeting</h3>
                <p className="text-sm text-muted-foreground mb-4">A sequential discussion among M members, repeating for R rounds, followed by one synthesis step.</p>
                <div className="bg-background/50 p-4 rounded-lg font-mono text-sm border border-border/50">
                  <div className="text-primary font-bold text-lg mb-2">Calls = R × (M + 1) + 1</div>
                  <ul className="space-y-1 text-muted-foreground">
                    <li>R = Number of Rounds</li>
                    <li>M = Number of Specialists</li>
                    <li>+1 = The Lead speaks each round</li>
                    <li>+1 = Final Merge/Synthesis</li>
                  </ul>
                </div>
              </GlassPanel>

              <GlassPanel className="p-6">
                <h3 className="font-semibold mb-2 text-foreground">Expert–Critic Meeting</h3>
                <p className="text-sm text-muted-foreground mb-4">A paired dialogue where an Expert proposes and a Critic reviews, followed by a final synthesis.</p>
                <div className="bg-background/50 p-4 rounded-lg font-mono text-sm border border-border/50">
                  <div className="text-secondary font-bold text-lg mb-2">Calls = 2 × R + 1</div>
                  <ul className="space-y-1 text-muted-foreground">
                    <li>R = Number of Rounds</li>
                    <li>2 = Expert + Critic</li>
                    <li>+1 = Final Merge/Synthesis</li>
                  </ul>
                </div>
              </GlassPanel>
            </div>
          </section>

          <section>
            <h2 className="text-2xl font-display font-semibold mb-6 flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-warning" />
              Limitations & Best Practices
            </h2>
            <GlassPanel className="p-6 border-warning/20">
              <ul className="space-y-4 text-sm text-muted-foreground list-disc pl-5">
                <li><strong className="text-foreground">Context Window Limits:</strong> Long meetings with many participants will rapidly consume context windows. Set required questions and keep rounds limited (2-3 is optimal).</li>
                <li><strong className="text-foreground">Hallucination:</strong> Models can confidently agree on incorrect information. The Critic role helps mitigate this, but human verification remains strictly necessary.</li>
                <li><strong className="text-foreground">Statelessness:</strong> Outside of the shared transcript, models do not retain memory of the meeting. They cannot "think offline" while another model speaks.</li>
                <li><strong className="text-foreground">Determinism:</strong> Setting temperature &gt; 0 means repeated identical meetings may diverge. Use temperature 0 for strictly reproducible (though potentially less creative) outputs.</li>
              </ul>
            </GlassPanel>
          </section>
        </div>
      </main>
    </div>
  );
}
