const fs = require('node:fs/promises');
const {
  getSonarHostUrl
} = require('../../utils/envConfig');
const {
  getBundle,
  writeBundle,
  getDefaultSonarWorkingDirectory,
  getAppBundle,
  writeAppBundle
} = require('../../utils/configStore');

const REQUIRED_GLOBAL_FIELDS = [
  'sonarToken'
];

const FRONTEND_SONAR_HOST_URL = 'http://localhost:9000';

function renderSonarConfig(req, res) {
  res.render('sonar/sonar_config');
}

async function getGlobalConfig(req, res) {
  try {
    const { bundle } = await getBundle();

    const data = {
      sonarToken: String(bundle?.sonarToken || '').trim(),
      sonarHostUrl: FRONTEND_SONAR_HOST_URL
    };

    return res.json({ success: true, data });
  } catch {
    return res.status(500).json({ success: false, message: 'No fue posible obtener la configuración global.' });
  }
}

async function buildWorkingDirectoryWarning(workingDir) {
  const resolved = getDefaultSonarWorkingDirectory();

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
    const sonarHostUrl = getSonarHostUrl();

    if (missing.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Faltan campos globales requeridos: ${missing.join(', ')}`
      });
    }

    const current = await getBundle();
    const data = {
      sonarToken: String(payload.sonarToken).trim(),
      semgrepRules: typeof current?.bundle?.semgrepRules === 'string' ? current.bundle.semgrepRules : ''
    };

    const nextBundle = {
      sonarToken: data.sonarToken,
      semgrepRules: data.semgrepRules,
      projects: Array.isArray(current?.bundle?.projects) ? current.bundle.projects : []
    };

    await writeBundle(nextBundle);

    const warnings = [];

    const workingDirWarning = await buildWorkingDirectoryWarning();
    if (workingDirWarning) warnings.push(workingDirWarning);

    const localhostWarning = buildLocalhostWarning(sonarHostUrl);
    if (localhostWarning) warnings.push(localhostWarning);

    if (!sonarHostUrl) {
      warnings.push("No se encontró 'sonarHostUrl' en el archivo .env.");
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
    const { bundle: appBundle } = await getAppBundle();
    appBundle.theme = theme;
    await writeAppBundle(appBundle);
    return res.json({ success: true });
  } catch {
    return res.status(500).json({ success: false, message: 'No fue posible guardar el tema.' });
  }
}

module.exports = {
  renderSonarConfig,
  getGlobalConfig,
  saveGlobalConfig,
  saveTheme
};
