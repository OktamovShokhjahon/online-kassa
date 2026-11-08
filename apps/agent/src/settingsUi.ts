import http from 'node:http';
import type { ConfigStore } from './config';
import type { Handlers } from './handlers';
import { pair, PairingError, refreshConfig } from './pairing';
import { listWindowsPrinters } from './transports';

export interface UiHooks {
  onPaired(): void;
  onUnpair(): void;
  linkOnline(): boolean;
  update(): { available: boolean; version?: string; url?: string };
}

const T = {
  uz: { title: 'Online Kass agenti', pairing: 'Ulash', serverUrl: 'Server manzili', code: "6 xonali kod", pair: 'Ulash', paired: 'Terminal', notPaired: 'Ulanmagan', unpair: 'Uzish', printer: 'Printer', transport: 'Ulanish turi', winPrinter: 'Windows printeri', host: 'Manzil', cut: 'Qirqish', drawer: 'Kassa tortmasi', test: 'Sinov chop etish', save: 'Saqlash', status: 'Holat', online: 'Serverda', offline: 'Oflayn', update: 'Yangi versiya mavjud', lang: 'Til', ok: 'Saqlandi' },
  ru: { title: 'Агент Online Kass', pairing: 'Привязка', serverUrl: 'Адрес сервера', code: '6-значный код', pair: 'Привязать', paired: 'Терминал', notPaired: 'Не привязан', unpair: 'Отвязать', printer: 'Принтер', transport: 'Подключение', winPrinter: 'Принтер Windows', host: 'Адрес', cut: 'Отрезка', drawer: 'Денежный ящик', test: 'Тестовая печать', save: 'Сохранить', status: 'Статус', online: 'На связи', offline: 'Офлайн', update: 'Доступна новая версия', lang: 'Язык', ok: 'Сохранено' },
  en: { title: 'Online Kass agent', pairing: 'Pairing', serverUrl: 'Server address', code: '6-digit code', pair: 'Pair', paired: 'Terminal', notPaired: 'Not paired', unpair: 'Unpair', printer: 'Printer', transport: 'Connection', winPrinter: 'Windows printer', host: 'Address', cut: 'Cut', drawer: 'Cash drawer', test: 'Test print', save: 'Save', status: 'Status', online: 'Connected', offline: 'Offline', update: 'A new version is available', lang: 'Language', ok: 'Saved' },
} as const;

const page = (lang: keyof typeof T) => `<!doctype html><html><head><meta charset="utf-8"><title>${T[lang].title}</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:14px system-ui;margin:0;background:#f4f5f7;color:#1b1f24}main{max-width:560px;margin:24px auto;padding:0 16px}section{background:#fff;border:1px solid #dde1e6;border-radius:10px;padding:16px;margin-bottom:16px}h1{font-size:18px}h2{font-size:14px;margin:0 0 10px}label{display:block;margin:8px 0 2px;color:#555}input,select,button{font:inherit;padding:8px;border:1px solid #c5cad1;border-radius:6px;width:100%;box-sizing:border-box}button{background:#1d4ed8;color:#fff;border:0;cursor:pointer;margin-top:10px}button.sec{background:#e7eaee;color:#1b1f24}.row{display:flex;gap:8px}.row>*{flex:1}.ok{color:#15803d}.err{color:#b91c1c}.chk{display:flex;gap:8px;align-items:center;margin-top:8px}.chk input{width:auto}</style></head><body><main>
<h1>${T[lang].title}</h1><div id="msg"></div>
<section><h2>${T[lang].status}</h2><div id="state">…</div></section>
<section id="pairSec"><h2>${T[lang].pairing}</h2><label>${T[lang].serverUrl}</label><input id="server"><label>${T[lang].code}</label><input id="code" maxlength="6" inputmode="numeric"><button id="pairBtn">${T[lang].pair}</button><button id="unpairBtn" class="sec" style="display:none">${T[lang].unpair}</button></section>
<section><h2>${T[lang].printer}</h2><label>${T[lang].transport}</label><select id="transport"><option value="windows">Windows (USB)</option><option value="network">Network (TCP 9100)</option><option value="serial">Serial (COM)</option></select>
<div id="winBox"><label>${T[lang].winPrinter}</label><select id="winName"></select></div><div id="netBox" style="display:none"><label>${T[lang].host}</label><div class="row"><input id="host" placeholder="192.168.0.50"><input id="port" value="9100"></div></div><div id="serBox" style="display:none"><label>COM</label><input id="serialPath" placeholder="COM3"></div>
<div class="chk"><input type="checkbox" id="cut"><span>${T[lang].cut}</span></div><div class="chk"><input type="checkbox" id="drawer"><span>${T[lang].drawer}</span></div>
<div class="row"><button id="saveBtn">${T[lang].save}</button><button id="testBtn" class="sec">${T[lang].test}</button></div></section>
<section><h2>${T[lang].lang}</h2><select id="lang"><option value="uz">O'zbekcha</option><option value="ru">Русский</option><option value="en">English</option></select></section>
</main><script>
const H={'Content-Type':'application/json','X-Agent-UI':'1'};const $=id=>document.getElementById(id);
const msg=(t,e)=>{$('msg').innerHTML='<p class="'+(e?'err':'ok')+'">'+t+'</p>'};
async function api(p,b){const r=await fetch(p,b?{method:'POST',headers:H,body:JSON.stringify(b)}:{headers:H});const j=await r.json();if(!r.ok)throw new Error(j.error||r.status);return j}
function vis(){const t=$('transport').value;$('winBox').style.display=t==='windows'?'':'none';$('netBox').style.display=t==='network'?'':'none';$('serBox').style.display=t==='serial'?'':'none'}
$('transport').onchange=vis;
async function load(){const s=await api('/api/state');$('server').value=s.serverUrl;$('state').innerHTML=(s.terminal?'${T[lang].paired}: <b>'+s.terminal.name+'</b> · '+(s.online?'<span class=ok>${T[lang].online}</span>':'<span class=err>${T[lang].offline}</span>'):'${T[lang].notPaired}')+' · v'+s.version+(s.update.available?'<br><b>${T[lang].update}: '+s.update.version+'</b>':'');
$('unpairBtn').style.display=s.terminal?'':'none';$('lang').value=s.language;const p=s.printer;$('transport').value=p.transport;$('host').value=p.host||'';$('port').value=p.port||9100;$('serialPath').value=p.serialPath||'';$('cut').checked=!!p.cutEnabled;$('drawer').checked=!!p.drawerEnabled;
const list=await api('/api/printers');$('winName').innerHTML=list.map(x=>'<option'+((x.name===(p.windowsName||p.printerName))?' selected':'')+'>'+x.name+'</option>').join('');vis()}
$('pairBtn').onclick=async()=>{try{await api('/api/pair',{serverUrl:$('server').value,code:$('code').value});msg('${T[lang].ok}');load()}catch(e){msg(e.message,1)}};
$('unpairBtn').onclick=async()=>{await api('/api/unpair',{});load()};
$('saveBtn').onclick=async()=>{try{await api('/api/printer',{transport:$('transport').value,windowsName:$('winName').value,host:$('host').value,port:+$('port').value,serialPath:$('serialPath').value,cutEnabled:$('cut').checked,drawerEnabled:$('drawer').checked});msg('${T[lang].ok}')}catch(e){msg(e.message,1)}};
$('testBtn').onclick=async()=>{try{await api('/api/test-print',{});msg('${T[lang].ok}')}catch(e){msg(e.message,1)}};
$('lang').onchange=async()=>{await api('/api/language',{language:$('lang').value});location.reload()};
load().catch(e=>msg(e.message,1));setInterval(()=>load().catch(()=>{}),15000);
</script></body></html>`;

