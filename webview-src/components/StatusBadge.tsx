import React from 'react';
import { ResearchStatus } from '../../src/models/types';

const COLORS: Record<ResearchStatus, string> = {
  draft: '#6c757d',
  approved: '#28a745',
  deprecated: '#dc3545',
  archived: '#856404',
  pending: '#6c757d',
  failed: '#dc3545',
  succeeded: '#28a745',
  abandoned: '#856404',
  resolved: '#17a2b8',
};

interface Props {
  status: ResearchStatus;
}

export function StatusBadge({ status }: Props) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '1px 7px',
        borderRadius: '10px',
        fontSize: '11px',
        fontWeight: 600,
        color: '#fff',
        backgroundColor: COLORS[status] ?? '#6c757d',
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
      }}
    >
      {status}
    </span>
  );
}
