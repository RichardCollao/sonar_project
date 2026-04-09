
document.addEventListener('DOMContentLoaded', function () {
  scannerButton = byId('btnScanner');
  clearConsoleButton = byId('btnClearScannerConsole');

  ensureTerminal();
  connectSocket();
  setScannerButtonState(false);

  if (scannerButton) {
    scannerButton.addEventListener('click', runScanner);
  }

  if (clearConsoleButton) {
    clearConsoleButton.addEventListener('click', clearConsole);
  }

  globalThis.addEventListener('resize', function () {
    if (resizeTimeoutId) {
      clearTimeout(resizeTimeoutId);
    }

    resizeTimeoutId = setTimeout(function () {
      fitTerminal(true);
    }, 80);
  });
});


let terminal = null;
let fitAddon = null;
let socket = null;
let scannerButton = null;
let clearConsoleButton = null;
let terminalInputDisposable = null;
let pendingRunPayload = null;
let resizeTimeoutId = null;
let activeScanProjectName = '';

function byId(id) {
  return document.getElementById(id);
}

function setScannerButtonState(disabled) {
  if (scannerButton) {
    scannerButton.disabled = !!disabled;
  }
}

function setPdfButtonReadyProject(projectName) {
  console.log('setPdfButtonReadyProject called with:', projectName);
  globalThis.sonarPdfReadyProjectName = String(projectName || '').trim();
  console.log('sonarPdfReadyProjectName set to:', globalThis.sonarPdfReadyProjectName);

  if (typeof globalThis.updateOpenSonarButtonState === 'function') {
    console.log('Calling updateOpenSonarButtonState');
    globalThis.updateOpenSonarButtonState();
  } else {
    console.error('updateOpenSonarButtonState function not found');
  }
}

function fitTerminal(shouldNotifyResize = true) {
  if (!terminal || !fitAddon) return;

  fitAddon.fit();

  if (shouldNotifyResize) {
    sendResize();
  }
}

function ensureTerminal() {
  const terminalContainer = byId('scannerTerminalInner');
  if (!terminalContainer) return;

  if (terminal) return;

  if (typeof Terminal === 'undefined') {
    terminalContainer.innerHTML = '<div class="text-danger p-2">xterm.js no está disponible.</div>';
    return;
  }

  terminal = new Terminal({
    convertEol: true,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 20000,
    fontFamily: 'Menlo, Monaco, Consolas, "Courier New", monospace',
    fontSize: 13,
    theme: {
      background: '#0f172a',
      foreground: '#e2e8f0',
      scrollbarSliderBackground: '#4a6080',
      scrollbarSliderHoverBackground: '#5c7599',
      scrollbarSliderActiveBackground: '#6e8ab2'
    }
  });

  if (typeof FitAddon !== 'undefined' && typeof FitAddon.FitAddon === 'function') {
    fitAddon = new FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);
  }

  terminal.open(terminalContainer);
  fitTerminal(false);

  if (!terminalInputDisposable) {
    terminalInputDisposable = terminal.onData(function (data) {
      if (socket?.readyState !== 1) return;

      socket.send(JSON.stringify({
        type: 'input',
        data
      }));
    });
  }

  terminal.writeln('Consola lista. Presiona SonarScanner para iniciar.');
}

function getPayload() {
  const projectSelect = byId('selProject');
  const txtSources = byId('txtSources');
  const txtExclusions = byId('txtExclusions');

  return {
    projectName: projectSelect?.value || '',
    txtSources: txtSources?.value || '',
    txtExclusions: txtExclusions?.value || ''
  };
}

function writeLine(line) {
  if (!terminal) return;
  terminal.write(line);
}

function clearConsole() {
  if (!terminal) return;

  terminal.clear();
  terminal.focus();

  if (socket?.readyState === 1) {
    socket.send(JSON.stringify({
      type: 'input',
      data: '\f'
    }));
    return;
  }

  terminal.write('$ ');
}

