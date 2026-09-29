#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const DEFAULT_CONCURRENCY = 8;
const DEFAULT_GRAFANA_URL = 'http://localhost:3001';
const DEFAULT_NAMESPACE = 'default';
const FOLDER_PAGE_SIZE = 1000;
const V2_API_VERSION = 'dashboard.grafana.app/v2';

if (isDirectInvocation()) {
  try {
    await main();
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  if (!options.inputPath) {
    printUsage();
    throw new Error('A dashboard directory is required.');
  }

  await importDashboardDirectory(options);
}

export async function importDashboardDirectory(options, dependencies = {}) {
  const logger = dependencies.logger ?? console;
  const fetchImplementation = dependencies.fetchImplementation ?? fetch;
  let tree = await discoverDashboardTree(options.inputPath);
  if (!options.folderUid) {
    tree = liftGeneralDirectory(tree);
  }
  tree = limitFolderDepth(tree, options.maxFolderDepth, logger);
  const dashboards = await mapLimit(tree.dashboardFiles, options.concurrency, readDashboard);
  assertUniqueDashboardUids(dashboards);
  const v2Dashboards = dashboards.filter((entry) => entry.format === 'v2').length;

  logger.log(
    `Found ${dashboards.length} dashboard${dashboards.length === 1 ? '' : 's'} (${dashboards.length - v2Dashboards} classic, ${v2Dashboards} v2) and ${tree.directories.length} folder${tree.directories.length === 1 ? '' : 's'} under ${tree.rootPath}.`
  );

  if (options.dryRun) {
    logger.log(
      `Dry run complete; no Grafana resources were changed. The source directory contents would be imported under ${options.folderUid ? `folder ${options.folderUid}` : 'General'}.`
    );
    return {
      dashboards: dashboards.length,
      folders: tree.directories.length,
      imported: 0,
    };
  }

  const grafanaUrl = (options.grafanaUrl ?? process.env.GRAFANA_URL ?? DEFAULT_GRAFANA_URL).replace(/\/+$/, '');
  const client = createGrafanaClient(grafanaUrl, options.namespace, fetchImplementation);
  const folderUids = new Map([['', options.folderUid]]);
  let createdFolders = 0;
  let reusedFolders = 0;

  for (const directory of tree.directories) {
    const parentUid = folderUids.get(directory.parentRelativePath);
    if (directory.parentRelativePath && !parentUid) {
      throw new Error(`Could not resolve the parent Grafana folder for ${directory.relativePath}.`);
    }

    const result = await client.ensureFolder(directory.title, parentUid);
    folderUids.set(directory.relativePath, result.folder.uid);
    if (result.created) {
      createdFolders += 1;
    } else {
      reusedFolders += 1;
    }
  }

  logger.log(
    `Folders ready: ${createdFolders} created, ${reusedFolders} reused${options.folderUid ? ` under ${options.folderUid}` : ''}.`
  );

  let imported = 0;
  const results = await mapLimit(dashboards, options.concurrency, async (entry) => {
    const folderUid = folderUids.get(entry.folderRelativePath);
    if (entry.folderRelativePath && !folderUid) {
      return {
        entry,
        error: new Error(`Could not resolve the Grafana folder for ${entry.relativePath}.`),
      };
    }

    try {
      const result = await client.importDashboard({
        entry,
        folderUid,
        overwrite: options.overwrite,
      });
      imported += 1;
      if (imported % 25 === 0 || imported === dashboards.length) {
        logger.log(`Imported ${imported}/${dashboards.length} dashboards.`);
      }
      return { entry, result };
    } catch (error) {
      return { entry, error };
    }
  });

  const failures = results.filter((result) => result.error);
  if (failures.length > 0) {
    const displayedFailures = failures
      .slice(0, 20)
      .map(({ entry, error }) => `  ${entry.relativePath}: ${error.message}`)
      .join('\n');
    const omitted = failures.length > 20 ? `\n  ...and ${failures.length - 20} more` : '';
    throw new Error(
      `${failures.length} dashboard import${failures.length === 1 ? '' : 's'} failed:\n${displayedFailures}${omitted}`
    );
  }

  logger.log(`Imported ${imported} dashboard${imported === 1 ? '' : 's'} from ${tree.rootPath} into ${grafanaUrl}.`);

  return {
    createdFolders,
    dashboards: dashboards.length,
    folders: tree.directories.length,
    imported,
    reusedFolders,
  };
}

export async function discoverDashboardTree(inputPath) {
  const rootPath = resolve(inputPath);
  let rootStat;
  try {
    rootStat = await stat(rootPath);
  } catch (error) {
    throw new Error(`Could not inspect ${rootPath}: ${error.message}`);
  }

  if (!rootStat.isDirectory()) {
    throw new Error(`${rootPath} is not a directory.`);
  }

  const dashboardFiles = [];
  const directories = [];

  async function walk(directoryPath) {
    let entries;
    try {
      entries = await readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
      throw new Error(`Could not read ${directoryPath}: ${error.message}`);
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = join(directoryPath, entry.name);
      const relativePath = relative(rootPath, entryPath);
      if (entry.isDirectory()) {
        const parentPath = dirname(relativePath);
        directories.push({
          inputPath: entryPath,
          parentRelativePath: parentPath === '.' ? '' : parentPath,
          relativePath,
          title: basename(entryPath),
        });
        await walk(entryPath);
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.json') {
        const folderPath = dirname(relativePath);
        dashboardFiles.push({
          folderRelativePath: folderPath === '.' ? '' : folderPath,
          inputPath: entryPath,
          relativePath,
        });
      }
    }
  }

  await walk(rootPath);
  return { dashboardFiles, directories, rootPath };
}

async function readDashboard(entry) {
  let contents;
  try {
    contents = await readFile(entry.inputPath, 'utf8');
  } catch (error) {
    throw new Error(`Could not read ${entry.inputPath}: ${error.message}`);
  }

  let source;
  try {
    source = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Could not parse ${entry.inputPath} as JSON: ${error.message}`);
  }

  const dashboardValue = source.dashboard ?? source;
  const resourceSpec = isObject(dashboardValue) && isObject(dashboardValue.spec) ? dashboardValue.spec : undefined;
  const v2Spec = isV2DashboardSpec(dashboardValue)
    ? dashboardValue
    : isV2DashboardSpec(resourceSpec)
      ? resourceSpec
      : undefined;

  if (v2Spec) {
    const apiVersion = resourceSpec ? dashboardValue.apiVersion : undefined;
    if (apiVersion && apiVersion !== V2_API_VERSION) {
      throw new Error(
        `${entry.inputPath} uses unsupported dashboard API version ${apiVersion}; expected ${V2_API_VERSION}.`
      );
    }
    if (typeof v2Spec.title !== 'string' || v2Spec.title.trim() === '') {
      throw new Error(`${entry.inputPath} must contain a v2 dashboard spec with a title.`);
    }

    const resourceMetadata = resourceSpec && isObject(dashboardValue.metadata) ? dashboardValue.metadata : {};
    const resourceName =
      typeof resourceMetadata.name === 'string' && resourceMetadata.name.trim()
        ? resourceMetadata.name.trim()
        : createV2DashboardName(entry.relativePath);
    return {
      ...entry,
      dashboard: v2Spec,
      format: 'v2',
      resourceMetadata,
      resourceName,
    };
  }

  if (!isObject(dashboardValue) || typeof dashboardValue.title !== 'string' || dashboardValue.title.trim() === '') {
    throw new Error(
      `${entry.inputPath} must contain a dashboard model or an export containing a dashboard with a title.`
    );
  }

  return { ...entry, dashboard: dashboardValue, format: 'classic' };
}

// Grafana reserves the name General for its root folder, and exports store root dashboards in a
// top-level general directory. Import that directory's contents into General itself.
export function liftGeneralDirectory(tree) {
  const general = tree.directories.find(
    (directory) => directory.parentRelativePath === '' && directory.title.toLowerCase() === 'general'
  );
  if (!general) {
    return tree;
  }
  const lift = (relativePath) =>
    relativePath === general.relativePath
      ? ''
      : relativePath.startsWith(general.relativePath + sep)
        ? relativePath.slice(general.relativePath.length + 1)
        : relativePath;
  return {
    ...tree,
    dashboardFiles: tree.dashboardFiles.map((file) => ({
      ...file,
      folderRelativePath: lift(file.folderRelativePath),
    })),
    directories: tree.directories
      .filter((directory) => directory !== general)
      .map((directory) => ({
        ...directory,
        parentRelativePath: lift(directory.parentRelativePath),
        relativePath: lift(directory.relativePath),
      })),
  };
}

// Grafana rejects folders nested deeper than its max_nesting_depth (4 by default). Directories below
// the limit are merged into their ancestor at the limit, so their dashboards still import.
export function limitFolderDepth(tree, maxFolderDepth, logger = console) {
  if (!maxFolderDepth) {
    return tree;
  }
  const truncate = (relativePath) => relativePath.split(sep).slice(0, maxFolderDepth).join(sep);
  const depth = (relativePath) => relativePath.split(sep).length;
  const directories = tree.directories.filter((directory) => depth(directory.relativePath) <= maxFolderDepth);
  const merged = tree.directories.length - directories.length;
  if (merged > 0) {
    logger.log(
      `Merging ${merged} director${merged === 1 ? 'y' : 'ies'} nested deeper than ${maxFolderDepth} levels into their ancestor folder.`
    );
  }
  return {
    ...tree,
    dashboardFiles: tree.dashboardFiles.map((file) => ({
      ...file,
      folderRelativePath: file.folderRelativePath && truncate(file.folderRelativePath),
    })),
    directories,
  };
}

function assertUniqueDashboardUids(dashboards) {
  const filesByUid = new Map();
  for (const entry of dashboards) {
    const dashboardUid = entry.format === 'v2' ? entry.resourceName : entry.dashboard.uid;
    if (typeof dashboardUid !== 'string' || dashboardUid.trim() === '') {
      continue;
    }
    const uid = dashboardUid.trim();
    const files = filesByUid.get(uid) ?? [];
    files.push(entry.relativePath);
    filesByUid.set(uid, files);
  }

  const duplicates = [...filesByUid.entries()].filter(([, files]) => files.length > 1);
  if (duplicates.length === 0) {
    return;
  }

  const details = duplicates
    .slice(0, 20)
    .map(([uid, files]) => `  ${uid}: ${files.join(', ')}`)
    .join('\n');
  const omitted = duplicates.length > 20 ? `\n  ...and ${duplicates.length - 20} more duplicate UIDs` : '';
  throw new Error(`Dashboard UIDs must be unique across the import tree:\n${details}${omitted}`);
}

function createGrafanaClient(grafanaUrl, namespace, fetchImplementation) {
  const childrenByParentUid = new Map();
  const v2CollectionPath = `/apis/dashboard.grafana.app/v2/namespaces/${encodeURIComponent(namespace)}/dashboards`;

  async function request(path, init, operation, options = {}) {
    let response;
    try {
      response = await fetchImplementation(`${grafanaUrl}${path}`, {
        ...init,
        headers: {
          Authorization: authorizationHeader(),
          ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
          ...init?.headers,
        },
      });
    } catch (error) {
      throw new Error(`${operation} could not reach Grafana at ${grafanaUrl}: ${error.message}`);
    }

    const responseText = await response.text();
    const result = parseJson(responseText);
    if (options.allowNotFound && response.status === 404) {
      return undefined;
    }
    if (!response.ok) {
      const detail = result?.message ?? result?.error ?? responseText;
      throw new Error(`${operation} failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    return result;
  }

  async function listFolders(parentUid) {
    const folders = [];
    for (let page = 1; ; page += 1) {
      const parameters = new URLSearchParams({
        limit: String(FOLDER_PAGE_SIZE),
        page: String(page),
      });
      if (parentUid) {
        parameters.set('parentUid', parentUid);
      }
      const pageFolders = await request(
        `/api/folders?${parameters}`,
        { method: 'GET' },
        `Listing folders below ${parentUid ?? 'General'}`
      );
      if (!Array.isArray(pageFolders)) {
        throw new Error(`Listing folders below ${parentUid ?? 'General'} returned an invalid response.`);
      }
      folders.push(...pageFolders);
      if (pageFolders.length < FOLDER_PAGE_SIZE) {
        return folders;
      }
    }
  }

  async function ensureFolder(title, parentUid) {
    const cacheKey = parentUid ?? '';
    let children = childrenByParentUid.get(cacheKey);
    if (!children) {
      const folders = await listFolders(parentUid);
      children = new Map(folders.map((folder) => [folder.title, folder]));
      childrenByParentUid.set(cacheKey, children);
    }

    const existing = children.get(title);
    if (existing) {
      if (typeof existing.uid !== 'string' || existing.uid === '') {
        throw new Error(`Grafana returned folder "${title}" without a UID.`);
      }
      return { created: false, folder: existing };
    }

    const folder = await request(
      '/api/folders',
      {
        body: JSON.stringify({
          ...(parentUid ? { parentUid } : {}),
          title,
        }),
        method: 'POST',
      },
      `Creating folder "${title}" below ${parentUid ?? 'General'}`
    );
    if (!isObject(folder) || typeof folder.uid !== 'string' || folder.uid === '') {
      throw new Error(`Creating folder "${title}" returned an invalid response.`);
    }
    children.set(title, folder);
    return { created: true, folder };
  }

  async function importClassicDashboard({ dashboard, folderUid, inputPath, overwrite }) {
    return request(
      '/api/dashboards/db',
      {
        body: JSON.stringify({
          dashboard: { ...dashboard, id: null },
          ...(folderUid ? { folderUid } : {}),
          message: `Imported from ${inputPath}`,
          overwrite,
        }),
        method: 'POST',
      },
      `Importing dashboard "${dashboard.title}"`
    );
  }

  async function importV2Dashboard({ entry, folderUid, overwrite }) {
    const resourcePath = `${v2CollectionPath}/${encodeURIComponent(entry.resourceName)}`;
    let exists = false;
    if (overwrite) {
      exists = Boolean(
        await request(resourcePath, { method: 'GET' }, `Checking v2 dashboard "${entry.dashboard.title}"`, {
          allowNotFound: true,
        })
      );
    }

    const metadata = createV2DashboardMetadata(entry, folderUid, !exists);
    const resource = {
      apiVersion: V2_API_VERSION,
      kind: 'Dashboard',
      metadata,
      spec: entry.dashboard,
    };

    return request(
      exists ? resourcePath : v2CollectionPath,
      {
        body: JSON.stringify(resource),
        method: exists ? 'PUT' : 'POST',
      },
      `Importing v2 dashboard "${entry.dashboard.title}"`
    );
  }

  async function importDashboard({ entry, folderUid, overwrite }) {
    if (entry.format === 'v2') {
      return importV2Dashboard({ entry, folderUid, overwrite });
    }
    return importClassicDashboard({
      dashboard: entry.dashboard,
      folderUid,
      inputPath: entry.inputPath,
      overwrite,
    });
  }

  return { ensureFolder, importDashboard };
}

function createV2DashboardMetadata(entry, folderUid, creating) {
  const sourceLabels = isObject(entry.resourceMetadata.labels) ? entry.resourceMetadata.labels : {};
  const labels = { ...sourceLabels };
  delete labels['grafana.app/deprecatedInternalID'];

  const sourceAnnotations = isObject(entry.resourceMetadata.annotations) ? entry.resourceMetadata.annotations : {};
  const annotations = {
    ...sourceAnnotations,
    'grafana.app/folder': folderUid ?? '',
    'grafana.app/message': `Imported from ${entry.inputPath}`,
  };
  delete annotations['grafana.app/folderTitle'];
  delete annotations['grafana.app/folderUrl'];
  if (creating) {
    annotations['grafana.app/grant-permissions'] = 'default';
  } else {
    delete annotations['grafana.app/grant-permissions'];
  }

  return {
    name: entry.resourceName,
    ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
    ...(Object.keys(labels).length > 0 ? { labels } : {}),
  };
}

function createV2DashboardName(relativePath) {
  const extension = extname(relativePath);
  const fileStem = basename(relativePath, extension)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const hash = createHash('sha256').update(relativePath.replaceAll('\\', '/')).digest('hex').slice(0, 10);
  const prefix = (fileStem || 'dashboard').slice(0, 29).replace(/-+$/g, '') || 'dashboard';
  return `${prefix}-${hash}`;
}

function isV2DashboardSpec(value) {
  return isObject(value) && ('elements' in value || 'layout' in value);
}

export function parseArguments(args) {
  const options = {
    concurrency: parseConcurrency(process.env.GRAFANA_IMPORT_CONCURRENCY ?? String(DEFAULT_CONCURRENCY)),
    dryRun: false,
    folderUid: process.env.GRAFANA_FOLDER_UID,
    grafanaUrl: undefined,
    help: false,
    inputPath: undefined,
    maxFolderDepth: undefined,
    namespace: process.env.GRAFANA_NAMESPACE ?? DEFAULT_NAMESPACE,
    overwrite: true,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case '--concurrency':
        options.concurrency = parseConcurrency(requireValue(args, ++index, argument));
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--grafana-url':
        options.grafanaUrl = requireValue(args, ++index, argument);
        break;
      case '--folder-uid':
        options.folderUid = requireValue(args, ++index, argument);
        break;
      case '--max-folder-depth':
        options.maxFolderDepth = parseMaxFolderDepth(requireValue(args, ++index, argument));
        break;
      case '--namespace':
        options.namespace = requireValue(args, ++index, argument);
        break;
      case '--no-overwrite':
        options.overwrite = false;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        if (argument.startsWith('-')) {
          throw new Error(`Unknown option: ${argument}`);
        }
        if (options.inputPath) {
          throw new Error(`Unexpected additional dashboard directory: ${argument}`);
        }
        options.inputPath = argument;
    }
  }

  return options;
}

