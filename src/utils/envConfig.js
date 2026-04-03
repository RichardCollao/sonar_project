function getGlobalSonarHostUrl() {
  return String(process.env.globalSonarHostUrl || '').trim();
}

function getSonarWorkingDirectory() {
  return String(process.env.globalSonarWorkingDirectory || 'sonar/temp').trim();
}

function getGlobalConfigDirectory() {
  return String(process.env.globalConfigDirectory || 'sonar').trim();
}

function getWorkspaceBaseDir() {
  const value = String(process.env.workspaceBaseDir || '').trim().replace(/\/+$/, '');
  if (!value) {
    throw new Error('La variable de entorno workspaceBaseDir es obligatoria.');
  }
  return value;
}

module.exports = {
  getGlobalSonarHostUrl,
  getSonarWorkingDirectory,
  getGlobalConfigDirectory,
  getWorkspaceBaseDir
};