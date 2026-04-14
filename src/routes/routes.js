const express = require('express');
const sonarController = require('../controllers/sonar/sonarController');
const sonarConfigController = require('../controllers/sonar/sonarConfigController');
const sonarReportController = require('../controllers/sonar/sonarReportController');
const semgrepController = require('../controllers/semgrep/semgrepController');
const semgrepConfigController = require('../controllers/semgrep/semgrepConfigController');
const semgrepScannerController = require('../controllers/semgrep/semgrepScannerController');
const appConfigController = require('../controllers/app/appConfigController');
const gitController = require('../controllers/gitController');
const sonarScannerController = require('../controllers/sonar/sonarScannerController');
const gitleaksController = require('../controllers/gitleaks/gitleaksController');
const gitleaksScannerController = require('../controllers/gitleaks/gitleaksScannerController');
const fileExplorerController = require('../controllers/fileExplorerController');

const router = express.Router();

router.get('/', (req, res) => res.redirect('/sonar'));
router.get('/sonar', sonarController.renderSonar);
router.get('/semgrep', semgrepController.renderSemgrep);
router.get('/gitleaks', gitleaksController.renderGitleaks);
router.get('/sonar_config', sonarConfigController.renderSonarConfig);
router.get('/semgrep_config', semgrepConfigController.renderSemgrepConfig);
router.get('/app_config', appConfigController.renderAppConfig);
router.get('/tools_info', appConfigController.renderToolsInfo);

router.get('/api/projects', sonarController.getProjects);
router.get('/api/sonar/report/pdf', sonarReportController.downloadSonarReportPdf);
router.get('/api/sonar/global', sonarConfigController.getGlobalConfig);
router.post('/api/sonar/global', sonarConfigController.saveGlobalConfig);
router.get('/api/semgrep/global', semgrepConfigController.getGlobalConfig);
router.post('/api/semgrep/global', semgrepConfigController.saveGlobalConfig);
router.get('/api/semgrep/default-rules', semgrepConfigController.getDefaultRules);
router.post('/api/theme', sonarConfigController.saveTheme);
router.post('/api/projects', sonarController.createProject);
router.put('/api/projects/:projectName', sonarController.updateProject);
router.delete('/api/projects/:projectName', sonarController.deleteProject);
router.get('/api/projects/:projectName/branches', gitController.getProjectBranches);
router.get('/api/projects/:projectName/diff-files', gitController.getProjectDiffFiles);
router.post('/api/scanner/session', sonarScannerController.createScannerSession);
router.post('/api/semgrep/session', semgrepScannerController.createSemgrepSession);
router.post('/api/gitleaks/session', gitleaksScannerController.createGitleaksSession);
router.post('/explorer', fileExplorerController.renderExplorer);
router.post('/explorer/files', fileExplorerController.listFiles);

module.exports = router;
