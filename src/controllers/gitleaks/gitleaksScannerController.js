const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');
const { getWorkspaceBaseDir } = require('../../utils/envConfig');
const { resolveWorkspacePath } = require('../../utils/configStore');

const SESSION_TTL_MS = 60 * 1000;
const gitleaksSessions = new Map();
const WORKSPACE_BASE_DIR = path.resolve(getWorkspaceBaseDir());
const GITLEAKS_WORKSPACE_BASE_DIR = '/workspace';
const execFileAsync = promisify(execFile);

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

async function countAccessibleFilesInDirectory(targetPath) {
  let entries;

  try {
    entries = await fs.readdir(targetPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'EACCES' || error?.code === 'EPERM' || error?.code === 'ENOENT') {
      return 0;
    }

    throw error;
  }

  let count = 0;

  for (const entry of entries) {
    const entryPath = path.join(targetPath, entry.name);

    if (entry.isDirectory()) {
      count += await countAccessibleFilesInDirectory(entryPath);
      continue;
    }

    if (entry.isFile()) {
      count += 1;
    }
  }

  return count;
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

function toHostWorkspacePath(containerAbsolutePath) {
  const raw = toPosixPath(String(containerAbsolutePath || '').trim());

  if (!raw) return '';

  if (raw === GITLEAKS_WORKSPACE_BASE_DIR || raw.startsWith(`${GITLEAKS_WORKSPACE_BASE_DIR}/`)) {
    const relative = raw.slice(GITLEAKS_WORKSPACE_BASE_DIR.length).replace(/^\/+/, '');
    return relative ? path.resolve(WORKSPACE_BASE_DIR, relative) : WORKSPACE_BASE_DIR;
  }

  return path.resolve(raw);
}

function stripAnsi(text) {
  return String(text || '').replaceAll(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function parseGitleaksFindings(rawOutput) {
  const cleanOutput = stripAnsi(rawOutput).replaceAll('\r', '');
  const lines = cleanOutput.split('\n');
  const findings = [];
  let current = null;

  const findingRegex = /^Finding:\s*(.*)$/;
  const secretRegex = /^Secret:\s*(.*)$/;
  const ruleRegex = /^RuleID:\s*(.*)$/;
  const entropyRegex = /^Entropy:\s*(.*)$/;
  const fileRegex = /^File:\s*(.*)$/;
  const lineRegex = /^Line:\s*(.*)$/;
  const fingerprintRegex = /^Fingerprint:\s*(.*)$/;

  function pushCurrent() {
    if (!current) return;

    if (current.finding || current.secret || current.ruleId || current.file) {
      findings.push({
        finding: current.finding || '',
        secret: current.secret || '',
        ruleId: current.ruleId || '',
        entropy: current.entropy || '',
        file: current.file || '',
        line: current.line || '',
        fingerprint: current.fingerprint || ''
      });
    }

    current = null;
  }

  lines.forEach(function(rawLine) {
    const line = String(rawLine || '');
    const findingMatch = findingRegex.exec(line);

    if (findingMatch) {
      pushCurrent();
      current = { finding: findingMatch[1] || '' };
      return;
    }

    if (!current) return;

    const secretMatch = secretRegex.exec(line);
    if (secretMatch) {
      current.secret = secretMatch[1] || '';
      return;
    }

    const ruleMatch = ruleRegex.exec(line);
    if (ruleMatch) {
      current.ruleId = ruleMatch[1] || '';
      return;
    }

    const entropyMatch = entropyRegex.exec(line);
    if (entropyMatch) {
      current.entropy = entropyMatch[1] || '';
      return;
    }

    const fileMatch = fileRegex.exec(line);
    if (fileMatch) {
      current.file = fileMatch[1] || '';
      return;
    }

    const lineMatch = lineRegex.exec(line);
    if (lineMatch) {
      current.line = lineMatch[1] || '';
      return;
    }

    const fingerprintMatch = fingerprintRegex.exec(line);
    if (fingerprintMatch) {
      current.fingerprint = fingerprintMatch[1] || '';
    }
  });

  pushCurrent();
  return findings;
}

async function getRepoRootForPath(targetPath, cache) {
  const normalizedPath = path.resolve(targetPath);
  const cacheKey = normalizedPath;

  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  try {
    const result = await execFileAsync('git', ['-C', normalizedPath, 'rev-parse', '--show-toplevel']);
    const root = String(result.stdout || '').trim();
    const repoRoot = root ? path.resolve(root) : null;
    cache.set(cacheKey, repoRoot);
    return repoRoot;
  } catch {
    cache.set(cacheKey, null);
    return null;
  }
}

async function getBlameMetadata(filePath, lineNumber) {
  const resolvedFile = path.resolve(filePath);
  const resolvedLine = Number.parseInt(String(lineNumber || ''), 10);

  if (!Number.isFinite(resolvedLine) || resolvedLine < 1) {
    return null;
  }

  const repoRoot = await getRepoRootForPath(path.dirname(resolvedFile), getBlameMetadata.repoCache);
  if (!repoRoot) return null;

  const relativeFilePath = path.relative(repoRoot, resolvedFile);
  if (!relativeFilePath || relativeFilePath.startsWith('..')) {
    return null;
  }

  try {
    const result = await execFileAsync('git', [
      '-C',
      repoRoot,
      'blame',
      '--porcelain',
      '-L',
      `${resolvedLine},${resolvedLine}`,
      '--',
      relativeFilePath
    ]);

    const output = String(result.stdout || '');
    const commitHash = (/^([0-9a-f]{7,40})\s/m.exec(output) || [])[1] || '';
    const author = (/^author\s+(.+)$/m.exec(output) || [])[1] || '';
    const authorMail = (/^author-mail\s+<(.+)>$/m.exec(output) || [])[1] || '';
    const authorTime = Number.parseInt((/^author-time\s+(\d+)$/m.exec(output) || [])[1] || '', 10);
    const summary = (/^summary\s+(.+)$/m.exec(output) || [])[1] || '';

    return {
      repoRoot,
      commitHash,
      author,
      authorMail,
      authorDate: Number.isFinite(authorTime) ? new Date(authorTime * 1000).toISOString() : '',
      summary
    };
  } catch {
    return null;
  }
}

getBlameMetadata.repoCache = new Map();

async function enrichFindingsWithGitMetadata(findings, sessionConfig) {
  const list = Array.isArray(findings) ? findings : [];
  if (!list.length) return [];

  const sourceContainerDirectory = String(sessionConfig?.sourceContainerDirectory || '').trim();
  const sourceHostDirectory = String(sessionConfig?.sourceDirectory || '').trim();

  const enriched = [];

  for (const finding of list) {
    const containerFilePath = String(finding.file || '').trim();
    let hostFilePath = toHostWorkspacePath(containerFilePath);

    if (!containerFilePath && sourceHostDirectory) {
      hostFilePath = sourceHostDirectory;
    }

    if (sourceContainerDirectory && containerFilePath.startsWith(`${sourceContainerDirectory}/`) && sourceHostDirectory) {
      const relative = containerFilePath.slice(sourceContainerDirectory.length).replace(/^\/+/, '');
      hostFilePath = path.resolve(sourceHostDirectory, relative);
    }

    let git = null;

    try {
      assertInsideWorkspace(hostFilePath);
      git = await getBlameMetadata(hostFilePath, finding.line);
    } catch {
      git = null;
    }

    enriched.push({
      ...finding,
      hostFile: hostFilePath,
      git
    });
  }

  return enriched;
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
  const totalFilesAnalyzed = await countAccessibleFilesInDirectory(sourceDirectory);

  const sourceContainerDirectory = toContainerWorkspacePath(sourceDirectory);
  const gitleaksShellScript = [
    'if gitleaks dir --help | grep -q -- --no-git; then',
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
    totalFilesAnalyzed,
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
    let scannerOutput = '';
    let currentScanConfig = null;

    function writeScanCommand(config) {
      currentScanConfig = config;
      scannerOutput = '';

      sendSocketMessage(ws, {
        type: 'info',
        message: `Iniciando Gitleaks para ${config.sourceDirectory}...\r\n`
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
        message: `No fue posible iniciar Gitleaks: ${error?.message || 'error desconocido'}`
      });
      ws.close(1011, 'spawn-error');
      return;
    }

    if (session) {
      writeScanCommand(session);
    }

    scannerProcess.onData(function(chunk) {
      scannerOutput += String(chunk || '');
      sendSocketMessage(ws, { type: 'output', data: chunk });
    });

    scannerProcess.onExit(async function(event) {
      const exitCode = Number.isFinite(event?.exitCode) ? event.exitCode : 1;

      try {
        const findings = parseGitleaksFindings(scannerOutput);
        const findingsWithGit = await enrichFindingsWithGitMetadata(findings, currentScanConfig || session || null);

        sendSocketMessage(ws, {
          type: 'report',
          findings: findingsWithGit,
          totalFindings: findingsWithGit.length,
          totalFilesAnalyzed: Number(currentScanConfig?.totalFilesAnalyzed || session?.totalFilesAnalyzed || 0)
        });
      } catch {
      }

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
            writeScanCommand(config);
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
