const fs = require('node:fs/promises');
const {
  getGlobalSonarHostUrl,
  getSonarWorkingDirectory,
  getGlobalConfigDirectory
} = require('../utils/envConfig');
const {
  resolveWorkspacePath,
  getBundle,
  writeBundle
} = require('../utils/configStore');

const REQUIRED_GLOBAL_FIELDS = [
  'sonarToken'
];

function renderHome(req, res) {
  res.render('home', {});
}

async function getProjects(req, res) {
  try {
    const { bundle } = await getBundle();
    const projects = Array.isArray(bundle?.projects) ? bundle.projects : [];

    res.json({ success: true, data: projects });
  } catch {
    res.status(500).json({ success: false, message: 'No fue posible listar los proyectos.' });
  }
}

async function getGlobalConfig(req, res) {
  try {
    const sonarHostUrl = getGlobalSonarHostUrl();
    const sonarWorkingDirectory = getSonarWorkingDirectory();
    const globalConfigDirectory = getGlobalConfigDirectory();
    const { bundle } = await getBundle();
    const global = bundle?.global || {};

    let data = {
      sonarToken: String(global.sonarToken || '').trim(),
      sonarHostUrl,
      sonarWorkingDirectory,
      globalConfigDirectory,
      theme: String(global.theme || 'light')
    };

    return res.json({ success: true, data });
  } catch {
    return res.status(500).json({ success: false, message: 'No fue posible obtener la configuración global.' });
  }
}

async function buildWorkingDirectoryWarning(workingDir) {
  if (!workingDir) return null;

  const resolved = resolveWorkspacePath(workingDir);

  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      return `La ruta '${resolved}' existe pero no es un directorio.`;
    }
    return null;
  } catch (statError) {
    if (statError?.code !== 'ENOENT') {
      return `Error al verificar el directorio '${resolved}': ${statError.message}`;
    }

    try {
      await fs.mkdir(resolved, { recursive: true });
    } catch (mkdirError) {
      return `No se pudo crear el directorio '${resolved}': ${mkdirError.message}`;
    }

    return null;
  }
}

function buildLocalhostWarning(sonarHostUrl) {
  const lowerHost = String(sonarHostUrl || '').toLowerCase();
  const localhostPrefixes = [
    'http://localhost', 'https://localhost',
    'http://127.0.0.1', 'https://127.0.0.1',
    'http://[::1]', 'https://[::1]'
  ];

  if (localhostPrefixes.some(function(prefix) { return lowerHost.startsWith(prefix); })) {
    return "En Docker, 'localhost' apunta al contenedor app. Se usará 'sonarqube' internamente para conectar con SonarQube.";
  }

  return null;
}

async function saveGlobalConfig(req, res) {
  try {
    const payload = req.body || {};
    const missing = REQUIRED_GLOBAL_FIELDS.filter(function(field) { return !payload[field] || !String(payload[field]).trim(); });
    const sonarHostUrl = getGlobalSonarHostUrl();
    const sonarWorkingDirectory = getSonarWorkingDirectory();
    const globalConfigDirectory = getGlobalConfigDirectory();

    if (missing.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Faltan campos globales requeridos: ${missing.join(', ')}`
      });
    }

    const data = {
      sonarToken: String(payload.sonarToken).trim(),
      sonarWorkingDirectory,
      globalConfigDirectory
    };

    const current = await getBundle();
    const nextBundle = {
      global: data,
      projects: Array.isArray(current?.bundle?.projects) ? current.bundle.projects : []
    };

    await writeBundle(nextBundle, data.globalConfigDirectory);

    const warnings = [];

    const workingDirWarning = await buildWorkingDirectoryWarning(data.sonarWorkingDirectory);
    if (workingDirWarning) warnings.push(workingDirWarning);

    const localhostWarning = buildLocalhostWarning(sonarHostUrl);
    if (localhostWarning) warnings.push(localhostWarning);

    if (!sonarHostUrl) {
      warnings.push("No se encontró 'globalSonarHostUrl' en el archivo .env.");
    }

    const warning = warnings.length > 0 ? warnings.join(' | ') : null;
    return res.json({ success: true, ...(warning && { warning }) });
  } catch {
    return res.status(500).json({ success: false, message: 'No fue posible guardar la configuración global.' });
  }
}

async function saveTheme(req, res) {
  try {
    const theme = req.body?.theme;
    if (!['light', 'dark'].includes(theme)) {
      return res.status(400).json({ success: false, message: 'Tema inválido. Usa "light" o "dark".' });
    }
    const current = await getBundle();
    current.bundle.global.theme = theme;
    await writeBundle(current.bundle, current.directoryRelative);
    return res.json({ success: true });
  } catch {
    return res.status(500).json({ success: false, message: 'No fue posible guardar el tema.' });
  }
}

module.exports = {
  renderHome,
  getProjects,
  getGlobalConfig,
  saveGlobalConfig,
  saveTheme
};
