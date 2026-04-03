const express = require('express');
const homeController = require('../controllers/homeController');
const gitController = require('../controllers/gitController');
const sonarController = require('../controllers/sonarController');
const scannerController = require('../controllers/scannerController');
const fileExplorerController = require('../controllers/fileExplorerController');

const router = express.Router();

router.get('/', homeController.renderHome);
router.get('/api/projects', homeController.getProjects);
router.get('/api/projects/global', homeController.getGlobalConfig);
router.post('/api/projects/global', homeController.saveGlobalConfig);
router.post('/api/projects', sonarController.createProject);
router.put('/api/projects/:projectKey', sonarController.updateProject);
router.delete('/api/projects/:projectKey', sonarController.deleteProject);
router.get('/api/projects/:projectKey/branches', gitController.getProjectBranches);
router.get('/api/projects/:projectKey/diff-files', gitController.getProjectDiffFiles);
router.post('/api/scanner/session', scannerController.createScannerSession);
router.post('/explorer', fileExplorerController.renderExplorer);
router.post('/explorer/files', fileExplorerController.listFiles);

module.exports = router;