/**
 * Settings window of the agent (spec 9.2, 9.6): pairing code, printer choice and profile, test print,
 * language. Served on 127.0.0.1 only; mutating calls need a custom header (blocks cross-site forms)
 * and a loopback Host header (blocks DNS rebinding).
 */
export function startSettingsUi(config: ConfigStore, handlers: Handlers, hooks: UiHooks, port = config.get().uiPort): Promise<{ port: number; close(): void }> {
  const send = (res: http.ServerResponse, status: number, body: unknown, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    try {
      const host = String(req.headers.host ?? '').split(':')[0];
      if (!['127.0.0.1', 'localhost'].includes(host)) return send(res, 403, { error: 'forbidden' });
      const url = new URL(req.url!, 'http://x');
      const cfg = config.get();
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, page(cfg.language), 'text/html; charset=utf-8');
      if (req.headers['x-agent-ui'] !== '1') return send(res, 403, { error: 'forbidden' });
      if (req.method === 'GET' && url.pathname === '/api/state') {
        return send(res, 200, { version: handlers.version, language: cfg.language, serverUrl: cfg.serverUrl, terminal: cfg.terminal ?? null, online: hooks.linkOnline(), printer: cfg.printer, devices: handlers.status(), update: hooks.update() });
      }
      if (req.method === 'GET' && url.pathname === '/api/printers') return send(res, 200, await listWindowsPrinters());
      if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
      let raw = '';
      for await (const c of req) { raw += c; if (raw.length > 20_000) throw new Error('too large'); }
      const body = raw ? JSON.parse(raw) : {};
      switch (url.pathname) {
        case '/api/pair': {
          await pair(config, String(body.serverUrl), String(body.code), handlers.version);
          hooks.onPaired();
          return send(res, 200, { ok: true });
        }
        case '/api/unpair': config.clearCredentials(); hooks.onUnpair(); return send(res, 200, { ok: true });
        case '/api/printer': {
          config.update({ printer: { ...cfg.printer, transport: body.transport, windowsName: body.windowsName, printerName: body.windowsName, host: body.host, port: body.port, serialPath: body.serialPath, filePath: body.filePath ?? cfg.printer.filePath, cutEnabled: !!body.cutEnabled, drawerEnabled: !!body.drawerEnabled } });
          return send(res, 200, { ok: true });
        }
        case '/api/language': config.update({ language: ['uz', 'ru', 'en'].includes(body.language) ? body.language : 'uz' }); return send(res, 200, { ok: true });
        case '/api/refresh': await refreshConfig(config); return send(res, 200, { ok: true });
        case '/api/test-print': await handlers.run('print.test', {}); return send(res, 200, { ok: true });
      }
      send(res, 404, { error: 'not found' });
    } catch (e: any) {
      send(res, e instanceof PairingError ? 400 : 500, { error: e?.message ?? 'error', code: e?.code });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ port: (server.address() as any).port, close: () => server.close() }));
  });
}
