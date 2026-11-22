// Thin wrapper around LG's webOS CLI (@webos-tools/cli, installed locally).
//
//   node scripts/tv.mjs setup <TV IP>   register the TV as device "tv" (Developer Mode, port 9922)
//   node scripts/tv.mjs key             fetch the SSH key (type the passphrase shown in the Developer Mode app)
//   node scripts/tv.mjs info            show the TV's webOS / model info
//   node scripts/tv.mjs package         dist/ -> out/<id>_<version>_all.ipk
//   node scripts/tv.mjs install         install out/<id>_<version>_all.ipk on the TV
//   node scripts/tv.mjs launch          start the app
//   node scripts/tv.mjs inspect         open Web Inspector for the running app
//   node scripts/tv.mjs extend          reset the Developer Mode session (1000 h) without touching the TV
//
// Set TV_DEVICE to use another device name than "tv".
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const device = process.env.TV_DEVICE || 'tv';
const appinfo = JSON.parse(fs.readFileSync(path.join(root, 'app/appinfo.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function ares(cmd, args) {
  const bin = path.join(root, 'node_modules/.bin', cmd);
  const res = spawnSync(bin, args, { stdio: 'inherit', cwd: root });
  if (res.error) {
    console.error(`${cmd} failed to start: ${res.error.message}. Run npm install first.`);
    process.exit(1);
  }
  if (res.status !== 0) process.exit(res.status ?? 1);
}

function ipkPath() {
  return path.join(root, 'out', `${appinfo.id}_${pkg.version}_all.ipk`);
}

const [command, arg] = process.argv.slice(2);

switch (command) {
  case 'setup': {
    if (!arg || !/^\d{1,3}(\.\d{1,3}){3}$/.test(arg)) {
      console.error('Usage: npm run tv:setup -- <TV IP address>   (TV: Settings > General > Network, or your router)');
      process.exit(1);
    }
    const list = spawnSync(path.join(root, 'node_modules/.bin/ares-setup-device'), ['--list'], { encoding: 'utf8' });
    const exists = new RegExp(`^${device}\\b`, 'm').test(list.stdout || '');
    ares('ares-setup-device', [
      exists ? '-m' : '-a',
      device,
      '-i', `host=${arg}`,
      '-i', 'port=9922',
      '-i', 'username=prisoner',
      ...(exists ? [] : ['-i', 'default=true']),
    ]);
    ares('ares-setup-device', ['--list']);
    console.log('\nNext: in the TV Developer Mode app turn "Key Server" ON, then run: npm run tv:key');
    break;
  }
  case 'key':
    ares('ares-novacom', ['--device', device, '--getkey']);
    console.log('\nKey saved. Check the connection with: npm run tv:info');
    break;
  case 'info':
    ares('ares-device', ['--system-info', '--device', device]);
    break;
  case 'package':
    fs.mkdirSync(path.join(root, 'out'), { recursive: true });
    // App + the JS service that relays GraphQL with a Korean Accept-Language.
    ares('ares-package', ['--no-minify', 'dist', 'service', '-o', 'out']);
    console.log(`\n${path.relative(root, ipkPath())}`);
    break;
  case 'install':
    if (!fs.existsSync(ipkPath())) {
      console.error(`${path.relative(root, ipkPath())} not found. Run npm run package first.`);
      process.exit(1);
    }
    ares('ares-install', ['--device', device, ipkPath()]);
    break;
  case 'launch':
    ares('ares-launch', ['--device', device, appinfo.id]);
    break;
  case 'inspect':
    ares('ares-inspect', ['--device', device, '--app', appinfo.id, '--open']);
    break;
  case 'extend':
    // LG's replacement for the removed ares-extend-dev (LG developer forum, 2025-12).
    ares('ares-launch', ['--device', device, 'com.palmdts.devmode', '-p', 'extend=true']);
    console.log('Developer Mode session extended (check "Remain Session" in the Developer Mode app).');
    break;
  default:
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 12).join('\n'));
    process.exit(command ? 1 : 0);
}
