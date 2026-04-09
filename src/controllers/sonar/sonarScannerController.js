const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');
const { getSonarHostUrl } = require('../../utils/envConfig');
const {
  getBundle,
  resolveWorkspacePath
} = require('../../utils/configStore');
const SESSION_TTL_MS = 60 * 1000;
const scannerSessions = new Map();

let scannerWss = null;

function buildAuthHeader(sonarToken) {
  const token = String(sonarToken || '').trim();
  const credentials = Buffer.from(`${token}:`, 'utf8').toString('base64');
  return `Basic ${credentials}`;
}

function normalizeHostUrl(hostUrl) {
  return String(hostUrl || '').trim().replace(/\/+$/, '');
}

async function getFromSonarApi(sonarHostUrl, sonarToken, endpoint, payload = {}) {
  const host = normalizeHostUrl(sonarHostUrl);
  const url = new URL(`${host}${endpoint}`);

  Object.entries(payload).forEach(function([key, value]) {
    if (value === undefined || value === null) return;
    const normalized = String(value).trim();
    if (!normalized) return;
    url.searchParams.set(key, normalized);
  });

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: buildAuthHeader(sonarToken),
      Accept: 'application/json'
    }
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

async function postToSonarApi(sonarHostUrl, sonarToken, endpoint, payload = {}) {
  const host = normalizeHostUrl(sonarHostUrl);
  const url = new URL(`${host}${endpoint}`);

  const requestBody = new URLSearchParams();
  Object.entries(payload).forEach(function([key, value]) {
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

function extractSonarErrorMessage(body) {
  if (!body) return '';

  if (typeof body === 'string') {
    return body.trim();
  }

  if (Array.isArray(body.errors)) {
    const messages = body.errors
      .map(function(item) { return String(item?.msg || '').trim(); })
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

function isSonarProjectAlreadyExistsError(error) {
  if (!error?.status) return false;

  const message = extractSonarErrorMessage(error.body).toLowerCase();
  if (!message) return false;

  return message.includes('already exists')
    || message.includes('similar key already exists')
    || message.includes('ya existe')
    || message.includes('clave similar ya existe');
}

async function ensureSonarProjectExists(projectKey, sonarHostUrl, sonarToken) {
  const response = await getFromSonarApi(
    sonarHostUrl,
    sonarToken,
    '/api/projects/search',
    { projects: projectKey, ps: '1' }
  );

  const components = Array.isArray(response?.components) ? response.components : [];
  const exists = components.some(function(component) {
    return String(component?.key || '').trim() === String(projectKey || '').trim();
  });

  if (exists) {
    return { created: false };
  }

  try {
    await postToSonarApi(
      sonarHostUrl,
      sonarToken,
      '/api/projects/create',
      { project: projectKey, name: projectKey }
    );

    return { created: true };
  } catch (error) {
    if (isSonarProjectAlreadyExistsError(error)) {
      return { created: false };
    }

    const sonarMessage = extractSonarErrorMessage(error.body);
    const message = sonarMessage
      ? `No fue posible crear en SonarQube el nombre de proyecto: ${sonarMessage}`
      : 'No fue posible crear en SonarQube el nombre de proyecto.';

    const wrapped = new Error(message);
    wrapped.status = error?.status || 500;
    throw wrapped;
  }
}

function isValidProjectKey(value = '') {
  const projectKey = String(value || '').trim();
  if (!projectKey) return false;
  if (projectKey.length > 400) return false;
  if (!/^[A-Za-z0-9._:-]+$/.test(projectKey)) return false;
  return /\D/.test(projectKey);
}

function normalizeList(rawValue = '') {
  return String(rawValue || '')
    .split(/[\n,]/)
    .map(function(item) { return item.trim(); })
    .filter(Boolean)
    .join(',');
}

async function readGlobalConfig() {
  const { bundle } = await getBundle();
  return bundle?.global || {};
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

async function ensureDirectoryExists(targetPath, label) {
  const resolved = path.resolve(targetPath);
  try {
    const stats = await fs.stat(resolved);
    if (!stats.isDirectory()) {
      const error = new Error(`${label} no es un directorio válido.`);
      error.status = 400;
      throw error;
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      try {
        await fs.mkdir(resolved, { recursive: true });
      } catch (mkdirError) {
        const createFailed = new Error(`${label} no existe y no se pudo crear: ${resolved} — ${mkdirError.message}`);
        createFailed.status = 500;
        throw createFailed;
      }
      return;
    }

    throw error;
  }
}

function buildScannerArgs(input) {
  const args = [
    `-Dsonar.projectKey=${input.projectKey}`,
    `-Dsonar.projectBaseDir=${input.projectBaseDir}`,
    `-Dsonar.working.directory=${input.workingDirectory}`,
    `-Dsonar.host.url=${input.sonarHostUrl}`,
    `-Dsonar.token=${input.sonarToken}`
  ];

  if (input.sources) {
    args.push(`-Dsonar.sources=${input.sources}`);
  }

  if (input.exclusions) {
    args.push(`-Dsonar.exclusions=${input.exclusions}`);
  }

  return args;
}

function resolveRuntimeSonarHostUrl(rawHostUrl) {
  const hostUrl = String(rawHostUrl || '').trim();
  if (!hostUrl) return hostUrl;

  try {
    const parsed = new URL(hostUrl);
    const localhostNames = new Set(['localhost', '127.0.0.1', '::1']);

    if (localhostNames.has(String(parsed.hostname || '').toLowerCase())) {
      parsed.hostname = 'sonarqube';
      return parsed.toString().replace(/\/+$/, '');
    }

    return hostUrl;
  } catch {
    return hostUrl;
  }
}

function quoteForShell(value) {
  const raw = String(value || '');
  if (!raw) return "''";

  if (/^[a-zA-Z0-9_./:=,@-]+$/.test(raw)) {
    return raw;
  }

  const escaped = raw.split("'").join(String.raw`'\''`);
  return "'" + escaped + "'";
}

function sanitizeArgForDisplay(arg) {
  const raw = String(arg || '');
  if (raw.startsWith('-Dsonar.token=')) {
    return '-Dsonar.token=********';
  }

  return raw;
}

function buildDisplayCommand(args = []) {
  const safeArgs = args.map(function(arg) {
    return quoteForShell(sanitizeArgForDisplay(arg));
  });

  return `sonar-scanner ${safeArgs.join(' ')}`.trim();
}

function buildRawCommand(args = []) {
  const safeArgs = args.map(function(arg) {
    return quoteForShell(arg);
  });

  return `sonar-scanner ${safeArgs.join(' ')}`.trim();
}

function createSessionData(config) {
  const sessionId = randomUUID();
  const payload = {
    ...config,
    createdAt: Date.now()
  };

  const timeoutId = setTimeout(function() {
    scannerSessions.delete(sessionId);
  }, SESSION_TTL_MS);

  scannerSessions.set(sessionId, {
    payload,
    timeoutId
  });

  return sessionId;
}

function consumeSession(sessionId) {
  const entry = scannerSessions.get(sessionId);
  if (!entry) return null;

  clearTimeout(entry.timeoutId);
  scannerSessions.delete(sessionId);
  return entry.payload;
}

function parseSocketMessage(raw) {
  try {
    return JSON.parse(String(raw || ''));
  } catch {
    return null;
  }
}

function sendSocketMessage(ws, message) {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify(message));
}


function resolveWorkingDir(globalConfig, projectConfig) {
  const globalWorkingDir = resolveWorkspacePath(globalConfig.sonarWorkingDirectory);
  if (globalWorkingDir) return globalWorkingDir;

  return resolveWorkspacePath(projectConfig.projectBaseDir);
}

async function resolveShellCwd(session) {
  const sessionWorkingDirectory = String(session?.workingDirectory || '').trim();

  if (sessionWorkingDirectory) {
    return path.resolve(sessionWorkingDirectory);
  }

  try {
    const globalConfig = await readGlobalConfig();
    const globalWorkingDirectory = resolveWorkspacePath(globalConfig.sonarWorkingDirectory);

    if (globalWorkingDirectory) {
      await ensureDirectoryExists(globalWorkingDirectory, 'sonarWorkingDirectory');
      return globalWorkingDirectory;
    }
  } catch {
  }

  return process.cwd();
}

async function buildScannerConfig(payload) {
  const projectKey = String(payload.projectName || payload.projectKey || '').trim();
  if (!isValidProjectKey(projectKey)) {
    const error = new Error('Debe seleccionar un nombre de proyecto válido.');
    error.status = 400;
    throw error;
  }

  let projectConfig;
  let globalConfig;

  try {
    projectConfig = await readProjectConfig(projectKey);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const notFound = new Error('No existe la configuración del nombre de proyecto seleccionado.');
      notFound.status = 404;
      throw notFound;
    }

    throw error;
  }

  try {
    globalConfig = await readGlobalConfig();
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const notFound = new Error('No existe la configuración global.');
      notFound.status = 404;
      throw notFound;
    }

    throw error;
  }

  const sonarToken = String(globalConfig.sonarToken || '').trim();
  const sonarHostUrl = getSonarHostUrl();
  const projectBaseDir = resolveWorkspacePath(projectConfig.projectBaseDir);
  const workingDirectory = resolveWorkingDir(globalConfig, projectConfig);

  if (!sonarToken || !sonarHostUrl || !projectBaseDir || !workingDirectory) {
    const error = new Error('Configuración incompleta. Verifique token, host, directorio proyecto y sonarWorkingDirectory.');
    error.status = 400;
    throw error;
  }

  await ensureDirectoryExists(projectBaseDir, 'directorio proyecto');
  await ensureDirectoryExists(workingDirectory, 'sonarWorkingDirectory');

  const sources = normalizeList(payload.txtSources);
  const exclusions = normalizeList(payload.txtExclusions);
  const sonarProjectState = await ensureSonarProjectExists(projectKey, sonarHostUrl, sonarToken);
  const scannerArgs = buildScannerArgs({
    projectKey,
    projectBaseDir,
    workingDirectory,
    sonarHostUrl,
    sonarToken,
    sources,
    exclusions
  });

  return {
    projectKey,
    sonarProjectCreated: !!sonarProjectState.created,
    projectBaseDir,
    sonarHostUrl,
    sonarToken,
    sources,
    exclusions,
    workingDirectory,
    displayCommand: buildDisplayCommand(scannerArgs),
    rawCommand: buildRawCommand(scannerArgs)
  };
}

async function createScannerSession(req, res) {
  try {
    const config = await buildScannerConfig(req.body || {});
    const sessionId = createSessionData(config);

    return res.status(201).json({
      success: true,
      data: {
        sessionId,
        wsPath: '/ws/scanner',
        projectName: config.projectKey,
        sonarProjectCreated: !!config.sonarProjectCreated
      }
    });
  } catch (error) {
    return res.status(error?.status || 500).json({
      success: false,
      message: error?.message || 'No fue posible preparar la sesión de SonarScanner.'
    });
  }
}

function initScannerWebSocket(server) {
  if (scannerWss) return scannerWss;

  scannerWss = new WebSocketServer({ noServer: true });

  scannerWss.on('connection', async function(ws, request) {
    const host = request.headers.host || 'localhost';
    const requestUrl = new URL(request.url || '', `http://${host}`);
    const sessionId = String(requestUrl.searchParams.get('sessionId') || '').trim();

    const session = sessionId ? consumeSession(sessionId) : null;

    if (sessionId && !session) {
      sendSocketMessage(ws, { type: 'error', message: 'Sesión inválida o expirada.' });
      ws.close(1008, 'invalid-session');
      return;
    }

    const shell = os.platform() === 'win32' ? 'cmd.exe' : '/bin/bash';

    let scannerProcess;

    try {
      scannerProcess = pty.spawn(shell, ['-i'], {
        name: 'xterm-color',
        cols: 120,
        rows: 30,
        cwd: await resolveShellCwd(session),
        env: {
          ...process.env,
          SHELL: shell
        }
      });

      console.log('Scanner process spawned with PID:', scannerProcess.pid);

      scannerProcess.on('error', function(error) {
        console.error('Scanner process error:', error);
      });
    } catch (error) {
      sendSocketMessage(ws, {
        type: 'error',
        message: `No fue posible iniciar sonar-scanner: ${error?.message || 'error desconocido'}`
      });
      ws.close(1011, 'spawn-error');
      return;
    }

    if (session) {
      sendSocketMessage(ws, {
        type: 'info',
        message: `Iniciando SonarScanner para ${session.projectKey}...\r\n`
      });

      sendSocketMessage(ws, {
        type: 'info',
        message: `$ ${session.displayCommand}\r\n\r\n`
      });

      scannerProcess.write(`${session.rawCommand}\r`);
    }

    scannerProcess.onData(function(chunk) {
      if (chunk?.includes('EXECUTION SUCCESS')) {
        console.log('Scanner success message detected:', chunk);
        
        // Send exit message manually since onExit might not fire
        setTimeout(() => {
          console.log('Manually sending exit message after EXECUTION SUCCESS');
          sendSocketMessage(ws, {
            type: 'exit',
            exitCode: 0,
            signal: null
          });
          
          if (ws.readyState === 1) {
            ws.close(1000, 'scan-finished');
          }
        }, 1000); // Wait 1 second for any remaining output
      } else if (chunk?.includes('EXECUTION FAILURE') || chunk?.includes('BUILD FAILED')) {
        console.log('Scanner failure message detected:', chunk);
        
        // Send exit message manually for failure
        setTimeout(() => {
          console.log('Manually sending exit message after EXECUTION FAILURE');
          sendSocketMessage(ws, {
            type: 'exit',
            exitCode: 1,
            signal: null
          });
          
          if (ws.readyState === 1) {
            ws.close(1000, 'scan-finished');
          }
        }, 1000);
      }
      sendSocketMessage(ws, { type: 'output', data: chunk });
    });

    scannerProcess.onExit(async function(event) {
      console.log('Scanner process onExit called:', event);
      const exitCode = Number.isFinite(event?.exitCode) ? event.exitCode : 1;
      console.log('Sending exit message with exitCode:', exitCode);

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
            const preparedSessionId = String(message?.payload?.sessionId || '').trim();
            const config = preparedSessionId
              ? consumeSession(preparedSessionId)
              : await buildScannerConfig(message.payload || {});

            if (!config) {
              throw new Error('La sesión de SonarScanner expiró o no es válida.');
            }

            sendSocketMessage(ws, {
              type: 'info',
              message: `Iniciando SonarScanner para ${config.projectKey}...\r\n`
            });

            sendSocketMessage(ws, {
              type: 'info',
              message: `$ ${config.displayCommand}\r\n\r\n`
            });

            scannerProcess.write(`${config.rawCommand}\r`);
          } catch (error) {
            sendSocketMessage(ws, {
              type: 'error',
              message: error?.message || 'No fue posible ejecutar SonarScanner.'
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
      try {
        scannerProcess.kill();
      } catch {
      }
    });
  });

  return scannerWss;
}

module.exports = {
  createScannerSession,
  initScannerWebSocket
};
