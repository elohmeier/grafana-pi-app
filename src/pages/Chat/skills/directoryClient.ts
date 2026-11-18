import type { SkillsResponse } from '../../../generated/api';
import { pluginResourceFetch } from '../domain/client';

/**
 * The custom skills in the skills directory of the Grafana server (`skills_path`), read by the plugin backend.
 * Separate from the skill catalog, which the session core uses without @grafana/runtime.
 */
export function fetchDirectorySkills(): Promise<SkillsResponse> {
  return pluginResourceFetch<SkillsResponse>('/skills');
}
