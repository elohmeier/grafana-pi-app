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
