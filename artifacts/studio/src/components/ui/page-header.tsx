import React from 'react';
import { cn } from '@/lib/utils';

export function PageHeader({ title, description, children, className }: { title: React.ReactNode; description?: React.ReactNode; children?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col md:flex-row md:items-start justify-between gap-4 mb-8", className)}>
      <div>
        <h1 className="text-3xl font-display font-bold tracking-tight text-foreground">{title}</h1>
        {description && <p className="text-muted-foreground mt-1 max-w-2xl">{description}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-3 shrink-0">{children}</div>}
    </div>
  );
}
