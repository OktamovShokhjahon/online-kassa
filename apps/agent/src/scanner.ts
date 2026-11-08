/**
 * Optional serial (COM) barcode scanner. USB HID scanners such as the Netum A5 in keyboard mode
 * need no agent: the POS reads them directly (spec 9.1). A serial scanner is read here and each
 * code is forwarded to the POS as a `scan` message.
 */
export class SerialScanner {
  private port: any;
  connected = false;

  constructor(private onScan: (code: string, symbology?: string) => void) {}

  start(path: string, baudRate = 9600) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { SerialPort } = require('serialport');
      let buf = '';
      this.port = new SerialPort({ path, baudRate }, (err: Error | null) => { this.connected = !err; });
      this.port.on('data', (d: Buffer) => {
        buf += d.toString('latin1');
        const parts = buf.split(/[\r\n]+/);
        buf = parts.pop() ?? '';
        for (const code of parts.map((p) => p.trim()).filter(Boolean)) this.onScan(code);
      });
      this.port.on('close', () => (this.connected = false));
      this.port.on('error', () => (this.connected = false));
    } catch {
      this.connected = false;
    }
  }

  stop() {
    try { this.port?.close(); } catch { /* ignore */ }
  }
}
