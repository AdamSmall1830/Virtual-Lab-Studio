import React from 'react';
import { Link } from 'wouter';
import { ArrowLeft, BookOpen, AlertTriangle, Copyright } from 'lucide-react';

export default function Methodology() {
  return (
    <div className="min-h-screen max-w-3xl mx-auto p-6 md:p-12">
      <Link href="/" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-8">
        <ArrowLeft className="w-4 h-4" /> Back
      </Link>
      
      <h1 className="text-4xl font-display font-bold mb-8">Methodology & Upstream Attribution</h1>
      
      <div className="space-y-12">
        <section className="space-y-4">
          <h2 className="text-2xl font-display font-semibold flex items-center gap-2">
            <Copyright className="w-6 h-6 text-primary" />
            Attribution
          </h2>
          <div className="vls-reading-surface p-6 rounded-xl space-y-4">
            <p className="text-foreground leading-relaxed">
              Virtual Lab Studio is built upon the interaction patterns established by the MIT-licensed open-source project <a href="https://github.com/zou-group/virtual-lab" target="_blank" rel="noreferrer" className="text-primary hover:underline font-medium">Virtual Lab (Swanson et al.)</a>.
            </p>
            <p className="text-muted-foreground text-sm leading-relaxed">
              While the upstream repository provides a Python-based execution environment for multi-agent literature review and hypothesis generation, this Studio aims to operationalize that pattern into a predictable graphical instrument accessible to principal investigators, domain experts, and non-programmers.
            </p>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-display font-semibold flex items-center gap-2">
            <BookOpen className="w-6 h-6 text-secondary" />
            The Virtual Lab Pattern
          </h2>
          <div className="vls-reading-surface p-6 rounded-xl space-y-4">
            <p className="text-foreground leading-relaxed">
              The core methodology utilizes a <strong>Lead Investigator</strong> combined with domain-specific <strong>Specialist Agents</strong> and a dedicated <strong>Scientific Critic</strong>.
            </p>
            <ul className="list-disc list-inside space-y-2 text-muted-foreground text-sm ml-4">
              <li>Agents debate iteratively across defined rounds, governed by strict budgetary and tool-access constraints.</li>
              <li>A final synthesis is explicitly extracted, separating grounded evidence from generative recommendations.</li>
              <li>Human review is inserted at safe checkpoints, preventing off-track hallucination cascades.</li>
            </ul>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-display font-semibold flex items-center gap-2">
            <AlertTriangle className="w-6 h-6 text-warning" />
            Limitations & Non-Goals
          </h2>
          <div className="vls-glass border-warning/20 p-6 rounded-xl space-y-4">
            <p className="text-foreground leading-relaxed font-medium">
              Virtual Lab Studio is an ideation and planning instrument, not an oracle.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm text-muted-foreground">
              <div className="bg-background/50 p-4 rounded-lg">
                <strong className="text-foreground block mb-1">No Real Humans</strong>
                AI personas are model roles. They are never to be presented as real human experts, nor do they carry credentialed authority.
              </div>
              <div className="bg-background/50 p-4 rounded-lg">
                <strong className="text-foreground block mb-1">No Autonomous Labs</strong>
                The system does not integrate with, control, or execute code on physical laboratory hardware (wet labs, sequencers).
              </div>
              <div className="bg-background/50 p-4 rounded-lg">
                <strong className="text-foreground block mb-1">No Clinical Claims</strong>
                Outputs cannot be used for clinical diagnosis, treatment planning, or direct patient care.
              </div>
              <div className="bg-background/50 p-4 rounded-lg">
                <strong className="text-foreground block mb-1">Mandatory Human Review</strong>
                Every action generated must be reviewed by a qualified human researcher before any external utilization.
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
