const fs = require('node:fs/promises');
const path = require('node:path');
const {
  getSonarWorkingDirectory,
  getGlobalConfigDirectory
} = require('./envConfig');

const WORKSPACE_BASE_DIR = '/workspace';
const CONFIG_FILE_NAME = 'config.json';

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
  return String(value || '').trim().replace(/^\/workspace\/?/, '').replace(/^\/+/, '');
}

function buildConfigFilePath(directoryRelative) {
  const cleanDirectory = normalizeDirectory(directoryRelative);

  if (!cleanDirectory) {
    const error = new Error('La ruta de configuración es obligatoria.');
    error.status = 400;
    throw error;
  }

  const absoluteDirectory = resolveWorkspacePath(cleanDirectory);
  return {
    directoryRelative: cleanDirectory,
    absoluteDirectory,
    filePath: path.join(absoluteDirectory, CONFIG_FILE_NAME)
  };
}

function normalizeBundle(raw) {
  const sonarWorkingDirectory = getSonarWorkingDirectory();
  const globalConfigDirectory = getGlobalConfigDirectory();
  const safe = raw && typeof raw === 'object' ? raw : {};
  const global = safe.global && typeof safe.global === 'object' ? safe.global : {};
  const projects = Array.isArray(safe.projects) ? safe.projects : [];

  return {
    global: {
      sonarToken: String(global.sonarToken || '').trim(),
      sonarWorkingDirectory,
      globalConfigDirectory,
      theme: ['light', 'dark'].includes(global.theme) ? global.theme : 'light'
    },
    projects: projects
      .filter(function (item) {
        return item && typeof item === 'object';
      })
      .map(function (item) {
        return {
          sonarProjectKey: String(item.sonarProjectKey || '').trim(),
          sonarProjectBaseDir: String(item.sonarProjectBaseDir || '').trim()
        };
      })
      .filter(function (item) {
        return !!item.sonarProjectKey;
      })
  };
}

async function getBundle() {
  const globalConfigDirectory = getGlobalConfigDirectory();
  const location = buildConfigFilePath(globalConfigDirectory);

  let raw;
  try {
    raw = await fs.readFile(location.filePath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }

    const legacyLocation = buildConfigFilePath('sonar/config_directory');
    try {
      raw = await fs.readFile(legacyLocation.filePath, 'utf8');
      const bundle = normalizeBundle(JSON.parse(raw));
      return { bundle, ...legacyLocation };
    } catch (legacyError) {
      if (legacyError?.code === 'ENOENT') {
        return { bundle: normalizeBundle({}), ...location };
      }
      throw legacyError;
    }
  }

  const bundle = normalizeBundle(JSON.parse(raw));

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
  resolveWorkspacePath,
  getBundle,
  writeBundle
};
