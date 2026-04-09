const { getSonarHostUrl, getWorkspaceBaseDir } = require('../../utils/envConfig');
const {
  getBundle,
  writeBundle
} = require('../../utils/configStore');

const REQUIRED_PROJECT_FIELDS = [
  'projectName',
  'projectBaseDir'
];

function renderSonar(req, res) {
  res.render('sonar/index', { workspaceBaseDir: getWorkspaceBaseDir() });
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

function isValidProjectKeyForFileName(value = '') {
  const projectKey = String(value || '').trim();
  if (!projectKey) return false;
  if (projectKey.length > 400) return false;
  if (!/^[A-Za-z0-9._:-]+$/.test(projectKey)) return false;
  return /\D/.test(projectKey);
}

function buildAuthHeader(sonarToken) {
  const token = String(sonarToken || '').trim();
  const credentials = Buffer.from(`${token}:`, 'utf8').toString('base64');
  return `Basic ${credentials}`;
}

function normalizeHostUrl(hostUrl) {
  return String(hostUrl || '').trim().replace(/\/+$/, '');
}

async function postToSonarApi(sonarHostUrl, sonarToken, endpoint, payload = {}) {
  const host = normalizeHostUrl(sonarHostUrl);
  const url = new URL(`${host}${endpoint}`);

  const requestBody = new URLSearchParams();
  Object.entries(payload).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    const normalized = String(value).trim();
    if (!normalized) return;
    requestBody.set(key, normalized);
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: buildAuthHeader(sonarToken),
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: requestBody
  });

  const contentType = response.headers.get('content-type') || '';
  const responseBody = contentType.includes('application/json')
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const error = new Error('SonarQube API request failed');
    error.status = response.status;
    error.body = responseBody;
    throw error;
  }

  return responseBody;
}

async function resolveConfig() {
  const { bundle } = await getBundle();
  const globalConfig = bundle?.global || {};

  const sonarHostUrl = normalizeHostUrl(getSonarHostUrl());
  const sonarToken = String(globalConfig.sonarToken || '').trim();

  if (!sonarHostUrl || !sonarToken) {
    const error = new Error('Configuración global incompleta.');
    error.status = 400;
    throw error;
  }

  return { sonarHostUrl, sonarToken };
}

function extractSonarErrorMessage(body) {
  if (!body) return '';

  if (typeof body === 'string') {
    return body.trim();
  }

  if (Array.isArray(body.errors)) {
    const messages = body.errors
      .map(item => String(item?.msg || '').trim())
      .filter(Boolean);

    if (messages.length > 0) {
      return messages.join(' | ');
    }
  }

  if (typeof body.message === 'string' && body.message.trim()) {
    return body.message.trim();
  }

  return '';
}

function isSonarProjectNotFoundError(error) {
  if (!error?.status) return false;

  const message = extractSonarErrorMessage(error.body).toLowerCase();
  if (!message) return false;

  return message.includes('not found')
    || message.includes('does not exist')
    || message.includes('no existe');
}

function hasSameProjectKey(existingProject, projectKey) {
  const safeProject = existingProject || {};
  const existingKey = String(safeProject.projectName || '').trim();

  return existingKey === projectKey;
}

function findProjectIndex(projects, projectKey) {
  return projects.findIndex(function(project) {
    return String(project?.projectName || '').trim() === projectKey;
  });
}

function handleSonarError(res, error, operation) {
  if (error?.code === 'ENOENT') {
    return res.status(404).json({ success: false, message: 'Nombre de proyecto o configuración global no encontrados.' });
  }

  if (error?.status) {
    const sonarMessage = extractSonarErrorMessage(error.body);
    const message = sonarMessage
      ? `Error consultando SonarQube (${operation}): ${sonarMessage}`
      : `Error consultando SonarQube (${operation}).`;

    return res.status(error.status).json({
      success: false,
      message
    });
  }

  return res.status(500).json({ success: false, message: `No fue posible consultar SonarQube (${operation}).` });
}

