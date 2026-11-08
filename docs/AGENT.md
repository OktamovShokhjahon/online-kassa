# Local agent (Windows)

The agent runs on the cash-desk PC next to the browser. It prints receipts, reports and labels on an ESC/POS
thermal printer (58 mm, CP866), opens the cash drawer through the printer, and can read a serial scanner.
The POS in the browser talks to it on `ws://127.0.0.1:17890`.

## Run from source (development)

```bash
npm run dev:agent     # the agent alone
npm run dev           # everything; the agent is auto-paired to the demo shop's Kassa 1
```

Under `npm run dev` / `npm run demo` the agent keeps its state in `.devdata/agent`, prints to a file instead of
hardware (`.devdata/printed/printer.bin`, plus a readable copy of every printout in `receipts.txt` through
`KASS_AGENT_PREVIEW`), and never opens its settings window (`KASS_AGENT_NO_OPEN`).

Settings window: <http://127.0.0.1:17891>. State lives in `%APPDATA%\OnlineKassAgent` (config + encrypted secrets;
on Windows the secrets are protected with DPAPI, elsewhere with an AES key file).

## Pairing a terminal

1. Shop owner: **Terminals → (terminal) → Pairing code** in the web panel (valid for a few minutes).
2. Agent settings window: enter the server address and the code. The agent receives a long-lived token and a
   secret used to verify the POS session keys offline, plus the list of allowed web origins.
3. The printer can be chosen from the installed Windows printers (RAW spooler), a network printer
   (`host:9100`), a COM port or a file (for tests). **Print test page** verifies encoding and width.

Security properties: the local socket only accepts connections whose `Origin` is in the allowed list; the POS must
present an HMAC session key (12 h) issued by the server for that terminal; the key is verifiable without
internet, so printing keeps working offline.

## Build the executable

```bash
npm run build -w @kass/agent        # bundles to apps/agent/dist/index.js
npm run build:exe -w @kass/agent    # needs `pkg` (npm i -g @yao-pkg/pkg); outputs release/OnlineKassAgent.exe
```

`pkg` bundles Node 20 into a single `.exe`. Optional native modules (`systray2` for the tray icon, `serialport`
for COM scanners/printers) must sit next to the executable; without them the agent still works, without a tray icon
and without serial devices.

### Installer and autostart

Wrap `OnlineKassAgent.exe` in an NSIS (or Inno Setup) installer that:

* installs to `%ProgramFiles%\OnlineKassAgent`,
* adds a Startup shortcut (or a per-user `Run` registry entry) so the agent starts at logon,
* creates a Windows Firewall rule only if you need LAN access (the agent listens on loopback by default),
* signs the executable with your code-signing certificate — unsigned binaries trigger SmartScreen warnings.

## Hardware status

Verified with automated tests: ESC/POS byte output, CP866 transliteration of Uzbek characters, line wrapping at
32 characters, the local protocol, pairing and the offline session-key check.

**Not verified on real hardware:** Xprinter / other 58 mm printers, the cash-drawer pulse, and the Netum A5
scanner (it must be in USB-HID keyboard mode; the POS recognises the fast key burst, or the agent reads a
serial scanner). Plan an on-site acceptance test with the actual devices before go-live.
