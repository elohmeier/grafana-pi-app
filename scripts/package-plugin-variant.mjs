#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const repoRoot = process.cwd();
const basePluginId = 'g42-pi-app';
const officialAssistantPluginId = 'grafana-assistant-app';
const variantPluginId = process.env.PLUGIN_VARIANT_ID ?? officialAssistantPluginId;
const sidebarExtensionPoint = 'grafana/extension-sidebar/v0-alpha';
// Must match @grafana/assistant's ASSISTANT_PLUGIN_TITLE exactly for the
// official-ID variant, the same way src/module.tsx's ASSISTANT_SIDEBAR_TITLE
// does at runtime - this manifest's addedComponents/addedLinks titles are a
// separate, static declaration that Grafana core also checks (e.g. to
// resolve which component to render when opening the sidebar), so it has to
// stay in sync with the runtime value or the sidebar can be "available" per
// isAssistantAvailable() yet fail to actually open.
const sidebarTitle = variantPluginId === officialAssistantPluginId ? 'Grafana Assistant' : 'Assistant';
const pluginJsonPath = path.join(repoRoot, 'src', 'plugin.json');
const distDir = path.join(repoRoot, 'dist');
// Same keep rule as the webpack output.clean config: preserve built backend binaries.
const BACKEND_ARTIFACT = /(.*?_(amd64|arm(64)?)(.exe)?|go_plugin_build_manifest)$/;
const packageDir = path.join(repoRoot, variantPluginId);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseOptions(args) {
  const unsupportedArgs = args.filter((arg) => arg !== '--build-only');
  if (unsupportedArgs.length > 0) {
    fail(`Unsupported argument: ${unsupportedArgs[0]}`);
  }

  return {
    buildOnly: args.includes('--build-only'),
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      GRAFANA_PLUGIN_ID: variantPluginId,
      ...options.env,
    },
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with status ${result.status}`);
  }
}

function upsertExtension(entries, extension) {
  if (
    entries.some(
      (entry) =>
        entry.title === extension.title && Array.isArray(entry.targets) && entry.targets.includes(sidebarExtensionPoint)
    )
  ) {
    return entries;
  }

  return [...entries, extension];
}

function createVariantPluginJson(pluginJson) {
  const variant = structuredClone(pluginJson);
  variant.id = variantPluginId;

  const baseAccessAction = `${basePluginId}.app:access`;
  const variantAccessAction = `${variantPluginId}.app:access`;
  for (const role of variant.roles ?? []) {
    for (const permission of role.role?.permissions ?? []) {
      if (permission.action === baseAccessAction) {
        permission.action = variantAccessAction;
      }
    }
  }

  variant.extensions = variant.extensions ?? {};
  variant.extensions.addedComponents = upsertExtension(variant.extensions.addedComponents ?? [], {
    targets: [sidebarExtensionPoint],
    description: 'Open Assistant in the Grafana extension sidebar',
    title: sidebarTitle,
  });
  variant.extensions.addedLinks = upsertExtension(variant.extensions.addedLinks ?? [], {
    targets: [sidebarExtensionPoint],
    description: 'Show Assistant in the Grafana extension sidebar',
    title: sidebarTitle,
  });

  return variant;
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));

  if (!/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/.test(variantPluginId)) {
    fail(`Invalid variant plugin ID: ${variantPluginId}`);
  }

  const originalPluginJsonSource = await readFile(pluginJsonPath, 'utf8');
  const originalPluginJson = JSON.parse(originalPluginJsonSource);
  let packageDirActive = false;

  try {
    if (options.buildOnly) {
      // Keep the directory itself: the local Compose stack bind-mounts dist, and
      // replacing the directory would leave the container serving a deleted inode.
      await emptyDir(distDir);
    } else {
      await rm(distDir, { recursive: true, force: true });
    }
    if (!options.buildOnly) {
      await rm(packageDir, { recursive: true, force: true });
    }

    const variantPluginJson = createVariantPluginJson(originalPluginJson);
    await writeFile(pluginJsonPath, `${JSON.stringify(variantPluginJson, null, 2)}\n`);

    run('npm', ['run', 'build']);

    const builtPluginJson = JSON.parse(await readFile(path.join(distDir, 'plugin.json'), 'utf8'));
    const builtPluginId = builtPluginJson.id;
    const builtVersion = builtPluginJson.info?.version;
    if (builtPluginId !== variantPluginId) {
      throw new Error(`Expected built plugin ID ${variantPluginId}, got ${builtPluginId}`);
    }
    if (!builtVersion || builtVersion === '%VERSION%') {
      throw new Error('Built plugin version was not resolved');
    }

    if (options.buildOnly) {
      console.log(`Built ${variantPluginId} in dist`);
      return;
    }

    run('go', ['run', 'github.com/magefile/mage', '-v', 'buildAll']);

    const archive = `${variantPluginId}-${builtVersion}.zip`;
    const archivePath = path.join(repoRoot, archive);
    const sha1Path = `${archivePath}.sha1`;
    await rm(archivePath, { force: true });
    await rm(sha1Path, { force: true });

    await rename(distDir, packageDir);
    packageDirActive = true;
    run('zip', ['-qr', archive, variantPluginId]);

    const archiveBytes = await readFile(archivePath);
    const sha1 = createHash('sha1').update(archiveBytes).digest('hex');
    const sha1File = `${archive}.sha1`;
    await writeFile(sha1Path, `${sha1}  ${archive}\n`);

    await rename(packageDir, distDir);
    packageDirActive = false;

    if (process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, `archive=${archive}\narchive-sha1sum=${sha1File}\n`);
    }

    console.log(`Created ${archive}`);
    console.log(`Created ${sha1File}`);
  } finally {
    if (packageDirActive && (await exists(packageDir))) {
      await rm(distDir, { recursive: true, force: true });
      await rename(packageDir, distDir);
    }
    await writeFile(pluginJsonPath, originalPluginJsonSource);
  }
}

await main();

async function emptyDir(dir) {
  const entries = await readdir(dir).catch((error) => (error.code === 'ENOENT' ? [] : Promise.reject(error)));
  await Promise.all(
    entries
      .filter((entry) => !BACKEND_ARTIFACT.test(entry))
      .map((entry) => rm(path.join(dir, entry), { recursive: true, force: true }))
  );
}
