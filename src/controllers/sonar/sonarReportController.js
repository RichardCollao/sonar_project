const { jsPDF } = require('jspdf');
const { getSonarHostUrl } = require('../../utils/envConfig');
const { getBundle } = require('../../utils/configStore');

const MAX_ISSUES_IN_REPORT = 1000;
const SONAR_ISSUES_PAGE_SIZE = 500;

function normalizeHostUrl(hostUrl) {
  return String(hostUrl || '').trim().replace(/\/+$/, '');
}

function buildAuthHeader(sonarToken) {
  const token = String(sonarToken || '').trim();
  const credentials = Buffer.from(`${token}:`, 'utf8').toString('base64');
  return `Basic ${credentials}`;
}

async function getFromSonarApi(sonarHostUrl, sonarToken, endpoint, params = {}) {
  const host = normalizeHostUrl(sonarHostUrl);
  const url = new URL(`${host}${endpoint}`);

  Object.entries(params).forEach(function([key, value]) {
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
  const body = contentType.includes('application/json')
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const error = new Error('SonarQube API request failed');
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
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

function getMeasureValue(measuresMap, metricKey, fallback = 'N/A') {
  const value = measuresMap.get(metricKey);
  if (value === undefined || value === null || value === '') return fallback;
  return String(value);
}

function toRatingLabel(value) {
  const score = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(score)) return 'N/A';

  const labels = {
    1: 'A',
    2: 'B',
    3: 'C',
    4: 'D',
    5: 'E'
  };

  return labels[score] || String(score);
}

function toSafeFilename(projectKey) {
  const safe = String(projectKey || 'sonar')
    .trim()
    .replaceAll(/[^a-zA-Z0-9._-]+/g, '_') || 'sonar';

  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  return `sonar-report-${safe}-${stamp}.pdf`;
}

function formatDateTime24h(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return '';

  return date.toLocaleString('es-CL', {
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function getSeverityStyle(severity) {
  const normalized = String(severity || '').trim().toUpperCase();

  if (normalized === 'BLOCKER' || normalized === 'CRITICAL') {
    return {
      label: normalized || 'N/A',
      fillColor: [254, 226, 226],
      textColor: [127, 29, 29]
    };
  }

  if (normalized === 'MAJOR') {
    return {
      label: normalized,
      fillColor: [255, 237, 213],
      textColor: [124, 45, 18]
    };
  }

  if (normalized === 'MINOR') {
    return {
      label: normalized,
      fillColor: [254, 249, 195],
      textColor: [113, 63, 18]
    };
  }

  if (normalized === 'INFO') {
    return {
      label: normalized,
      fillColor: [219, 234, 254],
      textColor: [30, 64, 175]
    };
  }

  return {
    label: normalized || 'N/A',
    fillColor: [241, 245, 249],
    textColor: [51, 65, 85]
  };
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

function getQualityGateStyle(status) {
  const normalized = String(status || '').trim().toUpperCase();

  if (normalized === 'OK' || normalized === 'PASSED') {
    return {
      label: normalized,
      fillColor: [220, 252, 231],
      textColor: [22, 101, 52]
    };
  }

  if (normalized === 'ERROR' || normalized === 'FAILED') {
    return {
      label: normalized,
      fillColor: [254, 226, 226],
      textColor: [127, 29, 29]
    };
  }

  if (normalized === 'WARN' || normalized === 'WARNING') {
    return {
      label: normalized,
      fillColor: [254, 249, 195],
      textColor: [113, 63, 18]
    };
  }

  return {
    label: normalized || 'UNKNOWN',
    fillColor: [241, 245, 249],
    textColor: [51, 65, 85]
  };
}

function getAnalysisResultStyle(status) {
  const normalized = String(status || '').trim().toUpperCase();

  if (normalized === 'OK' || normalized === 'PASSED') {
    return {
      title: 'ANÁLISIS APROBADO',
      subtitle: 'El Quality Gate fue superado.',
      fillColor: [220, 252, 231],
      textColor: [22, 101, 52]
    };
  }

  if (normalized === 'ERROR' || normalized === 'FAILED') {
    return {
      title: 'ANÁLISIS RECHAZADO',
      subtitle: 'El Quality Gate no fue superado.',
      fillColor: [254, 226, 226],
      textColor: [127, 29, 29]
    };
  }

  if (normalized === 'WARN' || normalized === 'WARNING') {
    return {
      title: 'ANÁLISIS CON ADVERTENCIAS',
      subtitle: 'Revisar condiciones del Quality Gate.',
      fillColor: [254, 249, 195],
      textColor: [113, 63, 18]
    };
  }

  return {
    title: 'ESTADO DE ANÁLISIS DESCONOCIDO',
    subtitle: 'No fue posible determinar el estado del Quality Gate.',
    fillColor: [241, 245, 249],
    textColor: [51, 65, 85]
  };
}

function getIssueTypeStyle(type) {
  const normalized = String(type || '').trim().toUpperCase();

  if (normalized === 'BUG') {
    return {
      label: normalized,
      fillColor: [254, 242, 242],
      textColor: [153, 27, 27]
    };
  }

  if (normalized === 'VULNERABILITY') {
    return {
      label: normalized,
      fillColor: [255, 237, 213],
      textColor: [124, 45, 18]
    };
  }

  if (normalized === 'CODE_SMELL') {
    return {
      label: normalized,
      fillColor: [224, 231, 255],
      textColor: [55, 48, 163]
    };
  }

  return {
    label: normalized || 'ISSUE',
    fillColor: [241, 245, 249],
    textColor: [51, 65, 85]
  };
}

function getSeverityRank(severity) {
  const normalized = String(severity || '').trim().toUpperCase();

  if (normalized === 'BLOCKER') return 1;
  if (normalized === 'CRITICAL') return 2;
  if (normalized === 'MAJOR') return 3;
  if (normalized === 'MINOR') return 4;
  if (normalized === 'INFO') return 5;

  return 99;
}

function getTypeRank(type) {
  const normalized = String(type || '').trim().toUpperCase();

  if (normalized === 'VULNERABILITY') return 1;
  if (normalized === 'BUG') return 2;
  if (normalized === 'CODE_SMELL') return 3;

  return 9;
}

async function resolveConfigAndProject(projectKey) {
  const key = String(projectKey || '').trim();

  if (!key) {
    const error = new Error('Debe seleccionar un nombre de proyecto.');
    error.status = 400;
    throw error;
  }

  const sonarHostUrl = normalizeHostUrl(getSonarHostUrl());
  const { bundle } = await getBundle();
  const global = bundle?.global || {};
  const projects = Array.isArray(bundle?.projects) ? bundle.projects : [];

  const sonarToken = String(global.sonarToken || '').trim();

  if (!sonarHostUrl || !sonarToken) {
    const error = new Error('Configuración global incompleta para SonarQube.');
    error.status = 400;
    throw error;
  }

  const localProject = projects.find(function(item) {
    return String(item?.projectName || '').trim() === key;
  });

  if (!localProject) {
    const error = new Error('Nombre de proyecto no encontrado en configuración local.');
    error.status = 404;
    throw error;
  }

  return {
    projectKey: key,
    sonarHostUrl,
    sonarToken,
    localProject
  };
}

async function fetchSonarData(config) {
  const metricKeys = [
    'bugs',
    'vulnerabilities',
    'code_smells',
    'coverage',
    'duplicated_lines_density',
    'ncloc',
    'reliability_rating',
    'security_rating',
    'sqale_rating',
    'security_hotspots',
    'security_hotspots_reviewed'
  ].join(',');

  async function fetchOpenIssuesWithLimit() {
    const normalizedLimit = Math.max(1, Number.parseInt(String(MAX_ISSUES_IN_REPORT), 10) || 1);
    const pageSize = Math.max(1, Math.min(SONAR_ISSUES_PAGE_SIZE, normalizedLimit));

    const collectedIssues = [];
    let total = 0;
    let page = 1;

    while (collectedIssues.length < normalizedLimit) {
      const issuesPage = await getFromSonarApi(config.sonarHostUrl, config.sonarToken, '/api/issues/search', {
        componentKeys: config.projectKey,
        resolved: 'false',
        ps: String(pageSize),
        p: String(page)
      });

      const pageIssues = Array.isArray(issuesPage?.issues) ? issuesPage.issues : [];
      total = Number.parseInt(String(issuesPage?.total || '0'), 10) || 0;

      if (pageIssues.length === 0) {
        break;
      }

      const remaining = normalizedLimit - collectedIssues.length;
      collectedIssues.push(...pageIssues.slice(0, remaining));

      const fetchedAllFromSonar = collectedIssues.length >= total;
      if (fetchedAllFromSonar || pageIssues.length < pageSize) {
        break;
      }

      page += 1;
    }

    return {
      total,
      issues: collectedIssues
    };
  }

  const [qualityGate, measures, issues] = await Promise.all([
    getFromSonarApi(config.sonarHostUrl, config.sonarToken, '/api/qualitygates/project_status', {
      projectKey: config.projectKey
    }),
    getFromSonarApi(config.sonarHostUrl, config.sonarToken, '/api/measures/component', {
      component: config.projectKey,
      metricKeys
    }),
    fetchOpenIssuesWithLimit()
  ]);

  return { qualityGate, measures, issues };
}

function buildPdfBuffer(payload) {
  const doc = new jsPDF({
    orientation: 'p',
    unit: 'mm',
    format: 'a4'
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  let y = 18;

  const measures = Array.isArray(payload.measures?.component?.measures)
    ? payload.measures.component.measures
    : [];

  const measureMap = new Map(
    measures.map(function(item) {
      return [String(item?.metric || ''), String(item?.value || '')];
    })
  );

  const issues = Array.isArray(payload.issues?.issues)
    ? payload.issues.issues.slice().sort(function(left, right) {
      const severityDelta = getSeverityRank(left?.severity) - getSeverityRank(right?.severity);
      if (severityDelta !== 0) return severityDelta;

      const typeDelta = getTypeRank(left?.type) - getTypeRank(right?.type);
      if (typeDelta !== 0) return typeDelta;

      const leftLine = Number.parseInt(String(left?.line || ''), 10);
      const rightLine = Number.parseInt(String(right?.line || ''), 10);
      const normalizedLeftLine = Number.isFinite(leftLine) ? leftLine : Number.MAX_SAFE_INTEGER;
      const normalizedRightLine = Number.isFinite(rightLine) ? rightLine : Number.MAX_SAFE_INTEGER;
      if (normalizedLeftLine !== normalizedRightLine) {
        return normalizedLeftLine - normalizedRightLine;
      }

      const leftComponent = String(left?.component || '').trim();
      const rightComponent = String(right?.component || '').trim();
      return leftComponent.localeCompare(rightComponent, 'es');
    })
    : [];
  const issueTotal = Number(payload.issues?.total || 0);
  const displayedIssueCount = issues.length;
  const issuesSectionTitle = issueTotal > displayedIssueCount
    ? `Issues (mostrando ${displayedIssueCount} de ${issueTotal})`
    : 'Issues';
  const qgStatus = String(payload.qualityGate?.projectStatus?.status || 'UNKNOWN');
  const analysisResultStyle = getAnalysisResultStyle(qgStatus);

  doc.setFillColor(
    analysisResultStyle.fillColor[0],
    analysisResultStyle.fillColor[1],
    analysisResultStyle.fillColor[2]
  );
  doc.roundedRect(14, y - 4, pageWidth - 28, 16, 2, 2, 'F');
  doc.setTextColor(
    analysisResultStyle.textColor[0],
    analysisResultStyle.textColor[1],
    analysisResultStyle.textColor[2]
  );
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text(analysisResultStyle.title, 17, y + 2.5);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(analysisResultStyle.subtitle, 17, y + 8.5);
  doc.setTextColor(0, 0, 0);
  y += 19;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text('Reporte SonarQube', 14, y);
  y += 8;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  y = addPdfLine(doc, `Proyecto: ${payload.projectKey}`, 14, y, pageWidth, 5);
  y = addPdfLine(doc, `Ruta local: ${payload.localProject.projectBaseDir || 'N/A'}`, 14, y, pageWidth, 5);
  y = addPdfLine(doc, `Servidor SonarQube: ${payload.sonarHostUrl}`, 14, y, pageWidth, 5);
  y = addPdfLine(doc, `Generado: ${formatDateTime24h(new Date())}`, 14, y, pageWidth, 5);
  y += 2;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  y = addPdfLine(doc, 'Resumen', 14, y, pageWidth, 6);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  const qualityGateStyle = getQualityGateStyle(qgStatus);
  const qualityGateBottomGap = 2.5;
  drawSectionChip(
    doc,
    `Quality Gate: ${qualityGateStyle.label}`,
    14,
    y - 1.8,
    60,
    6,
    qualityGateStyle
  );
  y += 6 + qualityGateBottomGap;
  y = addPdfLine(doc, `Bugs: ${getMeasureValue(measureMap, 'bugs', '0')}`, 14, y, pageWidth, 5);
  y = addPdfLine(doc, `Vulnerabilities: ${getMeasureValue(measureMap, 'vulnerabilities', '0')}`, 14, y, pageWidth, 5);
  y = addPdfLine(doc, `Security Hotspots: ${getMeasureValue(measureMap, 'security_hotspots', '0')}`, 14, y, pageWidth, 5);
  y = addPdfLine(doc, `Security Hotspots Reviewed (%): ${getMeasureValue(measureMap, 'security_hotspots_reviewed', '0')}`, 14, y, pageWidth, 5);
  y = addPdfLine(doc, `Code Smells: ${getMeasureValue(measureMap, 'code_smells', '0')}`, 14, y, pageWidth, 5);
  y = addPdfLine(doc, `Coverage (%): ${getMeasureValue(measureMap, 'coverage', '0')}`, 14, y, pageWidth, 5);
  y = addPdfLine(doc, `Duplicated Lines Density (%): ${getMeasureValue(measureMap, 'duplicated_lines_density', '0')}`, 14, y, pageWidth, 5);
  y = addPdfLine(doc, `Líneas de código (ncloc): ${getMeasureValue(measureMap, 'ncloc', '0')}`, 14, y, pageWidth, 5);
  y = addPdfLine(doc, `Reliability Rating: ${toRatingLabel(getMeasureValue(measureMap, 'reliability_rating'))}`, 14, y, pageWidth, 5);
  y = addPdfLine(doc, `Security Rating: ${toRatingLabel(getMeasureValue(measureMap, 'security_rating'))}`, 14, y, pageWidth, 5);
  y = addPdfLine(doc, `Maintainability Rating: ${toRatingLabel(getMeasureValue(measureMap, 'sqale_rating'))}`, 14, y, pageWidth, 5);
  y = addPdfLine(doc, `Issues abiertas: ${issueTotal}`, 14, y, pageWidth, 5);
  y += 3;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  y = addPdfLine(doc, issuesSectionTitle, 14, y, pageWidth, 6);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);

  if (issues.length === 0) {
    y = addPdfLine(doc, 'No se encontraron issues abiertas.', 14, y, pageWidth, 5);
  } else {
    issues.forEach(function(item, index) {
      const severity = String(item?.severity || 'N/A');
      const type = String(item?.type || 'ISSUE');
      const message = String(item?.message || '').trim() || 'Sin descripción';
      const filePath = String(item?.component || '').trim();
      const line = item?.line ? String(item.line) : 'N/A';
      const severityStyle = getSeverityStyle(severity);
      const typeStyle = getIssueTypeStyle(type);

      const cardX = 14;
      const cardWidth = pageWidth - 28;
      const cardPaddingX = 4;
      const cardPaddingTop = 4;
      const cardPaddingBottom = 3;
      const cardGap = 2.5;

      const chipStartX = cardX + cardPaddingX;
      const chipHeight = 6;
      const chipGap = 2;
      const chipRowGap = 1.8;
      const chipSidePadding = 6;
      const chipMinWidth = 24;
      const chipMaxRight = cardX + cardWidth - cardPaddingX;

      const paragraphTopGap = 5.5;
      const issueDividerTopGap = 2.5;
      const issueDividerBottomGap = 5.5;
      const textLineHeight = 5;
      const textX = cardX + cardPaddingX;
      const textMaxWidth = pageWidth - (textX * 2);

      const chips = [
        { text: `${index + 1}. ${severityStyle.label}`, style: severityStyle },
        { text: typeStyle.label, style: typeStyle }
      ].map(function(chip) {
        const label = String(chip.text || '').trim();
        const width = Math.max(chipMinWidth, doc.getTextWidth(label) + chipSidePadding);
        return {
          text: label,
          style: chip.style,
          width
        };
      });

      let measureX = chipStartX;
      let chipRows = 1;
      chips.forEach(function(chip) {
        if (measureX + chip.width > chipMaxRight) {
          chipRows += 1;
          measureX = chipStartX;
        }

        measureX += chip.width + chipGap;
      });

      const chipBlockHeight = (chipRows * chipHeight) + ((chipRows - 1) * chipRowGap);

      const messageLines = doc.splitTextToSize(`Mensaje: ${message}`, textMaxWidth);
      const fileLines = doc.splitTextToSize(`Archivo: ${filePath || 'N/A'}`, textMaxWidth);
      const lineLines = doc.splitTextToSize(`Línea: ${line}`, textMaxWidth);
      const textBlockLines = messageLines.length + fileLines.length + lineLines.length;
      const textBlockHeight = textBlockLines * textLineHeight;

      const cardHeight = cardPaddingTop
        + chipBlockHeight
        + paragraphTopGap
        + textBlockHeight
        + cardPaddingBottom;

      if (y + cardHeight > 280) {
        doc.addPage();
        y = 20;
      }

      doc.setFillColor(248, 250, 252);
      const cardY = y;
      doc.roundedRect(cardX, cardY, cardWidth, cardHeight, 2, 2, 'F');
      doc.setDrawColor(226, 232, 240);
      doc.roundedRect(cardX, cardY, cardWidth, cardHeight, 2, 2, 'S');

      let chipX = chipStartX;
      let chipY = cardY + cardPaddingTop;

      function drawIssueChip(text, style) {
        const label = String(text || '').trim();
        const computedWidth = Math.max(chipMinWidth, doc.getTextWidth(label) + chipSidePadding);

        if (chipX + computedWidth > chipMaxRight) {
          chipX = chipStartX;
          chipY += chipHeight + chipRowGap;
        }

        drawSectionChip(
          doc,
          label,
          chipX,
          chipY,
          computedWidth,
          chipHeight,
          style
        );

        chipX += computedWidth + chipGap;
      }

      chips.forEach(function(chip) {
        drawIssueChip(chip.text, chip.style);
      });

      y = chipY + chipHeight + paragraphTopGap;

      doc.setFont('helvetica', 'normal');
      y = addPdfLine(doc, `Mensaje: ${message}`, textX, y, pageWidth, textLineHeight);
      y = addPdfLine(doc, `Archivo: ${filePath || 'N/A'}`, textX, y, pageWidth, textLineHeight);
      y = addPdfLine(doc, `Línea: ${line}`, textX, y, pageWidth, textLineHeight);

      y = cardY + cardHeight;

      if (index < issues.length - 1) {
        y += issueDividerTopGap;
        doc.setDrawColor(226, 232, 240);
        doc.line(cardX, y, cardX + cardWidth, y);
        y += issueDividerBottomGap;
      } else {
        y += cardGap;
      }
    });
  }

  const pdfArrayBuffer = doc.output('arraybuffer');
  return Buffer.from(pdfArrayBuffer);
}

async function downloadSonarReportPdf(req, res) {
  try {
    const config = await resolveConfigAndProject(req.query?.projectName);
    const sonarData = await fetchSonarData(config);

    const pdfBuffer = buildPdfBuffer({
      ...config,
      ...sonarData
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${toSafeFilename(config.projectKey)}"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(pdfBuffer);
  } catch (error) {
    if (error?.status) {
      if (error.body) {
        const sonarMessage = extractSonarErrorMessage(error.body);
        const message = sonarMessage
          ? `Error consultando SonarQube para el reporte: ${sonarMessage}`
          : 'No fue posible generar el reporte PDF de Sonar.';

        return res.status(error.status).json({ success: false, message });
      }

      return res.status(error.status).json({
        success: false,
        message: error.message || 'No fue posible generar el reporte PDF de Sonar.'
      });
    }

    return res.status(500).json({
      success: false,
      message: 'No fue posible generar el reporte PDF de Sonar.'
    });
  }
}

module.exports = {
  downloadSonarReportPdf
};
