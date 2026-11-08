import { exec } from 'node:child_process';
import { ConfigStore } from './config';
import { Handlers } from './handlers';
import { LocalServer } from './localServer';
import { checkForUpdate, refreshConfig } from './pairing';
import { SerialScanner } from './scanner';
import { agentDir, createSecretStore } from './secretStore';
import { ServerLink } from './serverLink';
import { startSettingsUi } from './settingsUi';

export const AGENT_VERSION = '1.0.0';

async function main() {
  const dir = agentDir();
  const config = new ConfigStore(dir, createSecretStore(dir));
  const handlers = new Handlers(config, AGENT_VERSION);
  const local = new LocalServer(config, handlers);
  const scanner = new SerialScanner((code) => local.broadcast('scan', { barcode: code, symbology: 'serial', timestamp: new Date().toISOString() }));
  const link = new ServerLink(config, handlers, () => scanner.connected);
  let update = { available: false } as { available: boolean; version?: string; url?: string };

  const startLink = () => { link.stop(); if (config.isPaired()) link.start(); };
  link.onRevoked = () => console.warn('The server revoked this agent. Pair it again from the panel.');

  const port = await local.start();
  console.log(`Online Kass agent ${AGENT_VERSION}: POS socket on ws://127.0.0.1:${port}`);
  if (config.get().scanner?.serialPath) scanner.start(config.get().scanner!.serialPath!, config.get().scanner!.baudRate);
  startLink();

  const ui = await startSettingsUi(config, handlers, {
    onPaired: startLink,
    onUnpair: () => link.stop(),
    linkOnline: () => link.online,
    update: () => update,
  });
  const uiUrl = `http://127.0.0.1:${ui.port}/`;
  console.log(`Settings: ${uiUrl}`);

  const check = async () => { update = await checkForUpdate(config, AGENT_VERSION); if (config.isPaired()) await refreshConfig(config).catch(() => undefined); };
  void check();
  setInterval(() => void check(), 6 * 3600_000).unref();

  // Tray icon (optional dependency): "Settings" and "Quit".
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const SysTray = require('systray2').default;
    const tray = new SysTray({ menu: { icon: '', title: '', tooltip: 'Online Kass', items: [{ title: 'Settings', tooltip: 'Open settings', checked: false, enabled: true }, { title: 'Quit', tooltip: 'Quit', checked: false, enabled: true }] }, debug: false, copyDir: true });
    tray.onClick((a: any) => { if (a.seq_id === 0) exec(`start "" "${uiUrl}"`); else { local.stop(); link.stop(); process.exit(0); } });
  } catch {
    if (process.platform === 'win32' && !config.isPaired() && !process.env.KASS_AGENT_NO_OPEN) exec(`start "" "${uiUrl}"`); // first run: open the settings window
  }

  const shutdown = () => { local.stop(); link.stop(); scanner.stop(); ui.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
