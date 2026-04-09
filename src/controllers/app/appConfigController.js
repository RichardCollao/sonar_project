const { getWorkspaceBaseDir } = require('../../utils/envConfig');

const renderAppConfig = (req, res) => {
    res.render('app/index', { workspaceBaseDir: getWorkspaceBaseDir() });
};

module.exports = { renderAppConfig };
