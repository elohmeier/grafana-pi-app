import type { EvidencePresentation } from './evidence';
import type { ArtifactRuntime } from '../../domain/artifacts';
import type { WorkspaceApprovalService, WorkspaceBroker } from '../broker';
import type { SessionWorkspace, WorkspaceTransaction } from '../workspace';

export type CommandEffect = 'local-read' | 'local-stage' | 'remote-read' | 'remote-write';

export type CommandImage = { data: string; mimeType: string; title: string };

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Images returned to the model with the bash result (for example dashboard screenshots). */
  images?: CommandImage[];
  presentations?: EvidencePresentation[];
};

export type WorkspaceCommandContext = {
  workspace: SessionWorkspace;
  tx: WorkspaceTransaction;
  cwd: string;
  stdin: string;
  signal?: AbortSignal;
  broker: WorkspaceBroker;
  approvals?: WorkspaceApprovalService;
  artifacts?: ArtifactRuntime;
};

export type OptionSpec = {
  type: 'string' | 'boolean' | 'number' | 'string[]';
  alias?: string;
  description: string;
  default?: string | number | boolean;
};

export type SubcommandSpec = {
  summary: string;
  usage: string;
  effect: CommandEffect;
  options?: Record<string, OptionSpec>;
  examples?: string[];
  run: (parsed: ParsedArgs, ctx: WorkspaceCommandContext) => Promise<CommandResult>;
};

export type WorkspaceCommandSpec = {
  name: string;
  summary: string;
  subcommands: Record<string, SubcommandSpec>;
  /** Subcommand used when the first argument is not a known subcommand (CLI-style `jsonnet FILE`). */
  defaultSubcommand?: string;
};

export type ParsedArgs = {
  positionals: string[];
  options: Record<string, string | number | boolean | string[] | undefined>;
};

export class UsageError extends Error {}

export function parseArgs(args: string[], options: Record<string, OptionSpec> = {}): ParsedArgs {
  const parsed: ParsedArgs = { positionals: [], options: {} };
  const byAlias = new Map<string, string>();
  for (const [name, spec] of Object.entries(options)) {
    if (spec.alias) {
      byAlias.set(spec.alias, name);
    }
    if (spec.default !== undefined) {
      parsed.options[name] = spec.default;
    }
  }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') {
      parsed.positionals.push(...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      parsed.positionals.push(arg);
      continue;
    }
    let name: string;
    let inlineValue: string | undefined;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
      inlineValue = eq >= 0 ? arg.slice(eq + 1) : undefined;
    } else {
      name = byAlias.get(arg.slice(1)) ?? '';
      if (!name) {
        throw new UsageError(`unknown option ${arg}`);
      }
    }
    const spec = options[name];
    if (!spec) {
      throw new UsageError(`unknown option --${name}`);
    }
    if (spec.type === 'boolean') {
      parsed.options[name] = inlineValue === undefined ? true : !/^(false|0|no)$/i.test(inlineValue);
      continue;
    }
    const value = inlineValue ?? args[++index];
    if (value === undefined) {
      throw new UsageError(`option --${name} requires a value`);
    }
    if (spec.type === 'number') {
      const number = Number(value);
      if (!Number.isFinite(number)) {
        throw new UsageError(`option --${name} expects a number`);
      }
      parsed.options[name] = number;
    } else if (spec.type === 'string[]') {
      const current = parsed.options[name];
      parsed.options[name] = [...(Array.isArray(current) ? current : []), value];
    } else {
      parsed.options[name] = value;
    }
  }
  return parsed;
}

export function renderCommandHelp(command: WorkspaceCommandSpec, subcommand?: string) {
  if (subcommand && command.subcommands[subcommand]) {
    const spec = command.subcommands[subcommand];
    const lines = [`Usage: ${spec.usage}`, '', spec.summary, `Effect: ${spec.effect}`];
    const options = Object.entries(spec.options ?? {});
    if (options.length > 0) {
      lines.push('', 'Options:');
      for (const [name, option] of options) {
        const flag = `${option.alias ? `-${option.alias}, ` : ''}--${name}${option.type === 'boolean' ? '' : ' <value>'}`;
        const defaultText = option.default !== undefined ? ` (default ${option.default})` : '';
        lines.push(`  ${flag.padEnd(28)} ${option.description}${defaultText}`);
      }
    }
    if (spec.examples?.length) {
      lines.push('', 'Examples:', ...spec.examples.map((example) => `  ${example}`));
    }
    return `${lines.join('\n')}\n`;
  }
  const lines = [`${command.name} - ${command.summary}`, '', 'Subcommands:'];
  for (const spec of Object.values(command.subcommands)) {
    lines.push(`  ${spec.usage.padEnd(52)} ${spec.summary}`);
  }
  lines.push('', `Run \`${command.name} <subcommand> --help\` for details.`);
  return `${lines.join('\n')}\n`;
}

/** One-line-per-subcommand reference used to generate the system prompt. */
export function renderCommandReference(commands: readonly WorkspaceCommandSpec[]) {
  return commands
    .flatMap((command) => Object.values(command.subcommands).map((spec) => `- \`${spec.usage}\` - ${spec.summary}`))
    .join('\n');
}

export async function runRegisteredCommand(
  command: WorkspaceCommandSpec,
  args: string[],
  ctx: WorkspaceCommandContext
): Promise<CommandResult> {
  let [subcommand, ...rest] = args;
  if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    return ok(renderCommandHelp(command, rest[0]));
  }
  if (!command.subcommands[subcommand] && command.defaultSubcommand) {
    rest = args;
    subcommand = command.defaultSubcommand;
  }
  const spec = command.subcommands[subcommand];
  if (!spec) {
    return fail(
      `${command.name}: unknown subcommand ${JSON.stringify(subcommand)}\n\n${renderCommandHelp(command)}`,
      2
    );
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    return ok(renderCommandHelp(command, subcommand));
  }
  try {
    const parsed = parseArgs(rest, spec.options);
    return await spec.run(parsed, ctx);
  } catch (error) {
    if (error instanceof UsageError) {
      return fail(`${command.name} ${subcommand}: ${error.message}\nUsage: ${spec.usage}\n`, 2);
    }
    if (ctx.signal?.aborted) {
      throw error;
    }
    return fail(`${command.name} ${subcommand}: ${error instanceof Error ? error.message : String(error)}\n`, 1);
  }
}

export function ok(stdout: string, stderr = ''): CommandResult {
  return { stdout, stderr, exitCode: 0 };
}

export function fail(stderr: string, exitCode = 1, stdout = ''): CommandResult {
  return { stdout, stderr: stderr.endsWith('\n') ? stderr : `${stderr}\n`, exitCode };
}

export function json(value: unknown, exitCode = 0, stderr = ''): CommandResult {
  return { stdout: `${JSON.stringify(value, null, 2)}\n`, stderr, exitCode };
}

export function stringOption(parsed: ParsedArgs, name: string) {
  const value = parsed.options[name];
  return typeof value === 'string' ? value : undefined;
}

export function numberOption(parsed: ParsedArgs, name: string, fallback: number, min: number, max: number) {
  const value = parsed.options[name];
  const number = typeof value === 'number' ? value : fallback;
  return Math.min(Math.max(Math.floor(number), min), max);
}

export function listOption(parsed: ParsedArgs, name: string) {
  const value = parsed.options[name];
  return Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
}
