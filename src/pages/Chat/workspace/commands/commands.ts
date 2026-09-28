import type { WorkspaceCommandSpec } from './registry';
import { grafanaCommand } from './grafana';
import { grafanaDashboardCommand } from './dashboards';
import { grafanaPromCommand } from './prometheus';
import { workspaceCommand } from './workspace';
import { jsonnetCommand } from './jsonnet';
import { grafanaUsageCommand } from './metricUsage';
import { grafanaAlertCommand } from './alerts';
import { liveCommand } from './live';
import { evidenceCommand } from './evidence';

export { grafanaCommand } from './grafana';
export { grafanaDashboardCommand } from './dashboards';
export { grafanaPromCommand } from './prometheus';
export { workspaceCommand } from './workspace';

export const WORKSPACE_COMMANDS: readonly WorkspaceCommandSpec[] = [
  grafanaCommand,
  grafanaDashboardCommand,
  grafanaPromCommand,
  workspaceCommand,
  jsonnetCommand,
  grafanaUsageCommand,
  grafanaAlertCommand,
  liveCommand,
  evidenceCommand,
];
