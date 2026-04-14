const { getWorkspaceBaseDir } = require('../../utils/envConfig');

const renderAppConfig = (req, res) => {
    res.render('app/index', { workspaceBaseDir: getWorkspaceBaseDir() });
};

const renderToolsInfo = (req, res) => {
    res.render('app/tools');
};

module.exports = { renderAppConfig, renderToolsInfo };
