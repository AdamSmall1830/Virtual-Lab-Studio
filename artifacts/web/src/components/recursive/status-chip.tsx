import React from 'react';
import { TONE_CLASS, type StatusPresentation } from '@/lib/recursive';

/**
 * A status badge that always carries its meaning in words.
 *
 * Colour is decoration here, never the signal: the label is always rendered
 * and the icon differs per state, so the chip stays readable in greyscale and
 * to a screen reader.
 */
export function StatusChip({
  presentation,
  size = 'sm',
  className = '',
}: {
  presentation: StatusPresentation;
  size?: 'sm' | 'xs';
  className?: string;
}) {
  const Icon = presentation.icon;
  const pad = size === 'xs' ? 'px-1.5 py-0.5 text-[10px] gap-1' : 'px-2 py-0.5 text-xs gap-1.5';
  const iconSize = size === 'xs' ? 'w-3 h-3' : 'w-3.5 h-3.5';
  return (
    <span
      className={`inline-flex items-center rounded-full border font-semibold ${pad} ${
        TONE_CLASS[presentation.tone]
      } ${className}`}
    >
      <Icon className={`${iconSize} ${presentation.busy ? 'animate-spin' : ''}`} aria-hidden />
      {presentation.label}
    </span>
  );
}
