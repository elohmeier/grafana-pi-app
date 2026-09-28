#!/usr/bin/env node

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const repoRoot = process.cwd();
const skillsRoot = path.join(repoRoot, 'assistant', 'skills');
const outputFile = path.join(repoRoot, 'src', 'pages', 'Chat', 'skills', 'bundledSkills.generated.ts');
const resourceDirectories = new Set(['references', 'templates', 'assets', 'scripts']);
const textExtensions = new Set([
  '.css',
  '.csv',
  '.json',
  '.jsonnet',
  '.libsonnet',
  '.md',
  '.promql',
  '.sh',
  '.jq',
  '.py',
  '.txt',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function normalizePath(filePath) {
  return filePath.split(path.sep).join('/');
}

function parseFrontmatter(source, skillDir) {
  if (!source.startsWith('---\n')) {
    fail(`${skillDir}: SKILL.md must start with YAML frontmatter`);
  }

  const end = source.indexOf('\n---\n', 4);
  if (end === -1) {
    fail(`${skillDir}: SKILL.md frontmatter must end with ---`);
  }

  const raw = source.slice(4, end);
  const body = source.slice(end + 5).trim();
  const frontmatter = {};

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(trimmed);
    if (!match) {
      fail(`${skillDir}: unsupported frontmatter line: ${line}`);
    }

    const key = match[1];
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (value === 'true') {
      frontmatter[key] = true;
    } else if (value === 'false') {
      frontmatter[key] = false;
    } else {
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body, content: source.trimEnd() };
}

function validateSkill(frontmatter, body, skillDir) {
  const name = frontmatter.name;
  const description = frontmatter.description;

  if (typeof name !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name)) {
    fail(`${skillDir}: frontmatter name must be kebab-case and 2-64 characters`);
  }

  if (name.includes('--')) {
    fail(`${skillDir}: frontmatter name must not contain repeated dashes`);
  }

  if (typeof description !== 'string' || description.trim().length === 0) {
    fail(`${skillDir}: frontmatter description is required`);
  }

  if (description.length > 1024) {
    fail(`${skillDir}: frontmatter description must be 1024 characters or fewer`);
  }

  if (body.length === 0) {
    fail(`${skillDir}: SKILL.md body must not be empty`);
  }
}

async function readTextResources(skillPath) {
  const resources = {};
  const entries = await readdir(skillPath, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || !resourceDirectories.has(entry.name)) {
      continue;
    }

    const root = path.join(skillPath, entry.name);
    await walk(root, async (filePath) => {
      const relativePath = normalizePath(path.relative(skillPath, filePath));
      const extension = path.extname(filePath).toLowerCase();

      if (!textExtensions.has(extension)) {
        return;
      }

      const content = await readFile(filePath, 'utf8');
      resources[relativePath] = {
        path: relativePath,
        content: content.trimEnd(),
        bytes: Buffer.byteLength(content),
      };
    });
  }

  return Object.fromEntries(Object.entries(resources).sort(([a], [b]) => a.localeCompare(b)));
}

async function walk(root, visit) {
  const entries = await readdir(root, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue;
    }

    const filePath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      await walk(filePath, visit);
    } else if (entry.isFile()) {
      await visit(filePath);
    }
  }
}

async function main() {
  const rootStats = await stat(skillsRoot).catch(() => undefined);
  if (!rootStats?.isDirectory()) {
    fail(`Missing skills directory: ${normalizePath(path.relative(repoRoot, skillsRoot))}`);
  }

  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const skillDirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const skills = [];
  const names = new Set();

  for (const dirName of skillDirs) {
    const skillPath = path.join(skillsRoot, dirName);
    const skillFile = path.join(skillPath, 'SKILL.md');
    const source = await readFile(skillFile, 'utf8').catch((error) => {
      fail(`${dirName}: unable to read SKILL.md: ${error.message}`);
    });

    const { frontmatter, body, content } = parseFrontmatter(source, dirName);
    validateSkill(frontmatter, body, dirName);

    if (names.has(frontmatter.name)) {
      fail(`${dirName}: duplicate skill name ${frontmatter.name}`);
    }
    names.add(frontmatter.name);

    skills.push({
      name: frontmatter.name,
      description: frontmatter.description,
      content,
      filePath: normalizePath(path.relative(repoRoot, skillFile)),
      disableModelInvocation: frontmatter['disable-model-invocation'] === true,
      resources: await readTextResources(skillPath),
    });
  }

  const output = `// Generated by scripts/generate-bundled-skills.mjs. Do not edit manually.\n\nimport type { BundledGrafanaSkill } from './types';\n\n// prettier-ignore\nexport const BUNDLED_GRAFANA_SKILLS = ${JSON.stringify(skills, null, 2)} as const satisfies readonly BundledGrafanaSkill[];\n`;

  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, output);
}

await main();
