function getGlobalSonarHostUrl() {
  return String(process.env.globalSonarHostUrl || '').trim();
}

function getSonarWorkingDirectory() {
  return String(process.env.globalSonarWorkingDirectory || 'sonar/temp').trim();
}

function getGlobalConfigDirectory() {
  return String(process.env.globalConfigDirectory || 'sonar').trim();
}

module.exports = {
  getGlobalSonarHostUrl,
  getSonarWorkingDirectory,
  getGlobalConfigDirectory
};