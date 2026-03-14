const { execSync } = require('child_process');
const path = require('path');

exports.default = async function(context) {
  const appPath = context.appOutDir 
    ? path.join(context.appOutDir, `${context.packager.appInfo.productName}.app`)
    : null;
  
  if (!appPath) return;
  
  try {
    console.log('Removing quarantine flags from:', appPath);
    execSync(`xattr -cr "${appPath}"`);
    console.log('Done.');
  } catch (e) {
    console.log('xattr failed (non-fatal):', e.message);
  }
};
