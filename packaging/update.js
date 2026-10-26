#!/usr/bin/env node
'use strict';
// Fills in the winget manifests and the Homebrew cask for a published, signed release:
//
//   node packaging/update.js <version> [--from <folder>]
//
// Takes the release's SHA256SUMS and SHA256SUMS.sig (from GitHub, or from a folder holding both), checks the signature
// with Flick's release key (the one installed copies trust: pc/updatecore.js), and writes the version and the
// checksums it vouches for: Flick-Setup.exe into packaging/winget/manifests/m/Maniw1234/Flick/<version>/, the two Mac
// disk images into packaging/homebrew/flick.rb. A release without Mac disk images leaves the cask as it is.
// Nothing is submitted anywhere: packaging/README.md says how.
const fs = require('fs');
const path = require('path');
const core = require('../pc/updatecore');

const REPO = 'Maniw1234/flick';
const ID = 'Maniw1234.Flick';
const MANIFEST = '1.10.0';                 // winget manifest schema
function die(msg) { console.error('update: ' + msg); process.exit(1); }

const args = process.argv.slice(2);
const version = String(args[0] || '').replace(/^v/, '');
const from = args[1] === '--from' ? args[2] : null;
if (!core.parseVersion(version) || (args.length > 1 && !from)) die('usage: node packaging/update.js <version> [--from <folder>]');
// the keys installed copies trust; tests swap in their own (as signing/sign_release.js does)
const TRUSTED = process.env.FLICK_TEST_RELEASE_KEYS ? process.env.FLICK_TEST_RELEASE_KEYS.split(',') : core.RELEASE_KEYS;

async function get(name) {
  if (from) return fs.readFileSync(path.join(from, name));
  const r = await fetch(`https://github.com/${REPO}/releases/download/v${version}/${name}`, { redirect: 'follow' });
  if (r.status !== 200) die(`${name} of v${version}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

function winget(setupSha) {
  const dir = path.join(__dirname, 'winget', 'manifests', 'm', 'Maniw1234', 'Flick');
  // one version here at a time (in winget-pkgs each version has a folder of its own)
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, version), { recursive: true });
  const head = (kind) => `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${kind}.${MANIFEST}.schema.json\n` +
    `# written by packaging/update.js ${version}\n\nPackageIdentifier: ${ID}\nPackageVersion: ${version}\n`;
  const files = {
    [`${ID}.yaml`]: head('version') + `DefaultLocale: en-US\nManifestType: version\nManifestVersion: ${MANIFEST}\n`,
    [`${ID}.installer.yaml`]: head('installer') + [
      // Flick-Setup.exe is an NSIS installer for all users (Program Files): it asks for admin rights itself
      'InstallerType: nullsoft',
      'Scope: machine',
      'InstallModes:', '  - interactive', '  - silent',
      'UpgradeBehavior: install',
      'ElevationRequirement: elevatesSelf',
      'AppsAndFeaturesEntries:', '  - DisplayName: Flick', '    Publisher: Flick', '    ProductCode: Flick',
      'Installers:',
      '  - Architecture: x64',
      `    InstallerUrl: https://github.com/${REPO}/releases/download/v${version}/Flick-Setup.exe`,
      `    InstallerSha256: ${setupSha.toUpperCase()}`,
      'ManifestType: installer', `ManifestVersion: ${MANIFEST}`, '',
    ].join('\n'),
    [`${ID}.locale.en-US.yaml`]: head('defaultLocale') + [
      'PackageLocale: en-US',
      'Publisher: Maniw1234',
      'PublisherUrl: https://github.com/Maniw1234',
      `PublisherSupportUrl: https://github.com/${REPO}/issues`,
      'PackageName: Flick',
      `PackageUrl: https://github.com/${REPO}`,
      'License: MIT',
      `LicenseUrl: https://github.com/${REPO}/blob/main/LICENSE`,
      'ShortDescription: Send files between your Android phone and your PC with a flick.',
      'Description: |-',
      '  Throw files from your Android phone onto your PC with a flick, and send PC files back to the phone. Share the',
      '  clipboard and links, sync folders, see phone notifications on the PC, and share files with any device through a',
      '  browser. Phone and PC talk directly over Wi-Fi, a USB cable, the phone\'s hotspot or Bluetooth, encrypted.',
      'Moniker: flick',
      'Tags:', '  - android', '  - file-transfer', '  - phone', '  - clipboard', '  - quick-share',
      `ReleaseNotesUrl: https://github.com/${REPO}/releases/tag/v${version}`,
      'ManifestType: defaultLocale', `ManifestVersion: ${MANIFEST}`, '',
    ].join('\n'),
  };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, version, name), text);
  console.log(`winget: manifests/m/Maniw1234/Flick/${version}/ (Flick-Setup.exe ${setupSha.slice(0, 16)}…)`);
}

function cask(arm, intel) {
  const f = path.join(__dirname, 'homebrew', 'flick.rb');
  let rb = fs.readFileSync(f, 'utf8');
  const before = rb;
  rb = rb.replace(/^(\s*version )"[^"]*"/m, `$1"${version}"`)
    .replace(/^(\s*sha256 arm:\s*)"[0-9a-f]{64}"/m, `$1"${arm}"`)
    .replace(/^(\s*intel:\s*)"[0-9a-f]{64}"/m, `$1"${intel}"`);
  if (!rb.includes(`"${version}"`) || !rb.includes(arm) || !rb.includes(intel)) die("homebrew/flick.rb doesn't have the lines this fills in");
  fs.writeFileSync(f, rb);
  console.log(`homebrew: flick.rb ${version}${rb === before ? ' (no change)' : ''} (arm64 ${arm.slice(0, 16)}…, x64 ${intel.slice(0, 16)}…)`);
}

(async () => {
  const sums = await get('SHA256SUMS');
  const sig = (await get('SHA256SUMS.sig')).toString('utf8');
  if (!core.verifyRelease(version, sums, sig, TRUSTED)) die(`v${version}'s SHA256SUMS isn't signed with Flick's release key: sign the release first (signing/sign_release.js)`);
  const list = core.parseSums(sums.toString('utf8'));
  if (!list) die("SHA256SUMS doesn't parse");
  console.log(`v${version}: SHA256SUMS is signed with Flick's release key`);
  if (!list.get('Flick-Setup.exe')) die(`Flick-Setup.exe isn't in v${version}'s SHA256SUMS`);
  winget(list.get('Flick-Setup.exe'));
  const arm = list.get('Flick-mac-arm64.dmg'), intel = list.get('Flick-mac-x64.dmg');
  if (arm && intel) cask(arm, intel);
  else console.log(`homebrew: v${version} has no Mac disk images, flick.rb left as it is`);
})().catch((e) => die(e.message));
