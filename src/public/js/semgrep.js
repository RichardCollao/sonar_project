document.addEventListener('DOMContentLoaded', function () {
  scannerButton = byId('btnSemgrepScanner');
  clearConsoleButton = byId('btnClearSemgrepConsole');
  downloadPdfButton = byId('btnDownloadSemgrepPdf');

  globalThis.updateSemgrepPdfButtonState = updateSemgrepPdfButtonState;

  ensureTerminal();

  if (scannerButton) {
    scannerButton.addEventListener('click', runScanner);
  }

  if (clearConsoleButton) {
    clearConsoleButton.addEventListener('click', clearConsole);
  }

  if (downloadPdfButton) {
    downloadPdfButton.addEventListener('click', downloadReportPdf);
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
let downloadPdfButton = null;
let terminalInputDisposable = null;
let pendingRunPayload = null;
let resizeTimeoutId = null;
let semgrepPdfReadyProject = '';
let activeScanProjectName = '';
let runOutputBuffer = '';
let latestSemgrepReport = null;

function byId(id) {
  return document.getElementById(id);
}

function setScannerButtonState(disabled) {
  if (scannerButton) {
    scannerButton.disabled = !!disabled;
  }
}

function setDownloadPdfButtonState(disabled) {
  if (downloadPdfButton) {
    downloadPdfButton.disabled = !!disabled;
  }
}

function updateSemgrepPdfButtonState() {
  const selectedProject = String(byId('selSemgrepProject')?.value || '').trim();
  const hasReport = Array.isArray(latestSemgrepReport?.results) && latestSemgrepReport.results.length >= 0;
  const pdfEnabled = !!selectedProject && selectedProject === semgrepPdfReadyProject && hasReport;
  setDownloadPdfButtonState(!pdfEnabled);
}

function setPdfButtonReadyProject(projectName) {
  semgrepPdfReadyProject = String(projectName || '').trim();
  updateSemgrepPdfButtonState();
}

function resetReportState() {
  latestSemgrepReport = null;
  runOutputBuffer = '';
  setPdfButtonReadyProject('');
}

function fitTerminal(shouldNotifyResize = true) {
  if (!terminal || !fitAddon) return;

  fitAddon.fit();

  if (shouldNotifyResize) {
    sendResize();
  }
}

function ensureTerminal() {
  const terminalContainer = byId('semgrepTerminalInner');
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

  terminal.writeln('Consola lista. Presiona SemgrepScanner para iniciar.');
}

function getPayload() {
  return {
    projectName: byId('selSemgrepProject')?.value || '',
    txtSources: byId('txtSemgrepSources')?.value || '',
    txtExclusions: byId('txtSemgrepExclusions')?.value || '',
    configFlags: getSelectedSemgrepConfigFlags()
  };
}

function getSelectedSemgrepConfigFlags() {
  const nodes = document.querySelectorAll('.semgrep-config-flag');
  const values = [];

  nodes.forEach(function (input) {
    if (!input.checked) return;

    let raw = '';
    if (typeof input.value === 'string' && input.value) {
      raw = input.value;
    } else if (input.dataset && typeof input.dataset.configValue === 'string') {
      raw = input.dataset.configValue;
    }

    const normalized = String(raw || '').trim();
    if (normalized) {
      values.push(normalized);
    }
  });

  return values;
}

function writeLine(line) {
  if (!terminal) return;
  terminal.write(line);
}

function clearConsole() {
  if (!terminal) return;

  terminal.clear();
  terminal.focus();
  terminal.writeln('Consola lista. Presiona SemgrepScanner para iniciar.');
}

function getSocketUrl() {
  const protocol = globalThis.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${globalThis.location.host}/ws/semgrep`;
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

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
  }

  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first < 0 || last < 0 || last <= first) return null;

  const candidate = raw.slice(first, last + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function captureSemgrepReportFromOutput() {
  const report = extractJsonObject(runOutputBuffer);
  if (!report || typeof report !== 'object') {
    latestSemgrepReport = { results: [] };
    return;
  }

  latestSemgrepReport = {
    ...report,
    results: Array.isArray(report.results) ? report.results : []
  };
}

function getSafePdfName() {
  const selectedProject = String(byId('selSemgrepProject')?.value || 'semgrep').trim() || 'semgrep';
  const safe = selectedProject.replaceAll(/[^a-zA-Z0-9._-]+/g, '_');
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  return `semgrep-report-${safe}-${stamp}.pdf`;
}

function addPdfLine(doc, text, x, y, pageWidth, lineHeight) {
  const maxWidth = pageWidth - (x * 2);
  const lines = doc.splitTextToSize(String(text || ''), maxWidth);
  let nextY = y;

  lines.forEach(function(line) {
    if (nextY > 280) {
      doc.addPage();
      nextY = 20;
    }

    doc.text(line, x, nextY);
    nextY += lineHeight;
  });

  return nextY;
}

function truncateTextToWidth(doc, text, maxWidth) {
  const original = String(text || '');
  if (!original) return '';

  if (doc.getTextWidth(original) <= maxWidth) {
    return original;
  }

  const ellipsis = '…';
  let trimmed = original;

  while (trimmed.length > 1 && doc.getTextWidth(trimmed + ellipsis) > maxWidth) {
    trimmed = trimmed.slice(0, -1);
  }

  return trimmed + ellipsis;
}

function drawSectionChip(doc, text, x, y, width, height, style) {
  const fillColor = Array.isArray(style?.fillColor) ? style.fillColor : [241, 245, 249];
  const textColor = Array.isArray(style?.textColor) ? style.textColor : [51, 65, 85];

  doc.setFillColor(fillColor[0], fillColor[1], fillColor[2]);
  doc.roundedRect(x, y, width, height, 1.5, 1.5, 'F');
  doc.setTextColor(textColor[0], textColor[1], textColor[2]);
  doc.text(String(text || ''), x + 2.5, y + 4.6);
  doc.setTextColor(0, 0, 0);
}

function getSeverityStyle(severity) {
  const normalized = String(severity || 'INFO').toUpperCase();
  if (normalized === 'ERROR') {
    return { label: 'ERROR', fillColor: [254, 226, 226], textColor: [127, 29, 29] };
  }
  if (normalized === 'WARNING') {
    return { label: 'WARNING', fillColor: [255, 237, 213], textColor: [124, 45, 18] };
  }
  return { label: normalized || 'INFO', fillColor: [219, 234, 254], textColor: [30, 64, 175] };
}

function getResultHeaderStyle(totalFindings) {
  if (totalFindings === 0) {
    return {
      title: 'ANÁLISIS LIMPIO',
      subtitle: 'No se detectaron hallazgos de Semgrep.',
      fillColor: [220, 252, 231],
      textColor: [22, 101, 52]
    };
  }

  if (totalFindings <= 10) {
    return {
      title: 'ANÁLISIS CON HALLAZGOS',
      subtitle: 'Se detectaron hallazgos que requieren revisión.',
      fillColor: [254, 249, 195],
      textColor: [113, 63, 18]
    };
  }

  return {
    title: 'ANÁLISIS CON HALLAZGOS IMPORTANTES',
    subtitle: 'Se detectó un volumen alto de hallazgos.',
    fillColor: [254, 226, 226],
    textColor: [127, 29, 29]
  };
}

function downloadReportPdf() {
  const report = latestSemgrepReport && typeof latestSemgrepReport === 'object'
    ? latestSemgrepReport
    : { results: [] };
  const results = Array.isArray(report.results) ? report.results : [];

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
  doc.setFontSize(18);
  doc.setTextColor(51, 65, 85);
  y = addPdfLine(doc, 'Reporte de Seguridad - Semgrep', 14, y, pageWidth, 8);
  y += 3;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(75, 85, 99);
  y = addPdfLine(doc, `Generado: ${new Date().toLocaleString('es-CL', { hour12: false })}`, 14, y, pageWidth, 5);
  y += 5;

  const headerStyle = getResultHeaderStyle(results.length);
  doc.setFillColor(headerStyle.fillColor[0], headerStyle.fillColor[1], headerStyle.fillColor[2]);
  doc.roundedRect(14, y - 4, pageWidth - 28, 16, 2, 2, 'F');
  doc.setTextColor(headerStyle.textColor[0], headerStyle.textColor[1], headerStyle.textColor[2]);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text(headerStyle.title, 17, y + 2.5);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(headerStyle.subtitle, 17, y + 8.5);
  doc.setTextColor(0, 0, 0);
  y += 20;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(51, 65, 85);
  y = addPdfLine(doc, 'Resumen', 14, y, pageWidth, 6);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(75, 85, 99);
  y = addPdfLine(doc, `Total de hallazgos: ${results.length}`, 14, y, pageWidth, 5);
  y += 8;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(51, 65, 85);
  y = addPdfLine(doc, 'Hallazgos', 14, y, pageWidth, 6);

  if (results.length === 0) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(75, 85, 99);
    y = addPdfLine(doc, 'No se encontraron hallazgos en el escaneo.', 14, y, pageWidth, 5);
    doc.save(getSafePdfName());
    return;
  }

  results.forEach(function(item, index) {
    const checkId = String(item?.check_id || 'N/A');
    const filePath = String(item?.path || 'N/A');
    const line = item?.start?.line ? String(item.start.line) : 'N/A';
    const message = String(item?.extra?.message || 'Sin descripción');
    const severity = String(item?.extra?.severity || 'INFO');
    const severityStyle = getSeverityStyle(severity);

    const cardX = 14;
    const cardWidth = pageWidth - 28;
    const chipHeight = 6;
    const lineHeight = 5;
    const textX = 18;
    const textMaxWidth = pageWidth - (textX * 2);

    const messageLines = doc.splitTextToSize(`Descripción: ${message}`, textMaxWidth);
    const fileLines = doc.splitTextToSize(`Archivo: ${filePath}`, textMaxWidth);
    const lineLines = doc.splitTextToSize(`Línea: ${line}`, textMaxWidth);
    const cardHeight = 16 + (messageLines.length + fileLines.length + lineLines.length) * lineHeight;

    if (y + cardHeight > 280) {
      doc.addPage();
      y = 20;
    }

    doc.setFillColor(248, 250, 252);
    doc.roundedRect(cardX, y, cardWidth, cardHeight, 2, 2, 'F');
    doc.setDrawColor(226, 232, 240);
    doc.roundedRect(cardX, y, cardWidth, cardHeight, 2, 2, 'S');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(75, 85, 99);
    doc.text(`${index + 1}.`, cardX + 2, y + 8.5);
    doc.setTextColor(0, 0, 0);

    drawSectionChip(doc, severityStyle.label, cardX + 10, y + 3, 24, chipHeight, severityStyle);

    const chipLeftX = cardX + 36;
    const chipRightPadding = 4;
    const maxChipWidth = cardWidth - (chipLeftX - cardX) - chipRightPadding;
    const baseChipWidth = Math.max(24, doc.getTextWidth(checkId) + 6);
    const finalChipWidth = Math.min(baseChipWidth, maxChipWidth);
    const availableChipTextWidth = finalChipWidth - 5; // padding interno aproximado
    const chipText = truncateTextToWidth(doc, checkId, availableChipTextWidth);

    drawSectionChip(doc, chipText, chipLeftX, y + 3, finalChipWidth, chipHeight, {
      fillColor: [241, 245, 249],
      textColor: [51, 65, 85]
    });

    let textY = y + 13;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(51, 65, 85);

    messageLines.forEach(function(lineText) {
      doc.text(lineText, textX, textY);
      textY += lineHeight;
    });

    fileLines.forEach(function(lineText) {
      doc.text(lineText, textX, textY);
      textY += lineHeight;
    });

    lineLines.forEach(function(lineText) {
      doc.text(lineText, textX, textY);
      textY += lineHeight;
    });

    y += cardHeight + 4;
  });

  doc.save(getSafePdfName());
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
      sendRunScanner(payload);
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
      runOutputBuffer += String(message.data || '');
      writeLine(message.data || '');
      return;
    }

    if (message.type === 'info') {
      writeLine(message.message || '');
      return;
    }

    if (message.type === 'error') {
      writeLine(`\r\n[ERROR] ${message.message || 'Error desconocido'}\r\n`);
      setScannerButtonState(false);
      setPdfButtonReadyProject('');
      return;
    }

    if (message.type === 'exit') {
      writeLine(`\r\n[Proceso finalizado] código=${message.exitCode}\r\n`);
      captureSemgrepReportFromOutput();
      setPdfButtonReadyProject(activeScanProjectName);
      activeScanProjectName = '';
      setScannerButtonState(false);
    }
  });

  socket.addEventListener('close', function () {
    const hasProject = !!String(byId('selSemgrepProject')?.value || '').trim();
    setScannerButtonState(!hasProject);
    pendingRunPayload = null;
    socket = null;
  });

  socket.addEventListener('error', function () {
    writeLine('\r\n[ERROR] No fue posible abrir la conexión WebSocket.\r\n');
    const hasProject = !!String(byId('selSemgrepProject')?.value || '').trim();
    setScannerButtonState(!hasProject);
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

function runScanner() {
  ensureTerminal();
  if (!terminal) return;

  const payload = getPayload();

  if (!payload.projectName) {
    if (typeof Swal !== 'undefined') {
      Swal.fire({ icon: 'warning', title: 'Nombre de proyecto requerido', text: 'Selecciona un nombre de proyecto antes de ejecutar SemgrepScanner.' });
    }
    return;
  }

  const selectedConfigsCount = Array.isArray(payload.configFlags) ? payload.configFlags.length : 0;
  if (selectedConfigsCount > 10 && typeof Swal !== 'undefined') {
    Swal.fire({
      icon: 'info',
      title: 'Muchas configuraciones seleccionadas',
      text: 'Has seleccionado muchas configuraciones de reglas. Esto puede hacer que el análisis sea más lento y genere más falsos positivos.',
      confirmButtonText: 'Continuar de todos modos'
    });
  }

  setScannerButtonState(true);
  activeScanProjectName = String(payload.projectName || '').trim();
  resetReportState();
  writeLine('\r\nPreparando ejecución de SemgrepScanner...\r\n');

  connectSocket();
  sendRunScanner(payload);
}
