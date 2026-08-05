import React from 'react';
import { cn } from '@/lib/utils';

interface GlassPanelProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'surface' | 'strong';
}

export function GlassPanel({ variant = 'default', className, children, ...props }: GlassPanelProps) {
  return (
    <div
      className={cn(
        'rounded-xl transition-colors',
        variant === 'default' && 'vls-glass',
        variant === 'surface' && 'vls-reading-surface',
        variant === 'strong' && 'bg-surface-strong border border-border-strong text-foreground',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}
