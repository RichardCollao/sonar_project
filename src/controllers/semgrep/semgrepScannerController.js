const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');
const { getSemgrepWorkingDirectory, getWorkspaceBaseDir } = require('../../utils/envConfig');
const { getBundle, resolveWorkspacePath } = require('../../utils/configStore');
const { readDefaultRules } = require('./semgrepConfigController');

let semgrepWss = null;
const WORKSPACE_BASE_DIR = path.resolve(getWorkspaceBaseDir());
const SEMGREP_WORKSPACE_BASE_DIR = '/workspace';

function sendSocketMessage(ws, payload) {
  if (ws?.readyState !== 1) return;
  ws.send(JSON.stringify(payload));
}

function parseSocketMessage(raw) {
  try {
    return JSON.parse(String(raw || ''));
  } catch {
    return null;
  }
}

function isValidProjectKeyForFileName(value = '') {
  const projectKey = String(value || '').trim();
  if (!projectKey) return false;
  if (projectKey.length > 400) return false;
  if (!/^[A-Za-z0-9._:-]+$/.test(projectKey)) return false;
  return /\D/.test(projectKey);
}

function normalizeList(rawValue = '') {
  if (Array.isArray(rawValue)) {
    return rawValue
      .map(function(item) { return String(item || '').trim(); })
      .filter(Boolean);
  }

  return String(rawValue || '')
    .split(/[\n,]/)
    .map(function(item) { return item.trim(); })
    .filter(Boolean);
}

function quoteForShell(value) {
  const raw = String(value || '');
  if (!raw) return "''";

  if (/^[a-zA-Z0-9_./:=,@-]+$/.test(raw)) {
    return raw;
  }

  const escaped = raw.split("'").join(String.raw`'\\''`);
  return "'" + escaped + "'";
}

function buildDisplayCommand(args = []) {
  const safeArgs = args.map(function(arg) {
    return quoteForShell(arg);
  });

  return `docker ${safeArgs.join(' ')}`.trim();
}

function buildRawCommand(args = []) {
  return buildDisplayCommand(args);
}

function toPosixPath(value) {
  return String(value || '').split(path.sep).join('/');
}

function toContainerWorkspacePath(hostAbsolutePath) {
  const resolvedHostPath = path.resolve(hostAbsolutePath);
  const relative = path.relative(WORKSPACE_BASE_DIR, resolvedHostPath);
  const normalizedRelative = toPosixPath(relative || '').replace(/^\/+/, '');

  if (!normalizedRelative) {
    return SEMGREP_WORKSPACE_BASE_DIR;
  }

  return `${SEMGREP_WORKSPACE_BASE_DIR}/${normalizedRelative}`;
}

async function ensureDirectoryExists(targetPath, label) {
  const resolved = path.resolve(targetPath);
  let stats;

  try {
    stats = await fs.stat(resolved);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const notFound = new Error(`${label} no existe.`);
      notFound.status = 400;
      throw notFound;
    }

    throw error;
  }

  if (!stats.isDirectory()) {
    const invalid = new Error(`${label} no es un directorio válido.`);
    invalid.status = 400;
    throw invalid;
  }
}

async function readProjectConfig(projectKey) {
  const { bundle } = await getBundle();
  const projects = Array.isArray(bundle?.projects) ? bundle.projects : [];

  const project = projects.find(function(item) {
    return String(item?.projectName || '').trim() === String(projectKey || '').trim();
  });

  if (!project) {
    const error = new Error('Nombre de proyecto no encontrado.');
    error.code = 'ENOENT';
    throw error;
  }

  return project;
}

async function readGlobalConfig() {
  const { bundle } = await getBundle();
  return bundle?.global || {};
}

async function buildRulesFile(workingDirectory, globalConfig) {
  const rulesContent = String(globalConfig?.semgrepRules || '').trim() || await readDefaultRules();
  const rulesFilePath = path.join(workingDirectory, `semgrep-rules-${randomUUID()}.yaml`);

  await fs.writeFile(rulesFilePath, rulesContent, 'utf8');
  return rulesFilePath;
}

function buildSemgrepArgs(config) {
  const args = [
    'exec',
    '-i',
    '-w',
    config.projectBaseDirContainer,
    'semgrep',
    'semgrep',
    'scan'
  ];

  const configFlags = Array.isArray(config.configFlags) ? config.configFlags : [];

  configFlags.forEach(function(flag) {
    const trimmed = String(flag || '').trim();
    if (!trimmed) return;
    args.push(`--config=${trimmed}`);
  });

  if (config.rulesFilePathContainer) {
    args.push('--config', config.rulesFilePathContainer);
  }

  args.push('--metrics=off', '--json');

  config.exclusions.forEach(function(exclusion) {
    args.push('--exclude', exclusion);
  });

  if (config.sources.length > 0) {
    args.push(...config.sources);
  } else {
    args.push('.');
  }

  return args;
}

