const fs = require('node:fs/promises');
const path = require('node:path');
const {
  getSonarWorkingDirectory,
  getSonarConfigPath,
  getAppConfigDirectory,
  getWorkspaceBaseDir
} = require('./envConfig');

const WORKSPACE_BASE_DIR = getWorkspaceBaseDir();
const CONFIG_FILE_NAME = 'config.json';

function resolveWorkspacePath(storedPath = '') {
  const raw = String(storedPath || '').trim();
  if (!raw) return '';

  let withoutWorkspacePrefix = raw;
  if (raw.startsWith(`${WORKSPACE_BASE_DIR}/`)) {
    withoutWorkspacePrefix = raw.slice(WORKSPACE_BASE_DIR.length + 1);
  } else if (raw === WORKSPACE_BASE_DIR) {
    withoutWorkspacePrefix = '';
  }

  const cleanRelative = withoutWorkspacePrefix.replace(/^\/+/, '');
  const resolved = path.resolve(WORKSPACE_BASE_DIR, cleanRelative || '.');
  const isInsideWorkspace = resolved === WORKSPACE_BASE_DIR
    || resolved.startsWith(`${WORKSPACE_BASE_DIR}${path.sep}`);

  if (!isInsideWorkspace) {
    const error = new Error(`La ruta debe estar dentro de ${WORKSPACE_BASE_DIR}.`);
    error.status = 400;
    throw error;
  }

  return resolved;
}

function normalizeDirectory(value = '') {
  let str = String(value || '').trim();
  if (str.startsWith(`${WORKSPACE_BASE_DIR}/`)) {
    str = str.slice(WORKSPACE_BASE_DIR.length + 1);
  } else if (str === WORKSPACE_BASE_DIR) {
    str = '';
  }
  return str.replace(/^\/+/, '');
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

function normalizeSonarBundle(raw) {
  const sonarWorkingDirectory = getSonarWorkingDirectory();
  const sonarConfigPath = getSonarConfigPath();
  const safe = raw && typeof raw === 'object' ? raw : {};
  const global = safe.global && typeof safe.global === 'object' ? safe.global : {};
  const projects = Array.isArray(safe.projects) ? safe.projects : [];

  return {
    global: {
      sonarToken: String(global.sonarToken || '').trim(),
      sonarWorkingDirectory,
      sonarConfigPath
    },
    projects: projects
      .filter(function (item) {
        return item && typeof item === 'object';
      })
      .map(function (item) {
        const projectName = String(item.projectName || item.sonarProjectKey || '').trim();
        const projectBaseDir = String(item.projectBaseDir || item.sonarProjectBaseDir || '').trim();

        return {
          projectName,
          projectBaseDir
        };
      })
      .filter(function (item) {
        return !!item.projectName;
      })
  };
}

function normalizeAppBundle(raw) {
  const safe = raw && typeof raw === 'object' ? raw : {};
  return {
    theme: ['light', 'dark'].includes(safe.theme) ? safe.theme : 'light'
  };
}

async function getBundle() {
  const sonarConfigPath = getSonarConfigPath();
  const location = buildConfigFilePath(sonarConfigPath);

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
      const bundle = normalizeSonarBundle(JSON.parse(raw));
      return { bundle, ...legacyLocation };
    } catch (legacyError) {
      if (legacyError?.code === 'ENOENT') {
        return { bundle: normalizeSonarBundle({}), ...location };
      }
      throw legacyError;
    }
  }

  const bundle = normalizeSonarBundle(JSON.parse(raw));

  return { bundle, ...location };
}

async function writeBundle(bundleInput, directoryRelative) {
  const safeBundle = normalizeSonarBundle(bundleInput);
  const rawDir = String(directoryRelative || '').trim() || safeBundle.global.sonarConfigPath;
  const targetDirectory = normalizeDirectory(rawDir);
  const location = buildConfigFilePath(targetDirectory);

  safeBundle.global.sonarConfigPath = targetDirectory;

  await fs.mkdir(location.absoluteDirectory, { recursive: true });
  await fs.writeFile(location.filePath, JSON.stringify(safeBundle, null, 2), 'utf8');

  return { bundle: safeBundle, ...location };
}

async function getAppBundle() {
  const appConfigDirectory = getAppConfigDirectory();
  const absoluteDirectory = path.resolve(WORKSPACE_BASE_DIR, appConfigDirectory);
  const filePath = path.join(absoluteDirectory, CONFIG_FILE_NAME);

  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return { bundle: normalizeAppBundle({}), absoluteDirectory, filePath };
  }

  const bundle = normalizeAppBundle(JSON.parse(raw));
  return { bundle, absoluteDirectory, filePath };
}

async function writeAppBundle(appBundleInput) {
  const safeBundle = normalizeAppBundle(appBundleInput);
  const appConfigDirectory = getAppConfigDirectory();
  const absoluteDirectory = path.resolve(WORKSPACE_BASE_DIR, appConfigDirectory);
  const filePath = path.join(absoluteDirectory, CONFIG_FILE_NAME);

  await fs.mkdir(absoluteDirectory, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(safeBundle, null, 2), 'utf8');

  return { bundle: safeBundle, absoluteDirectory, filePath };
}

module.exports = {
  CONFIG_FILE_NAME,
  resolveWorkspacePath,
  getBundle,
  writeBundle,
  getAppBundle,
  writeAppBundle
};
