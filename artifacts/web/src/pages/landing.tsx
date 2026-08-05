import React from 'react';
import { Link } from 'wouter';
import { FlaskConical, ChevronRight, Activity, GitMerge, FileText, Database } from 'lucide-react';
import { motion } from 'framer-motion';

export default function Landing() {
  return (
    <div className="min-h-screen flex flex-col relative overflow-hidden">
      <div className="absolute inset-0 z-0 bg-[radial-gradient(circle_at_50%_0%,_hsl(var(--primary)/0.1),_transparent_40%)]" />
      
      <header className="relative z-10 w-full max-w-6xl mx-auto p-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <FlaskConical className="w-8 h-8 text-primary" />
          <span className="font-display font-bold text-xl">Virtual Lab Studio</span>
        </div>
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-muted-foreground">
          <Link href="/methodology" className="hover:text-foreground transition-colors">Methodology</Link>
          <a href="https://github.com/zou-group/virtual-lab" target="_blank" rel="noreferrer" className="hover:text-foreground transition-colors">Upstream Project</a>
        </nav>
        <Link href="/sign-in" className="bg-primary text-primary-foreground px-5 py-2.5 rounded-full text-sm font-semibold hover:bg-primary/90 transition-all flex items-center gap-2">
          Open Workspace <ChevronRight className="w-4 h-4" />
        </Link>
      </header>

      <main className="flex-1 relative z-10 flex flex-col items-center justify-center max-w-5xl mx-auto px-6 py-20 text-center">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.2, 0.8, 0.2, 1] }}
          className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-primary/20 bg-primary/10 text-primary text-xs font-semibold mb-8"
        >
          <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
          Deterministic Demo Environment
        </motion.div>
        
        <motion.h1 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.1, ease: [0.2, 0.8, 0.2, 1] }}
          className="text-5xl md:text-7xl font-display font-bold tracking-tight text-foreground max-w-4xl mb-6 leading-tight"
        >
          Structured AI collaboration for <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-secondary">rigorous research</span>.
        </motion.h1>
        
        <motion.p 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
          className="text-lg md:text-xl text-muted-foreground max-w-2xl mb-12"
        >
          Virtual Lab Studio is a premium scientific instrument that turns multi-agent debate into a calm, repeatable, and auditable methodology for hypothesis generation, literature review, and experimental design.
        </motion.p>
        
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.3, ease: [0.2, 0.8, 0.2, 1] }}
          className="flex flex-col sm:flex-row items-center gap-4"
        >
          <Link href="/sign-in" className="h-14 px-8 bg-foreground text-background rounded-full font-semibold text-lg flex items-center justify-center hover:bg-foreground/90 transition-all w-full sm:w-auto shadow-xl shadow-primary/10">
            Start the Demo
          </Link>
          <Link href="/methodology" className="h-14 px-8 vls-glass rounded-full font-semibold text-lg flex items-center justify-center hover:bg-white/5 transition-all w-full sm:w-auto">
            Read the Methodology
          </Link>
        </motion.div>

        <motion.div 
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.5, ease: [0.2, 0.8, 0.2, 1] }}
          className="mt-24 grid grid-cols-1 md:grid-cols-3 gap-6 w-full text-left"
        >
          <div className="vls-glass p-6 rounded-2xl">
            <div className="w-12 h-12 rounded-xl bg-primary/10 text-primary flex items-center justify-center mb-4">
              <Activity className="w-6 h-6" />
            </div>
            <h3 className="font-display font-semibold text-lg mb-2">Live Orchestration</h3>
            <p className="text-muted-foreground text-sm">Watch structured debates unfold in real-time. Pause, intervene, or redirect the discourse at safe checkpoints.</p>
          </div>
          <div className="vls-glass p-6 rounded-2xl">
            <div className="w-12 h-12 rounded-xl bg-secondary/10 text-secondary flex items-center justify-center mb-4">
              <GitMerge className="w-6 h-6" />
            </div>
            <h3 className="font-display font-semibold text-lg mb-2">Evidence-Grounded</h3>
            <p className="text-muted-foreground text-sm">Connect runs directly to uploaded literature. The summary engine separates source-backed facts from AI inferences.</p>
          </div>
          <div className="vls-glass p-6 rounded-2xl">
            <div className="w-12 h-12 rounded-xl bg-accent/10 text-accent flex items-center justify-center mb-4">
              <Database className="w-6 h-6" />
            </div>
            <h3 className="font-display font-semibold text-lg mb-2">Full Reproducibility</h3>
            <p className="text-muted-foreground text-sm">Every meeting generates a reproducibility manifest with SHA-256 content hashes containing exact prompts, tools, and human interventions.</p>
          </div>
        </motion.div>
      </main>
      
      <footer className="w-full text-center p-6 text-sm text-muted-foreground">
        Built on the <a href="https://github.com/zou-group/virtual-lab" className="underline hover:text-foreground">Virtual Lab</a> pattern. Not for clinical or autonomous lab use.
      </footer>
    </div>
  );
}
