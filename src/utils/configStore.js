const fs = require('node:fs/promises');
const path = require('node:path');

const WORKSPACE_BASE_DIR = '/workspace';
const CONFIG_FILE_NAME = 'config.json';
const DEFAULT_CONFIG_DIRECTORY = 'sonar/config_directory';

function resolveWorkspacePath(storedPath = '') {
  const raw = String(storedPath || '').trim();
  if (!raw) return '';

  let withoutWorkspacePrefix = raw;
  if (raw.startsWith('/workspace/')) {
    withoutWorkspacePrefix = raw.slice('/workspace/'.length);
  } else if (raw === '/workspace') {
    withoutWorkspacePrefix = '';
  }

  const cleanRelative = withoutWorkspacePrefix.replace(/^\/+/, '');
  const resolved = path.resolve(WORKSPACE_BASE_DIR, cleanRelative || '.');
  const isInsideWorkspace = resolved === WORKSPACE_BASE_DIR
    || resolved.startsWith(`${WORKSPACE_BASE_DIR}${path.sep}`);

  if (!isInsideWorkspace) {
    const error = new Error('La ruta debe estar dentro de /workspace.');
    error.status = 400;
    throw error;
  }

  return resolved;
}

function normalizeDirectory(value = '') {
  const normalized = String(value || '').trim().replace(/^\/workspace\/?/, '').replace(/^\/+/, '');
  return normalized || DEFAULT_CONFIG_DIRECTORY;
}

function buildConfigFilePath(directoryRelative = DEFAULT_CONFIG_DIRECTORY) {
  const cleanDirectory = normalizeDirectory(directoryRelative);
  const absoluteDirectory = resolveWorkspacePath(cleanDirectory);
  return {
    directoryRelative: cleanDirectory,
    absoluteDirectory,
    filePath: path.join(absoluteDirectory, CONFIG_FILE_NAME)
  };
}

function normalizeBundle(raw) {
  const safe = raw && typeof raw === 'object' ? raw : {};
  const global = safe.global && typeof safe.global === 'object' ? safe.global : {};
  const projects = Array.isArray(safe.projects) ? safe.projects : [];

  return {
    global: {
      sonarToken: String(global.sonarToken || '').trim(),
      sonarWorkingDirectory: String(global.sonarWorkingDirectory || '').trim(),
      globalConfigDirectory: normalizeDirectory(global.globalConfigDirectory)
    },
    projects: projects
      .filter(function(item) {
        return item && typeof item === 'object';
      })
      .map(function(item) {
        return {
          sonarProjectKey: String(item.sonarProjectKey || '').trim(),
          sonarProjectBaseDir: String(item.sonarProjectBaseDir || '').trim()
        };
      })
      .filter(function(item) {
        return !!item.sonarProjectKey;
      })
  };
}

async function getBundle() {
  const location = buildConfigFilePath(DEFAULT_CONFIG_DIRECTORY);

  let raw;
  try {
    raw = await fs.readFile(location.filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { bundle: normalizeBundle({}), ...location };
    }
    throw error;
  }

  const bundle = normalizeBundle(JSON.parse(raw));

  if (!bundle.global.globalConfigDirectory) {
    bundle.global.globalConfigDirectory = location.directoryRelative;
  }

  return { bundle, ...location };
}

async function writeBundle(bundleInput, directoryRelative) {
  const safeBundle = normalizeBundle(bundleInput);
  const rawDir = String(directoryRelative || '').trim() || safeBundle.global.globalConfigDirectory;
  const targetDirectory = normalizeDirectory(rawDir);
  const location = buildConfigFilePath(targetDirectory);

  safeBundle.global.globalConfigDirectory = targetDirectory;

  await fs.mkdir(location.absoluteDirectory, { recursive: true });
  await fs.writeFile(location.filePath, JSON.stringify(safeBundle, null, 2), 'utf8');

  return { bundle: safeBundle, ...location };
}

module.exports = {
  CONFIG_FILE_NAME,
  DEFAULT_CONFIG_DIRECTORY,
  resolveWorkspacePath,
  getBundle,
  writeBundle
};