async function createProject(req, res) {
  try {
    const payload = req.body || {};
    const missing = REQUIRED_PROJECT_FIELDS.filter(function(field) { return !payload[field] || !String(payload[field]).trim(); });

    if (missing.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Faltan campos requeridos: ${missing.join(', ')}`
      });
    }

    const projectKey = String(payload.projectName || '').trim();
    const projectBaseDir = String(payload.projectBaseDir || '').trim();

    if (!isValidProjectKeyForFileName(projectKey)) {
      return res.status(400).json({
        success: false,
        message: 'nombre proyecto inválido. Use solo letras, números, punto (.), guion (-), guion bajo (_) y dos puntos (:), con al menos un carácter no numérico.'
      });
    }

    const store = await getBundle();
    const projects = Array.isArray(store?.bundle?.projects) ? store.bundle.projects : [];
    const existingProjectIndex = findProjectIndex(projects, projectKey);
    const existingProject = existingProjectIndex >= 0 ? projects[existingProjectIndex] : null;

    if (existingProject) {
      if (hasSameProjectKey(existingProject, projectKey)) {
        return res.status(200).json({
          success: true,
          projectName: projectKey,
          message: 'El nombre de proyecto ya existe localmente con el mismo valor.'
        });
      }

      return res.status(409).json({
        success: false,
        message: `Ya existe una configuración local con el nombre de proyecto ${projectKey}.`
      });
    }

    const projectData = {
      projectName: projectKey,
      projectBaseDir
    };

    const nextProjects = [...projects, projectData];

    await writeBundle(
      {
        global: store.bundle.global,
        projects: nextProjects
      },
      store.bundle.global.sonarConfigPath
    );


    return res.status(201).json({
      success: true,
      projectName: projectKey,
      message: 'Nombre de proyecto guardado correctamente.'
    });
  } catch (error) {
    return res.status(error?.status || 500).json({
      success: false,
      message: error?.message || 'No fue posible guardar el nombre de proyecto.'
    });
  }
}

async function updateProject(req, res) {
  try {
    const currentProjectKey = String(req.params.projectName || '').trim();

    const payload = req.body || {};
    const missing = REQUIRED_PROJECT_FIELDS.filter(function(field) { return !payload[field] || !String(payload[field]).trim(); });

    if (missing.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Faltan campos requeridos: ${missing.join(', ')}`
      });
    }

    const nextProjectKey = String(payload.projectName || '').trim();
    const nextProjectBaseDir = String(payload.projectBaseDir || '').trim();

    if (!isValidProjectKeyForFileName(nextProjectKey)) {
      return res.status(400).json({
        success: false,
        message: 'nombre proyecto inválido. Use solo letras, números, punto (.), guion (-), guion bajo (_) y dos puntos (:), con al menos un carácter no numérico.'
      });
    }

    if (!isValidProjectKeyForFileName(currentProjectKey)) {
      return res.status(400).json({ success: false, message: 'Nombre de proyecto inválido.' });
    }

    const store = await getBundle();
    const projects = Array.isArray(store?.bundle?.projects) ? store.bundle.projects : [];
    const currentIndex = findProjectIndex(projects, currentProjectKey);

    if (currentIndex < 0) {
      return res.status(404).json({ success: false, message: 'Nombre de proyecto no encontrado.' });
    }

    const keyChanged = currentProjectKey !== nextProjectKey;

    let warningMessage = '';
    const duplicateIndex = findProjectIndex(projects, nextProjectKey);

    if (keyChanged) {
      if (duplicateIndex >= 0) {
        return res.status(409).json({
          success: false,
          message: `Ya existe un proyecto local con el nombre de proyecto ${nextProjectKey}.`
        });
      }

      const { sonarHostUrl, sonarToken } = await resolveConfig();

      try {
        await postToSonarApi(
          sonarHostUrl,
          sonarToken,
          '/api/projects/update_key',
          { from: currentProjectKey, to: nextProjectKey }
        );
      } catch (error) {
        if (!isSonarProjectNotFoundError(error)) {
          throw error;
        }

        warningMessage = `El nombre de proyecto ${currentProjectKey} no existía en SonarQube; se actualizó solo la configuración local.`;
      }
    }

    const updatedProject = {
      projectName: nextProjectKey,
      projectBaseDir: nextProjectBaseDir
    };

    const nextProjects = [...projects];
    nextProjects[currentIndex] = updatedProject;

    await writeBundle(
      {
        global: store.bundle.global,
        projects: nextProjects
      },
      store.bundle.global.sonarConfigPath
    );

    return res.json({
      success: true,
      projectName: nextProjectKey,
      message: warningMessage || 'Nombre de proyecto actualizado correctamente.'
    });
  } catch (error) {
    return handleSonarError(res, error, 'actualizar proyecto');
  }
}

async function deleteProject(req, res) {
  try {
    const projectKey = String(req.params.projectName || '').trim();

    if (!isValidProjectKeyForFileName(projectKey)) {
      return res.status(400).json({ success: false, message: 'Nombre de proyecto inválido.' });
    }

    const store = await getBundle();
    const projects = Array.isArray(store?.bundle?.projects) ? store.bundle.projects : [];
    const currentIndex = findProjectIndex(projects, projectKey);
    if (currentIndex < 0) {
      return res.status(404).json({ success: false, message: 'Nombre de proyecto no encontrado.' });
    }

    const { sonarHostUrl, sonarToken } = await resolveConfig();

    let warningMessage = '';

    try {
      await postToSonarApi(
        sonarHostUrl,
        sonarToken,
        '/api/projects/delete',
        { project: projectKey }
      );
    } catch (error) {
      if (!isSonarProjectNotFoundError(error)) {
        throw error;
      }

      warningMessage = `El nombre de proyecto ${projectKey} no existía en SonarQube; se eliminó solo la configuración local.`;
    }

    const nextProjects = projects.filter(function(item, index) {
      return index !== currentIndex;
    });

    await writeBundle(
      {
        global: store.bundle.global,
        projects: nextProjects
      },
      store.bundle.global.sonarConfigPath
    );


    return res.json({ success: true, message: warningMessage || 'Nombre de proyecto eliminado correctamente.' });
  } catch (error) {
    return handleSonarError(res, error, 'eliminar proyecto');
  }
}

module.exports = {
  renderSonar,
  getProjects,
  createProject,
  updateProject,
  deleteProject
};
