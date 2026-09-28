import React from 'react';
import type { EvidencePresentation } from '../workspace/commands/evidence';

export function EvidenceView({ evidence }: { evidence: EvidencePresentation }) {
  const rows =
    evidence.view === 'table' && Array.isArray(evidence.data)
      ? (evidence.data as Array<Record<string, unknown>>)
      : undefined;
  const columns = rows ? [...new Set(rows.flatMap(Object.keys))].slice(0, 20) : [];
  return (
    <section aria-label={evidence.title} style={{ overflowX: 'auto', marginBlock: 12 }}>
      <strong>{evidence.title}</strong>
      <div>
        <small>
          {evidence.path} · revision {evidence.revision}
        </small>
      </div>
      {rows ? (
        <table>
          <thead>
            <tr>
              {columns.map((key) => (
                <th key={key} style={{ padding: 8 }}>
                  {key}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {columns.map((key) => (
                  <td key={key} style={{ padding: 8 }}>
                    {display(row[key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <pre style={{ whiteSpace: 'pre-wrap' }}>
          {typeof evidence.data === 'string' ? evidence.data : JSON.stringify(evidence.data, null, 2)}
        </pre>
      )}
    </section>
  );
}

function display(value: unknown) {
  return value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export function evidencePresentations(value: unknown): EvidencePresentation[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item) =>
      item &&
      item.version === 1 &&
      typeof item.path === 'string' &&
      typeof item.title === 'string' &&
      typeof item.revision === 'string' &&
      ['json', 'text', 'table'].includes(item.view) &&
      (item.view !== 'table' ||
        (Array.isArray(item.data) &&
          item.data.length <= 100 &&
          item.data.every((row: unknown) => row !== null && typeof row === 'object' && !Array.isArray(row))))
  );
}
