import React from 'react';
import { ResearchStatus } from '../../src/models/types';
import { COLOR } from '../graph/colors';

/** Theme colors, drawn as an outline so the text keeps contrast in light and dark themes. */
const COLORS: Record<ResearchStatus, string> = {
  draft: COLOR.draft,
  approved: COLOR.approved,
  deprecated: COLOR.error,
  archived: COLOR.inactive,
  pending: COLOR.draft,
  failed: COLOR.error,
  succeeded: COLOR.approved,
  abandoned: COLOR.inactive,
  resolved: COLOR.link,
};

interface Props {
  status: ResearchStatus;
}

export function StatusBadge({ status }: Props) {
  const color = COLORS[status] ?? COLOR.draft;
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '0 6px',
        borderRadius: '10px',
        fontSize: '11px',
        fontWeight: 600,
        color,
        border: `1px solid ${color}`,
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
      }}
    >
      {status}
    </span>
  );
}
