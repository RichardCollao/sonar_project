const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');
const { getWorkspaceBaseDir } = require('../../utils/envConfig');
const { resolveWorkspacePath } = require('../../utils/configStore');

const SESSION_TTL_MS = 60 * 1000;
const gitleaksSessions = new Map();
const WORKSPACE_BASE_DIR = path.resolve(getWorkspaceBaseDir());
const GITLEAKS_WORKSPACE_BASE_DIR = '/workspace';

let gitleaksWss = null;

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

function assertInsideWorkspace(absolutePath) {
  const resolved = path.resolve(absolutePath);
  const isInsideWorkspace = resolved === WORKSPACE_BASE_DIR
    || resolved.startsWith(`${WORKSPACE_BASE_DIR}${path.sep}`);

  if (!isInsideWorkspace) {
    const error = new Error(`La ruta debe estar dentro de ${WORKSPACE_BASE_DIR}.`);
    error.status = 400;
    throw error;
  }
}

function toPosixPath(value) {
  return String(value || '').split(path.sep).join('/');
}

function toContainerWorkspacePath(hostAbsolutePath) {
  const resolvedHostPath = path.resolve(hostAbsolutePath);
  const relative = path.relative(WORKSPACE_BASE_DIR, resolvedHostPath);
  const normalizedRelative = toPosixPath(relative || '').replace(/^\/+/, '');

  if (!normalizedRelative) {
    return GITLEAKS_WORKSPACE_BASE_DIR;
  }

  return `${GITLEAKS_WORKSPACE_BASE_DIR}/${normalizedRelative}`;
}

async function buildGitleaksConfig(payload) {
  const selectedDirectory = String(payload.directory || payload.sourceDirectory || '').trim();

  if (!selectedDirectory) {
    const error = new Error('Debe seleccionar un directorio antes de ejecutar Gitleaks.');
    error.status = 400;
    throw error;
  }

  const sourceDirectory = resolveWorkspacePath(selectedDirectory);
  assertInsideWorkspace(sourceDirectory);
  await ensureDirectoryExists(sourceDirectory, 'Directorio seleccionado');

  const sourceContainerDirectory = toContainerWorkspacePath(sourceDirectory);
  const gitleaksShellScript = [
    "if gitleaks dir --help | grep -q -- '--no-git'; then",
    '  gitleaks dir --no-git "$1" --verbose;',
    'else',
    '  gitleaks dir "$1" --verbose;',
    'fi'
  ].join(' ');

  const args = [
    'exec',
    '-i',
    'gitleaks',
    'sh',
    '-lc',
    gitleaksShellScript,
    '--',
    sourceContainerDirectory
  ];

  return {
    sourceDirectory,
    sourceContainerDirectory,
    displayCommand: buildDisplayCommand(args),
    rawCommand: buildRawCommand(args)
  };
}

function createSessionData(config) {
  const sessionId = randomUUID();
  const payload = {
    ...config,
    createdAt: Date.now()
  };

  const timeoutId = setTimeout(function() {
    gitleaksSessions.delete(sessionId);
  }, SESSION_TTL_MS);

  gitleaksSessions.set(sessionId, {
    payload,
    timeoutId
  });

  return sessionId;
}

function consumeSession(sessionId) {
  const entry = gitleaksSessions.get(sessionId);
  if (!entry) return null;

  clearTimeout(entry.timeoutId);
  gitleaksSessions.delete(sessionId);
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

async function createGitleaksSession(req, res) {
  try {
    const config = await buildGitleaksConfig(req.body || {});
    const sessionId = createSessionData(config);

    return res.status(201).json({
      success: true,
      data: {
        sessionId,
        wsPath: '/ws/gitleaks'
      }
    });
  } catch (error) {
    return res.status(error?.status || 500).json({
      success: false,
      message: error?.message || 'No fue posible preparar la sesión de Gitleaks.'
    });
  }
}

function initGitleaksWebSocket(server) {
  if (gitleaksWss) return gitleaksWss;

  gitleaksWss = new WebSocketServer({ noServer: true });

  gitleaksWss.on('connection', function(ws, request) {
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
        cwd: process.cwd(),
        env: {
          ...process.env,
          SHELL: shell
        }
      });
    } catch (error) {
      sendSocketMessage(ws, {
        type: 'error',
        message: `No fue posible iniciar Gitleaks: ${error?.message || 'error desconocido'}`
      });
      ws.close(1011, 'spawn-error');
      return;
    }

    if (session) {
      sendSocketMessage(ws, {
        type: 'info',
        message: `Iniciando Gitleaks para ${session.sourceDirectory}...\r\n`
      });

      sendSocketMessage(ws, {
        type: 'info',
        message: `$ ${session.displayCommand}\r\n\r\n`
      });

      scannerProcess.write(`${session.rawCommand}\r`);
    }

    scannerProcess.onData(function(chunk) {
      sendSocketMessage(ws, { type: 'output', data: chunk });
    });

    scannerProcess.onExit(function(event) {
      const exitCode = Number.isFinite(event?.exitCode) ? event.exitCode : 1;

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

      if (message?.type === 'runGitleaks') {
        (async function() {
          try {
            const config = await buildGitleaksConfig(message.payload || {});

            sendSocketMessage(ws, {
              type: 'info',
              message: `Iniciando Gitleaks para ${config.sourceDirectory}...\r\n`
            });

            sendSocketMessage(ws, {
              type: 'info',
              message: `$ ${config.displayCommand}\r\n\r\n`
            });

            scannerProcess.write(`${config.rawCommand}\r`);
          } catch (error) {
            sendSocketMessage(ws, {
              type: 'error',
              message: error?.message || 'No fue posible ejecutar Gitleaks.'
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

  return gitleaksWss;
}

module.exports = {
  createGitleaksSession,
  initGitleaksWebSocket
};