function parseConcurrency(value) {
  const concurrency = Number(value);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 64) {
    throw new Error('--concurrency must be an integer between 1 and 64.');
  }
  return concurrency;
}

function parseMaxFolderDepth(value) {
  const depth = Number(value);
  if (!Number.isSafeInteger(depth) || depth < 1) {
    throw new Error('--max-folder-depth must be a positive integer.');
  }
  return depth;
}

function requireValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith('-')) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function authorizationHeader() {
  if (process.env.GRAFANA_TOKEN) {
    return `Bearer ${process.env.GRAFANA_TOKEN}`;
  }
  const user = process.env.GRAFANA_USER ?? 'admin';
  const password = process.env.GRAFANA_PASSWORD ?? 'admin';
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => runWorker());
  await Promise.all(workers);
  return results;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDirectInvocation() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

function printUsage() {
  console.log(`Usage: npm run dev:import:dashboards -- [options] <dashboard-directory>

Recursively imports every JSON dashboard and mirrors all child directories as nested Grafana folders.
The source directory itself is not created. Dashboards directly inside it are imported into General, or
into the folder selected with --folder-uid. Without --folder-uid, a top-level general directory is also
imported into General.

Options:
  --grafana-url URL  Grafana URL (default: GRAFANA_URL or ${DEFAULT_GRAFANA_URL})
  --folder-uid UID   Use an existing Grafana folder as the root (default: General)
  --max-folder-depth N
                     Merge directories nested deeper than N levels into their ancestor
                     (Grafana allows 4 nested folder levels by default)
  --namespace NAME   Grafana API namespace for v2 dashboards (default: ${DEFAULT_NAMESPACE})
  --concurrency N    Concurrent dashboard imports, 1-64 (default: ${DEFAULT_CONCURRENCY})
  --no-overwrite     Fail instead of replacing a dashboard with the same UID
  --dry-run          Validate and count the source tree without changing Grafana
  -h, --help         Show this help

Authentication:
  Set GRAFANA_TOKEN, or GRAFANA_USER and GRAFANA_PASSWORD (defaults: admin/admin).`);
}
