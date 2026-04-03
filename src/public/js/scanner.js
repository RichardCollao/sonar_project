(function() {
  let terminal = null;
  let fitAddon = null;
  let socket = null;
  let scannerButton = null;
  let clearConsoleButton = null;
  let terminalInputDisposable = null;
  let pendingRunPayload = null;
  let resizeTimeoutId = null;

  function byId(id) {
    return document.getElementById(id);
  }

  function setScannerButtonState(disabled) {
    if (scannerButton) {
      scannerButton.disabled = !!disabled;
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
      terminalInputDisposable = terminal.onData(function(data) {
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
      projectKey: projectSelect?.value || '',
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

  function connectSocket() {
    if (socket?.readyState === 0 || socket?.readyState === 1) return;

    socket = new WebSocket(getSocketUrl());

    socket.addEventListener('open', function() {
      writeLine('\r\n[WebSocket conectado]\r\n');
      fitTerminal(true);
      terminal.focus();

      if (pendingRunPayload) {
        const payload = pendingRunPayload;
        pendingRunPayload = null;
        sendRunScanner(payload);
      }
    });

    socket.addEventListener('message', function(event) {
      let message = null;

      try {
        message = JSON.parse(event.data);
      } catch {
        writeLine(String(event.data || ''));
        return;
      }

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
        writeLine(`\r\n[Proceso finalizado] código=${message.exitCode}\r\n`);
      }
    });

    socket.addEventListener('close', function() {
      setScannerButtonState(false);
      pendingRunPayload = null;
    });

    socket.addEventListener('error', function() {
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
    if (!payload.projectKey) {
      if (typeof Swal !== 'undefined') {
        Swal.fire({ icon: 'warning', title: 'Proyecto requerido', text: 'Selecciona un proyecto antes de ejecutar SonarScanner.' });
      }
      return;
    }

    setScannerButtonState(false);

    writeLine('\r\nPreparando sesión de SonarScanner...\r\n');
    connectSocket();
    sendRunScanner(payload);
  }

  document.addEventListener('DOMContentLoaded', function() {
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

    globalThis.addEventListener('resize', function() {
      if (resizeTimeoutId) {
        clearTimeout(resizeTimeoutId);
      }

      resizeTimeoutId = setTimeout(function() {
        fitTerminal(true);
      }, 80);
    });
  });
})();