function getSocketUrl() {
  const protocol = globalThis.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${globalThis.location.host}/ws/scanner`;
}

function sendRunScanner(payload) {
  if (socket?.readyState !== 1) {
    pendingRunPayload = payload;
    return;
  }

  socket.send(JSON.stringify({
    type: 'runScanner',
    payload
  }));
}

function sendRunPreparedSession(sessionId) {
  const payload = { sessionId };

  if (socket?.readyState !== 1) {
    pendingRunPayload = payload;
    return;
  }

  socket.send(JSON.stringify({
    type: 'runScanner',
    payload
  }));
}

async function prepareScannerSession(payload) {
  const response = await fetch('/api/scanner/session', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (!response.ok || !data?.success) {
    throw new Error(data?.message || 'No fue posible preparar la sesión de SonarScanner.');
  }

  return data.data || {};
}

function connectSocket() {
  if (socket?.readyState === 0 || socket?.readyState === 1) return;

  socket = new WebSocket(getSocketUrl());

  socket.addEventListener('open', function () {
    writeLine('\r\n[WebSocket conectado]\r\n');
    fitTerminal(true);
    terminal.focus();

    if (pendingRunPayload) {
      const payload = pendingRunPayload;
      pendingRunPayload = null;

      if (payload?.sessionId) {
        sendRunPreparedSession(payload.sessionId);
      } else {
        sendRunScanner(payload);
      }
    }
  });

  socket.addEventListener('message', function (event) {
    let message = null;

    try {
      message = JSON.parse(event.data);
    } catch {
      writeLine(String(event.data || ''));
      return;
    }

    console.log('Scanner WebSocket message received:', message);

    if (message.type === 'output') {
      writeLine(message.data || '');
      return;
    }

    if (message.type === 'info') {
      writeLine(message.message || '');
      return;
    }

    if (message.type === 'error') {
      writeLine(`\r\n[ERROR] ${message.message || 'Error desconocido'}\r\n`);
      return;
    }

    if (message.type === 'exit') {
      console.log('Exit message received:', { exitCode: message.exitCode, activeScanProjectName });
      writeLine(`\r\n[Proceso finalizado] código=${message.exitCode}\r\n`);

      setScannerButtonState(false);

      if (Number(message.exitCode) === 0) {
        console.log('Setting PDF button ready for project:', activeScanProjectName);
        setPdfButtonReadyProject(activeScanProjectName);
      } else {
        console.log('Scanner failed, disabling PDF button');
        setPdfButtonReadyProject('');
      }

      activeScanProjectName = '';
    }
  });

  socket.addEventListener('close', function () {
    setScannerButtonState(false);
    pendingRunPayload = null;
  });

  socket.addEventListener('error', function () {
    writeLine('\r\n[ERROR] No fue posible abrir la conexión WebSocket.\r\n');
    setScannerButtonState(false);
  });
}

function sendResize() {
  if (!terminal || socket?.readyState !== 1) return;

  socket.send(JSON.stringify({
    type: 'resize',
    cols: terminal.cols,
    rows: terminal.rows
  }));
}

async function runScanner() {
  ensureTerminal();
  if (!terminal) return;

  const payload = getPayload();
  if (!payload.projectName) {
    if (typeof Swal !== 'undefined') {
      Swal.fire({ icon: 'warning', title: 'Nombre de proyecto requerido', text: 'Selecciona un nombre de proyecto antes de ejecutar SonarScanner.' });
    }
    return;
  }

  activeScanProjectName = String(payload.projectName || '').trim();
  setPdfButtonReadyProject('');
  setScannerButtonState(true);

  writeLine('\r\nPreparando sesión de SonarScanner...\r\n');

  try {
    const session = await prepareScannerSession(payload);

    if (session?.sonarProjectCreated && typeof Swal !== 'undefined' && typeof Swal.fire === 'function') {
      await Swal.fire({
        icon: 'info',
        title: 'Proyecto creado en SonarQube',
        text: `Se creó en SonarQube el proyecto con nombre ${session.projectName || payload.projectName}. Pulsa Aceptar para continuar con el análisis.`,
        confirmButtonText: 'Aceptar',
        allowOutsideClick: false,
        allowEscapeKey: false
      });
    }

    connectSocket();
    sendRunPreparedSession(session.sessionId);
  } catch (error) {
    writeLine(`\r\n[ERROR] ${error?.message || 'No fue posible preparar SonarScanner.'}\r\n`);

    if (typeof Swal !== 'undefined' && typeof Swal.fire === 'function') {
      Swal.fire({
        icon: 'error',
        title: 'Error',
        text: error?.message || 'No fue posible preparar SonarScanner.'
      });
    }

    activeScanProjectName = '';
    setScannerButtonState(false);
  }
}