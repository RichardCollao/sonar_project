const express = require('express');
const sonarController = require('../controllers/sonarController');
const sonarConfigController = require('../controllers/sonarConfigController');
const appConfigController = require('../controllers/appConfigController');
const gitController = require('../controllers/gitController');
const scannerController = require('../controllers/scannerController');
const fileExplorerController = require('../controllers/fileExplorerController');

const router = express.Router();

router.get('/', (req, res) => res.redirect('/sonar'));
router.get('/sonar', sonarController.renderSonar);
router.get('/sonar_config', sonarConfigController.renderSonarConfig);
router.get('/app_config', appConfigController.renderAppConfig);

router.get('/api/projects', sonarController.getProjects);
router.get('/api/projects/global', sonarConfigController.getGlobalConfig);
router.post('/api/projects/global', sonarConfigController.saveGlobalConfig);
router.post('/api/theme', sonarConfigController.saveTheme);
router.post('/api/projects', sonarController.createProject);
router.put('/api/projects/:projectKey', sonarController.updateProject);
router.delete('/api/projects/:projectKey', sonarController.deleteProject);
router.get('/api/projects/:projectKey/branches', gitController.getProjectBranches);
router.get('/api/projects/:projectKey/diff-files', gitController.getProjectDiffFiles);
router.post('/api/scanner/session', scannerController.createScannerSession);
router.post('/explorer', fileExplorerController.renderExplorer);
router.post('/explorer/files', fileExplorerController.listFiles);

module.exports = router;
