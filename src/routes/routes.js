const express = require('express');
const sonarController = require('../controllers/sonar/sonarController');
const sonarConfigController = require('../controllers/sonar/sonarConfigController');
const appConfigController = require('../controllers/app/appConfigController');
const gitController = require('../controllers/gitController');
const sonarScannerController = require('../controllers/sonar/sonarScannerController');
const gitleaksController = require('../controllers/gitleaks/gitleaksController');
const gitleaksScannerController = require('../controllers/gitleaks/gitleaksScannerController');
const fileExplorerController = require('../controllers/fileExplorerController');

const router = express.Router();

router.get('/', (req, res) => res.redirect('/sonar'));
router.get('/sonar', sonarController.renderSonar);
router.get('/gitleaks', gitleaksController.renderGitleaks);
router.get('/sonar_config', sonarConfigController.renderSonarConfig);
router.get('/app_config', appConfigController.renderAppConfig);

router.get('/api/projects', sonarController.getProjects);
router.get('/api/sonar/global', sonarConfigController.getGlobalConfig);
router.post('/api/sonar/global', sonarConfigController.saveGlobalConfig);
router.post('/api/theme', sonarConfigController.saveTheme);
router.post('/api/projects', sonarController.createProject);
router.put('/api/projects/:projectName', sonarController.updateProject);
router.delete('/api/projects/:projectName', sonarController.deleteProject);
router.get('/api/projects/:projectName/branches', gitController.getProjectBranches);
router.get('/api/projects/:projectName/diff-files', gitController.getProjectDiffFiles);
router.post('/api/scanner/session', sonarScannerController.createScannerSession);
router.post('/api/gitleaks/session', gitleaksScannerController.createGitleaksSession);
router.post('/explorer', fileExplorerController.renderExplorer);
router.post('/explorer/files', fileExplorerController.listFiles);

module.exports = router;
