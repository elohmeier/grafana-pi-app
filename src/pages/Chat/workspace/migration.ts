import { normalizeWorkspacePath } from './paths';
import type { SessionWorkspace } from './workspace';

/**
 * Copies Jsonnet sources authored with the retired write_jsonnet/edit_jsonnet
 * tools (stored as `virtualJsonnetFiles` on older sessions) into /workspace so
 * user-authored dashboards survive the cutover. Existing workspace files win.
 */
export function migrateLegacyJsonnetFiles(workspace: SessionWorkspace, legacy: unknown) {
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) {
    return [];
  }
  const tx = workspace.begin();
  const migrated: string[] = [];
  for (const [key, file] of Object.entries(legacy as Record<string, unknown>)) {
    const record = file && typeof file === 'object' ? (file as Record<string, unknown>) : undefined;
    if (typeof record?.content !== 'string') {
      continue;
    }
    const name = (typeof record.path === 'string' ? record.path : key).replace(/^\/+/, '');
    try {
      const path = normalizeWorkspacePath(name, '/workspace');
      if (!path.startsWith('/workspace/') || workspace.getScratchFile(path)) {
        continue;
      }
      void tx.writeFile(path, record.content);
      migrated.push(path);
    } catch {
      // Skip names that do not pass workspace path policy.
    }
  }
  try {
    tx.commit();
  } catch {
    return [];
  }
  return migrated;
}

/** The report the chat shows next to the messages; the agent maintains it like any other file. */
export const REPORT_PATH = '/session/report.md';

const LEGACY_REPORT_SECTIONS: Array<[string, string]> = [
  ['scope', 'Scope'],
  ['evidence', 'Evidence'],
  ['hypotheses', 'Hypotheses'],
  ['ruledOut', 'Ruled out'],
  ['nextSteps', 'Next checks'],
  ['remediation', 'Remediation'],
];

/**
 * Converts the structured investigation report of older sessions (maintained
 * with the retired update_report tool) into REPORT_PATH. An existing report file wins.
 */
export function migrateLegacyInvestigationReport(workspace: SessionWorkspace, legacy: unknown) {
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy) || workspace.getScratchFile(REPORT_PATH)) {
    return false;
  }
  const report = legacy as Record<string, unknown>;
  const title = typeof report.title === 'string' && report.title.trim() ? report.title.trim() : 'Investigation report';
  const lines = [`# ${title}`, '', `Status: ${report.status === 'complete' ? 'complete' : 'active'}`];
  for (const [key, heading] of LEGACY_REPORT_SECTIONS) {
    const items = Array.isArray(report[key])
      ? (report[key] as unknown[]).filter((item) => typeof item === 'string')
      : [];
    if (items.length > 0) {
      lines.push('', `## ${heading}`, '', ...items.map((item) => `- ${item}`));
    }
  }
  const tx = workspace.begin();
  try {
    void tx.writeFile(REPORT_PATH, `${lines.join('\n')}\n`);
    tx.commit();
    return true;
  } catch {
    tx.abort();
    return false;
  }
}
