document.addEventListener('DOMContentLoaded', function () {
  runButton = byId('btnRunGitleaks');
  clearConsoleButton = byId('btnClearGitleaksConsole');
  reportButton = byId('btnOpenGitleaksReport');
  downloadPdfButton = byId('btnDownloadGitleaksPdf');

  ensureTerminal();
  setRunButtonState(false);

  if (runButton) {
    runButton.addEventListener('click', runGitleaks);
  }

  if (clearConsoleButton) {
    clearConsoleButton.addEventListener('click', clearConsole);
  }

  if (reportButton) {
    reportButton.addEventListener('click', function () {
      openReportModal();
    });
  }

  if (downloadPdfButton) {
    downloadPdfButton.addEventListener('click', function () {
      downloadReportPdf();
    });
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
let runButton = null;
let clearConsoleButton = null;
let reportButton = null;
let downloadPdfButton = null;
let terminalInputDisposable = null;
let pendingRunPayload = null;
let resizeTimeoutId = null;
let latestFindingsReport = [];
let reportModalInstance = null;

function byId(id) {
  return document.getElementById(id);
}

function setRunButtonState(disabled) {
  if (runButton) {
    runButton.disabled = !!disabled;
  }
}

function setReportButtonState(disabled) {
  if (reportButton) {
    reportButton.disabled = !!disabled;
  }
}

function setDownloadPdfButtonState(disabled) {
  if (downloadPdfButton) {
    downloadPdfButton.disabled = !!disabled;
  }
}

function getReportModal() {
  const modalElement = byId('gitleaksReportModal');
  if (!modalElement || typeof bootstrap === 'undefined' || !bootstrap.Modal) return null;

  if (!reportModalInstance) {
    reportModalInstance = new bootstrap.Modal(modalElement);
  }

  return reportModalInstance;
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatGitMeta(git) {
  if (!git) return '<span class="text-muted">Sin datos de Git</span>';

  const author = escapeHtml(git.author || '');
  const email = escapeHtml(git.authorMail || '');
  const commit = escapeHtml(git.commitHash || '');
  const summary = escapeHtml(git.summary || '');
  const date = git.authorDate ? new Date(git.authorDate).toLocaleString() : '';
  const safeDate = escapeHtml(date);
  const authorEmail = email ? `&lt;${email}&gt;` : '';

  return [
    `<div><strong>Autor:</strong> ${author || 'N/A'} ${authorEmail}</div>`,
    `<div><strong>Fecha:</strong> ${safeDate || 'N/A'}</div>`,
    `<div><strong>Commit:</strong> <code>${commit || 'N/A'}</code></div>`,
    `<div><strong>Resumen:</strong> ${summary || 'N/A'}</div>`
  ].join('');
}

function renderFindingsReport(findings) {
  latestFindingsReport = Array.isArray(findings) ? findings : [];

  const body = byId('gitleaksReportBody');
  const count = byId('gitleaksReportCount');
  if (!body || !count) return;

  count.textContent = `${latestFindingsReport.length} hallazgo${latestFindingsReport.length === 1 ? '' : 's'}`;

  if (!latestFindingsReport.length) {
    body.innerHTML = '<div class="alert alert-success mb-0"><i class="bi bi-check-circle me-2"></i>No se detectaron hallazgos.</div>';
    setReportButtonState(false);
    setDownloadPdfButtonState(true);
    return;
  }

  body.innerHTML = latestFindingsReport.map(function (item, index) {
    return `
      <div class="card mb-3 border-warning-subtle">
        <div class="card-header d-flex justify-content-between align-items-center">
          <span><strong>#${index + 1}</strong> ${escapeHtml(item.ruleId || 'rule')}</span>
          <span class="badge text-bg-warning">Línea ${escapeHtml(item.line || '?')}</span>
        </div>
        <div class="card-body">
          <div class="mb-2"><strong>Archivo:</strong> <code>${escapeHtml(item.file || item.hostFile || '')}</code></div>
          <div class="mb-2"><strong>Finding:</strong> <code>${escapeHtml(item.finding || '')}</code></div>
          <div class="mb-2"><strong>Secret:</strong> <code>${escapeHtml(item.secret || '')}</code></div>
          <div class="mb-2"><strong>Fingerprint:</strong> <code>${escapeHtml(item.fingerprint || '')}</code></div>
          <hr>
          ${formatGitMeta(item.git)}
        </div>
      </div>
    `;
  }).join('');

  setReportButtonState(false);
  setDownloadPdfButtonState(false);
}

function openReportModal() {
  const modal = getReportModal();
  if (!modal) return;
  modal.show();
}

function getSafePdfName() {
  const input = byId('txtGitleaksDirectory');
  const raw = String(input?.value || 'gitleaks').trim();
  const lastPart = raw.split('/').findLast(function(part) {
    return !!part;
  }) || 'gitleaks';
  const safe = lastPart.replaceAll(/[^a-zA-Z0-9._-]+/g, '_');
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  return `gitleaks-report-${safe}-${stamp}.pdf`;
}

function addPdfLine(doc, text, x, y, pageWidth, lineHeight) {
  const maxWidth = pageWidth - (x * 2);
  const lines = doc.splitTextToSize(String(text || ''), maxWidth);
  let nextY = y;

  lines.forEach(function (line) {
    if (nextY > 280) {
      doc.addPage();
      nextY = 20;
    }

    doc.text(line, x, nextY);
    nextY += lineHeight;
  });

  return nextY;
}

function downloadReportPdf() {
  const findings = Array.isArray(latestFindingsReport) ? latestFindingsReport : [];

  if (!findings.length) {
    if (typeof Swal !== 'undefined') {
      Swal.fire({ icon: 'info', title: 'Sin hallazgos', text: 'No hay hallazgos para exportar a PDF.' });
    }
    return;
  }

  const jsPdfLib = globalThis.jspdf;
  if (!jsPdfLib || typeof jsPdfLib.jsPDF !== 'function') {
    if (typeof Swal !== 'undefined') {
      Swal.fire({ icon: 'error', title: 'PDF no disponible', text: 'No se pudo cargar la librería de PDF.' });
    }
    return;
  }

  const doc = new jsPdfLib.jsPDF({
    orientation: 'p',
    unit: 'mm',
    format: 'a4'
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  let y = 18;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text('Reporte Gitleaks - Hallazgos', 14, y);
  y += 8;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  y = addPdfLine(doc, `Generado: ${new Date().toLocaleString()}`, 14, y, pageWidth, 5);
  y = addPdfLine(doc, `Total hallazgos: ${findings.length}`, 14, y, pageWidth, 5);
  y += 2;

  findings.forEach(function (item, index) {
    if (y > 260) {
      doc.addPage();
      y = 20;
    }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    y = addPdfLine(doc, `#${index + 1} - ${item.ruleId || 'rule'}`, 14, y, pageWidth, 5);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    y = addPdfLine(doc, `Archivo: ${item.file || item.hostFile || ''}`, 14, y, pageWidth, 5);
    y = addPdfLine(doc, `Línea: ${item.line || ''}`, 14, y, pageWidth, 5);
    y = addPdfLine(doc, `Finding: ${item.finding || ''}`, 14, y, pageWidth, 5);
    y = addPdfLine(doc, `Secret: ${item.secret || ''}`, 14, y, pageWidth, 5);
    y = addPdfLine(doc, `Fingerprint: ${item.fingerprint || ''}`, 14, y, pageWidth, 5);

    const git = item.git || null;
    if (git) {
      const gitEmail = git.authorMail ? ` <${git.authorMail}>` : '';
      y = addPdfLine(doc, `Autor: ${git.author || 'N/A'}${gitEmail}`, 14, y, pageWidth, 5);
      y = addPdfLine(doc, `Fecha: ${git.authorDate ? new Date(git.authorDate).toLocaleString() : 'N/A'}`, 14, y, pageWidth, 5);
      y = addPdfLine(doc, `Commit: ${git.commitHash || 'N/A'}`, 14, y, pageWidth, 5);
      y = addPdfLine(doc, `Resumen: ${git.summary || 'N/A'}`, 14, y, pageWidth, 5);
    } else {
      y = addPdfLine(doc, 'Git: Sin datos disponibles', 14, y, pageWidth, 5);
    }

    y += 4;
    doc.setDrawColor(200, 200, 200);
    doc.line(14, y, pageWidth - 14, y);
    y += 6;
  });

  doc.save(getSafePdfName());
}

function fitTerminal(shouldNotifyResize = true) {
  if (!terminal || !fitAddon) return;

  fitAddon.fit();

  if (shouldNotifyResize) {
    sendResize();
  }
}

function ensureTerminal() {
  const terminalContainer = byId('gitleaksTerminalInner');
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

  terminal.writeln('Consola lista. Presiona Gitleaks para iniciar.');
}

function getPayload() {
  const directoryInput = byId('txtGitleaksDirectory');

  return {
    directory: directoryInput?.value || ''
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

function markRunButtonAvailable() {
  const directoryInput = byId('txtGitleaksDirectory');
  const hasDirectory = !!String(directoryInput?.value || '').trim();
  setRunButtonState(!hasDirectory);
}

function getSocketUrl() {
  const protocol = globalThis.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${globalThis.location.host}/ws/gitleaks`;
}

function sendRunGitleaks(payload) {
  if (socket?.readyState !== 1) {
    pendingRunPayload = payload;
    return;
  }

  socket.send(JSON.stringify({
    type: 'runGitleaks',
    payload
  }));
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
      sendRunGitleaks(payload);
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
      return;
    }

    if (message.type === 'report') {
      renderFindingsReport(message.findings || []);
      openReportModal();
    }
  });

  socket.addEventListener('close', function () {
    markRunButtonAvailable();
    pendingRunPayload = null;
    socket = null;
  });

  socket.addEventListener('error', function () {
    writeLine('\r\n[ERROR] No fue posible abrir la conexión WebSocket.\r\n');
    markRunButtonAvailable();
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

async function runGitleaks() {
  ensureTerminal();
  if (!terminal) return;

  const payload = getPayload();
  if (!payload.directory.trim()) {
    if (typeof Swal !== 'undefined') {
      Swal.fire({ icon: 'warning', title: 'Directorio requerido', text: 'Selecciona un directorio antes de ejecutar Gitleaks.' });
    }
    return;
  }

  setRunButtonState(false);
  setReportButtonState(true);
  setDownloadPdfButtonState(true);

  writeLine('\r\nPreparando ejecución de Gitleaks...\r\n');
  connectSocket();
  sendRunGitleaks(payload);
}
