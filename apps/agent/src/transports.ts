import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import type { AgentConfig } from './config';

export interface Transport {
  readonly kind: string;
  send(data: Buffer): Promise<void>;
}

/** Raw TCP (port 9100) network printers. */
export class NetworkTransport implements Transport {
  readonly kind = 'network';
  constructor(private host: string, private port = 9100) {}
  send(data: Buffer) {
    return new Promise<void>((resolve, reject) => {
      const s = net.connect({ host: this.host, port: this.port, timeout: 5000 });
      s.once('connect', () => s.end(data));
      s.once('close', (err) => (err ? reject(new Error('connection closed with error')) : resolve()));
      s.once('timeout', () => { s.destroy(); reject(new Error('printer connection timed out')); });
      s.once('error', reject);
    });
  }
}

/** Appends the bytes to a file: development and automated tests. */
export class FileTransport implements Transport {
  readonly kind = 'file';
  constructor(private path: string) {}
  async send(data: Buffer) { await fs.appendFile(this.path, data); }
}

/** Serial/COM printers through the optional `serialport` package. */
export class SerialTransport implements Transport {
  readonly kind = 'serial';
  constructor(private path: string, private baudRate = 9600) {}
  async send(data: Buffer) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { SerialPort } = require('serialport');
    await new Promise<void>((resolve, reject) => {
      const port = new SerialPort({ path: this.path, baudRate: this.baudRate }, (err: Error | null) => {
        if (err) return reject(err);
        port.write(data, (e: Error | null) => (e ? reject(e) : port.drain(() => port.close(() => resolve()))));
      });
    });
  }
}

/**
 * Windows print spooler in RAW mode (OpenPrinter / StartDocPrinter / WritePrinter). This is how a
 * USB thermal printer with a Windows driver, such as the Xprinter XP-58IIL, receives ESC/POS bytes
 * without a print dialog and without native node modules.
 */
const RAW_PRINT_PS = `
param([string]$Printer)
$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class RawPrint {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)] public class DOCINFO { [MarshalAs(UnmanagedType.LPStr)] public string pDocName; [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile; [MarshalAs(UnmanagedType.LPStr)] public string pDataType; }
  [DllImport("winspool.Drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi)] public static extern bool OpenPrinter(string n, out IntPtr h, IntPtr d);
  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi)] public static extern bool StartDocPrinter(IntPtr h, int l, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFO d);
  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.Drv", SetLastError=true)] public static extern bool WritePrinter(IntPtr h, IntPtr b, int c, out int w);
}
"@
$h = [IntPtr]::Zero
if (-not [RawPrint]::OpenPrinter($Printer, [ref]$h, [IntPtr]::Zero)) { throw "Cannot open printer '$Printer'" }
$di = New-Object RawPrint+DOCINFO; $di.pDocName = 'Online Kass'; $di.pDataType = 'RAW'
[void][RawPrint]::StartDocPrinter($h, 1, $di); [void][RawPrint]::StartPagePrinter($h)
$p = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
[Runtime.InteropServices.Marshal]::Copy($bytes, 0, $p, $bytes.Length)
$w = 0; $ok = [RawPrint]::WritePrinter($h, $p, $bytes.Length, [ref]$w)
[Runtime.InteropServices.Marshal]::FreeHGlobal($p)
[void][RawPrint]::EndPagePrinter($h); [void][RawPrint]::EndDocPrinter($h); [void][RawPrint]::ClosePrinter($h)
if (-not $ok) { throw "WritePrinter failed" }
`;

const ps = (args: string[], input?: string) =>
  new Promise<string>((resolve, reject) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ...args], { windowsHide: true, timeout: 20_000 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim().split('\n')[0])) : resolve(stdout.trim()),
    );
    if (input !== undefined) child.stdin?.end(input);
  });

export class WindowsSpoolerTransport implements Transport {
  readonly kind = 'windows';
  constructor(private printerName: string) {}
  async send(data: Buffer) {
    if (process.platform !== 'win32') throw new Error('The Windows spooler transport only works on Windows');
    await ps([`& { ${RAW_PRINT_PS} } -Printer '${this.printerName.replace(/'/g, "''")}'`], data.toString('base64'));
  }
}

export async function listWindowsPrinters(): Promise<Array<{ name: string; default: boolean }>> {
  if (process.platform !== 'win32') return [];
  try {
    const out = await ps(['Get-CimInstance Win32_Printer | Select-Object Name,Default | ConvertTo-Json -Compress']);
    const parsed = JSON.parse(out || '[]');
    return (Array.isArray(parsed) ? parsed : [parsed]).map((p: any) => ({ name: p.Name, default: !!p.Default }));
  } catch {
    return [];
  }
}

export function createTransport(cfg: AgentConfig['printer']): Transport | null {
  switch (cfg.transport) {
    case 'network': return cfg.host ? new NetworkTransport(cfg.host, cfg.port ?? 9100) : null;
    case 'serial': return cfg.serialPath ? new SerialTransport(cfg.serialPath) : null;
    case 'file': return cfg.filePath ? new FileTransport(cfg.filePath) : null;
    case 'windows': return cfg.windowsName ?? cfg.printerName ? new WindowsSpoolerTransport((cfg.windowsName ?? cfg.printerName)!) : null;
  }
}
