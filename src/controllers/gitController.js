const path = require('node:path');
const { exec, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { getBundle } = require('../utils/configStore');
const { getWorkspaceBaseDir } = require('../utils/envConfig');

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const WORKSPACE_BASE_DIR = getWorkspaceBaseDir();

function isValidProjectKeyForFileName(value = '') {
  const projectKey = String(value || '').trim();
  if (!projectKey) return false;
  if (projectKey.length > 400) return false;
  if (!/^[A-Za-z0-9._:-]+$/.test(projectKey)) return false;
  return /\D/.test(projectKey);
}

function isValidGitRef(value = '') {
  const ref = String(value).trim();
  if (!ref) return false;
  if (ref.startsWith('-')) return false;
  if (ref.includes('..') || ref.includes('//')) return false;
  return /^[a-zA-Z0-9._/-]+$/.test(ref);
}

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

async function getProjectData(projectKey) {
  const { bundle } = await getBundle();
  const projects = Array.isArray(bundle?.projects) ? bundle.projects : [];

  const project = projects.find(function(item) {
    return String(item?.sonarProjectKey || '').trim() === String(projectKey || '').trim();
  });

  if (!project) {
    const error = new Error('Proyecto no encontrado.');
    error.code = 'ENOENT';
    throw error;
  }

  return project;
}

async function getProjectBranches(req, res) {
  try {
    const projectKey = req.params.projectKey;
    if (!isValidProjectKeyForFileName(projectKey)) {
      return res.status(400).json({ success: false, message: 'Proyecto inválido.' });
    }

    let projectData;
    try {
      projectData = await getProjectData(projectKey);
    } catch {
      return res.status(404).json({ success: false, message: 'Proyecto no encontrado.' });
    }

    const baseDir = resolveWorkspacePath(projectData.sonarProjectBaseDir);
    if (!baseDir) {
      return res.status(400).json({ success: false, message: 'El proyecto no tiene directorio base configurado.' });
    }

    try {
      const { stdout } = await execAsync('git branch', { cwd: baseDir });
      const currentBranchFromList = stdout
        .split('\n')
        .find(line => line.trim().startsWith('*'))
        ?.replace(/^\*\s+/, '')
        .trim() || '';

      const branches = stdout
        .split('\n')
        .map(line => line.replace(/^[*+]?\s+/, '').trim())
        .filter(Boolean);

      let baseBranch = '';
      try {
        const { stdout: defaultBranchStdout } = await execAsync('git symbolic-ref --quiet --short refs/remotes/origin/HEAD', { cwd: baseDir });
        baseBranch = String(defaultBranchStdout || '').trim().replace(/^origin\//, '');
      } catch {
        // Si no existe origin/HEAD, se usa fallback.
      }

      if (!branches.includes(baseBranch)) {
        if (branches.includes('main')) {
          baseBranch = 'main';
        } else if (branches.includes('master')) {
          baseBranch = 'master';
        } else {
          baseBranch = branches[0] || '';
        }
      }

      let currentBranch = currentBranchFromList;
      if (!currentBranch) {
        try {
          const { stdout: currentBranchStdout } = await execAsync('git branch --show-current', { cwd: baseDir });
          currentBranch = String(currentBranchStdout || '').trim();
        } catch {
          // Si no se puede obtener la rama actual, se mantiene vacío.
        }
      }

      if (!branches.includes(currentBranch)) {
        currentBranch = '';
      }

      return res.json({ success: true, data: branches, baseBranch, currentBranch });
    } catch {
      return res.status(500).json({
        success: false,
        message: `No fue posible obtener las ramas. Verifique que el directorio sea un repositorio git válido. Ruta evaluada: ${baseDir}`
      });
    }
  } catch {
    return res.status(500).json({ success: false, message: 'Error interno del servidor.' });
  }
}

async function getProjectDiffFiles(req, res) {
  try {
    const projectKey = req.params.projectKey;
    const base = String(req.query.base || '').trim();
    const compare = String(req.query.compare || '').trim();

    if (!isValidProjectKeyForFileName(projectKey)) {
      return res.status(400).json({ success: false, message: 'Proyecto inválido.' });
    }

    if (!isValidGitRef(base) || !isValidGitRef(compare)) {
      return res.status(400).json({ success: false, message: 'Ramas inválidas.' });
    }

    let projectData;
    try {
      projectData = await getProjectData(projectKey);
    } catch {
      return res.status(404).json({ success: false, message: 'Proyecto no encontrado.' });
    }

    const baseDir = resolveWorkspacePath(projectData.sonarProjectBaseDir);
    if (!baseDir) {
      return res.status(400).json({ success: false, message: 'El proyecto no tiene directorio base configurado.' });
    }

    try {
      const { stdout } = await execFileAsync('git', ['diff', '--name-only', `${base}..${compare}`], { cwd: baseDir });
      const files = stdout
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);

      return res.json({ success: true, data: files });
    } catch {
      return res.status(500).json({
        success: false,
        message: `No fue posible obtener diferencias entre ramas. Ruta evaluada: ${baseDir}`
      });
    }
  } catch {
    return res.status(500).json({ success: false, message: 'Error interno del servidor.' });
  }
}

module.exports = {
  getProjectBranches,
  getProjectDiffFiles
};
