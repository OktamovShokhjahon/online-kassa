import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The device token and session secret are stored encrypted on the PC (spec 9.3). */
export interface SecretStore {
  encrypt(plain: string): string;
  decrypt(blob: string): string;
}

/** AES-256-GCM with a random key kept in a user-only file next to the config. */
export class AesSecretStore implements SecretStore {
  private key: Buffer;
  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    const keyFile = path.join(dir, 'agent.key');
    if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600 });
    this.key = fs.readFileSync(keyFile);
  }
  encrypt(plain: string) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return 'aes:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
  }
  decrypt(blob: string) {
    const buf = Buffer.from(blob.replace(/^aes:/, ''), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  }
}

/** Windows DPAPI (current user) through PowerShell: only this Windows user on this PC can decrypt. */
export class DpapiSecretStore implements SecretStore {
  private ps(script: string, input: string) {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input, encoding: 'utf8', windowsHide: true }).trim();
  }
  encrypt(plain: string) {
    return 'dpapi:' + this.ps('$s = [Console]::In.ReadToEnd(); ConvertFrom-SecureString (ConvertTo-SecureString $s -AsPlainText -Force)', plain);
  }
  decrypt(blob: string) {
    return this.ps(
      '$s = ConvertTo-SecureString ([Console]::In.ReadToEnd().Trim()); [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))',
      blob.replace(/^dpapi:/, ''),
    );
  }
}

export function createSecretStore(dir: string): SecretStore {
  if (process.platform === 'win32' && process.env.KASS_AGENT_NO_DPAPI !== '1') {
    const dpapi = new DpapiSecretStore();
    const aes = new AesSecretStore(dir);
    // decrypts whichever format a blob has, writes DPAPI
    return { encrypt: (p) => dpapi.encrypt(p), decrypt: (b) => (b.startsWith('aes:') ? aes.decrypt(b) : dpapi.decrypt(b)) };
  }
  return new AesSecretStore(dir);
}

export function agentDir(): string {
  return process.env.KASS_AGENT_DIR ?? path.join(process.env.APPDATA ?? path.join(os.homedir(), '.config'), 'OnlineKassAgent');
}

/** Stable per-PC id sent at pairing. */
export function machineId(): string {
  const macs = Object.values(os.networkInterfaces()).flat().filter((i) => i && !i.internal && i.mac !== '00:00:00:00:00:00').map((i) => i!.mac).sort();
  return crypto.createHash('sha256').update(`${os.hostname()}|${macs.join(',')}`).digest('hex').slice(0, 32);
}
