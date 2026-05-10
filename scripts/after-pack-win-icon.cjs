'use strict';

const fs = require('fs');
const path = require('path');
const rcedit = require('rcedit');

module.exports = async function afterPackWinIcon(context) {
  if (context.electronPlatformName !== 'win32') return;

  const exeName = `${context.packager.appInfo.productFilename}.exe`;
  const exePath = path.join(context.appOutDir, exeName);
  const iconPath = path.join(context.packager.projectDir, 'build', 'icon.ico');

  if (!fs.existsSync(exePath) || !fs.existsSync(iconPath)) {
    console.warn('[afterPack] Ícone do .exe não aplicado (arquivo ausente).', {
      exePath,
      iconPath,
    });
    return;
  }

  await rcedit(exePath, { icon: iconPath });
  console.log('[afterPack] Ícone do executável Windows aplicado:', exePath);
};
