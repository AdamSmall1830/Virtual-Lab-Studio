import React, { useState } from 'react';
import { useListTemplates } from '@workspace/api-client-react';
import { PageHeader } from '@/components/ui/page-header';
import { GlassPanel } from '@/components/ui/glass-panel';
import { Button } from '@/components/ui/button';
import { Link } from 'wouter';
import { FileText, Users, User, ArrowRight } from 'lucide-react';

export default function TemplateLibrary() {
  const { data: templates, isLoading } = useListTemplates();
  const [selectedCategory, setSelectedCategory] = useState<string>('all');

  const categories = ['all', ...Array.from(new Set(templates?.map(t => t.category) || []))];
  
  const filtered = templates?.filter(t => selectedCategory === 'all' || t.category === selectedCategory) || [];

  return (
    <div className="p-6 md:p-8 max-w-7xl mx-auto w-full">
      <PageHeader 
        title="Template Library" 
        description="Pre-configured meeting structures for specific research methodologies."
      />

      <div className="flex flex-wrap gap-2 mb-8">
        {categories.map(cat => (
          <button
            key={cat}
            onClick={() => setSelectedCategory(cat)}
            className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors cursor-pointer ${selectedCategory === cat ? 'bg-primary text-primary-foreground shadow-md border border-primary' : 'bg-surface-strong border border-border text-muted-foreground hover:bg-muted'}`}
          >
            {cat === 'all' ? 'All Templates' : cat.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-6">
          {[1,2,3].map(i => <div key={i} className="h-64 bg-muted/50 rounded-xl animate-pulse"></div>)}
        </div>
      ) : (
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-6">
          {filtered.map(template => (
            <GlassPanel key={template.id} className="p-6 flex flex-col h-full border-t-4 border-t-secondary/50 hover:border-t-secondary transition-colors">
              <div className="flex justify-between items-start mb-4">
                <div className="p-2 bg-secondary/10 rounded-lg text-secondary border border-secondary/20">
                  {template.kind === 'team' ? <Users className="w-5 h-5" /> : <User className="w-5 h-5" />}
                </div>
                <span className="text-xs bg-surface-strong border border-border px-2 py-1 rounded text-muted-foreground capitalize">
                  {template.category.replace('_', ' ')}
                </span>
              </div>
              
              <h3 className="text-xl font-display font-bold mb-2">{template.name}</h3>
              <p className="text-sm text-muted-foreground mb-6 flex-1 line-clamp-3 leading-relaxed">{template.description}</p>
              
              <div className="space-y-4 mb-6 flex-1">
                {template.requiredQuestions && template.requiredQuestions.length > 0 && (
                  <div className="text-xs">
                    <span className="font-semibold text-foreground/80 mb-1 block">Requires answers to:</span>
                    <ul className="text-muted-foreground list-disc pl-4 space-y-1">
                      {template.requiredQuestions.slice(0, 2).map((q, i) => <li key={i} className="truncate" title={q}>{q}</li>)}
                      {template.requiredQuestions.length > 2 && <li>+ {template.requiredQuestions.length - 2} more</li>}
                    </ul>
                  </div>
                )}
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="bg-muted border border-border/50 px-2 py-1 rounded">{template.defaultRounds} rounds</span>
                  <span className="bg-muted border border-border/50 px-2 py-1 rounded capitalize">{template.kind.replace('_', ' ')} format</span>
                </div>
              </div>

              <Link href={`/app/meetings/new?templateId=${template.id}`} className="mt-auto block">
                <Button className="w-full" variant="outline">
                  Use Template <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              </Link>
            </GlassPanel>
          ))}
          {filtered.length === 0 && <div className="col-span-full py-12 text-center text-muted-foreground">No templates found in this category.</div>}
        </div>
      )}
    </div>
  );
}