async function buildScannerConfig(payload) {
  const projectKey = String(payload.projectName || '').trim();

  if (!isValidProjectKeyForFileName(projectKey)) {
    const error = new Error('Nombre de proyecto inválido.');
    error.status = 400;
    throw error;
  }

  const projectConfig = await readProjectConfig(projectKey);
  const globalConfig = await readGlobalConfig();

  const projectBaseDir = resolveWorkspacePath(projectConfig.projectBaseDir);
  const semgrepWorkingDirectory = resolveWorkspacePath(globalConfig.semgrepWorkingDirectory || getSemgrepWorkingDirectory());

  await ensureDirectoryExists(projectBaseDir, 'directorio proyecto');
  await fs.mkdir(semgrepWorkingDirectory, { recursive: true });

  const sources = normalizeList(payload.txtSources);
  const exclusions = normalizeList(payload.txtExclusions);
  const configFlags = normalizeList(payload.configFlags);
  const rulesFilePath = await buildRulesFile(semgrepWorkingDirectory, globalConfig);
  const rulesFilePathContainer = toContainerWorkspacePath(rulesFilePath);
  const projectBaseDirContainer = toContainerWorkspacePath(projectBaseDir);
  const args = buildSemgrepArgs({
    rulesFilePath,
    rulesFilePathContainer,
    projectBaseDirContainer,
    configFlags,
    sources,
    exclusions
  });

  return {
    projectKey,
    projectBaseDir,
    rulesFilePath,
    sources,
    exclusions,
    displayCommand: buildDisplayCommand(args),
    rawCommand: buildRawCommand(args)
  };
}

async function cleanupRulesFile(filePath) {
  const safePath = String(filePath || '').trim();
  if (!safePath) return;

  try {
    await fs.rm(safePath, { force: true });
  } catch {
  }
}

async function createSemgrepSession(req, res) {
  try {
    const config = await buildScannerConfig(req.body || {});
    await cleanupRulesFile(config.rulesFilePath);

    return res.status(201).json({
      success: true,
      data: {
        wsPath: '/ws/semgrep',
        projectName: config.projectKey
      }
    });
  } catch (error) {
    return res.status(error?.status || 500).json({
      success: false,
      message: error?.message || 'No fue posible preparar la sesión de Semgrep.'
    });
  }
}

function initSemgrepWebSocket(server) {
  if (semgrepWss) return semgrepWss;

  semgrepWss = new WebSocketServer({ noServer: true });

  semgrepWss.on('connection', function(ws) {
    const shell = os.platform() === 'win32' ? 'cmd.exe' : '/bin/bash';
    let scannerProcess;
    let activeRulesFilePath = '';

    function writeScanCommand(config) {
      activeRulesFilePath = config.rulesFilePath;

      sendSocketMessage(ws, {
        type: 'info',
        message: `Iniciando Semgrep para ${config.projectKey}...\r\n`
      });

      sendSocketMessage(ws, {
        type: 'info',
        message: `$ ${config.displayCommand}\r\n\r\n`
      });

      scannerProcess.write(`${config.rawCommand}; exit\r`);
    }

    try {
      scannerProcess = pty.spawn(shell, ['-i'], {
        name: 'xterm-color',
        cols: 120,
        rows: 30,
        cwd: process.cwd(),
        env: {
          ...process.env,
          SHELL: shell
        }
      });
    } catch (error) {
      sendSocketMessage(ws, {
        type: 'error',
        message: `No fue posible iniciar semgrep: ${error?.message || 'error desconocido'}`
      });
      ws.close(1011, 'spawn-error');
      return;
    }

    scannerProcess.onData(function(chunk) {
      sendSocketMessage(ws, { type: 'output', data: chunk });
    });

    scannerProcess.onExit(async function(event) {
      const exitCode = Number.isFinite(event?.exitCode) ? event.exitCode : 1;

      await cleanupRulesFile(activeRulesFilePath);
      activeRulesFilePath = '';

      sendSocketMessage(ws, {
        type: 'exit',
        exitCode,
        signal: event?.signal
      });

      if (ws.readyState === 1) {
        ws.close(1000, 'scan-finished');
      }
    });

    ws.on('message', function(raw) {
      const message = parseSocketMessage(raw);

      if (message?.type === 'resize') {
        const cols = Number(message.cols);
        const rows = Number(message.rows);

        if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
        if (cols < 20 || rows < 5) return;

        scannerProcess.resize(Math.floor(cols), Math.floor(rows));
        return;
      }

      if (message?.type === 'runScanner') {
        (async function() {
          try {
            const config = await buildScannerConfig(message.payload || {});
            writeScanCommand(config);
          } catch (error) {
            sendSocketMessage(ws, {
              type: 'error',
              message: error?.message || 'No fue posible ejecutar Semgrep.'
            });
          }
        })();
        return;
      }

      if (message?.type === 'input') {
        const data = String(message.data || '');
        if (!data) return;
        scannerProcess.write(data);
      }
    });

    ws.on('close', function() {
      cleanupRulesFile(activeRulesFilePath);
      activeRulesFilePath = '';

      try {
        scannerProcess.kill();
      } catch {
      }
    });
  });

  return semgrepWss;
}

module.exports = {
  createSemgrepSession,
  initSemgrepWebSocket
};
