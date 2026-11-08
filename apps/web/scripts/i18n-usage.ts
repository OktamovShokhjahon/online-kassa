/**
 * Finds translation keys used in the web source (`useTranslations('ns')` + `t('key')`) that are
 * missing from the English messages. Template keys such as t(`types.${x}`) are reported as dynamic
 * prefixes. Used by the test suite and by hand: `npx tsx scripts/i18n-usage.ts`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { lookup, messages } from '@kass/shared';

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

export function scan(root = path.resolve(__dirname, '../src')) {
  const used = new Map<string, string>(); // full key -> file
  const dynamic = new Map<string, string>(); // prefix -> file
  for (const file of walk(root)) {
    const src = fs.readFileSync(file, 'utf8');
    const vars = new Map<string, string>();
    for (const m of src.matchAll(/const (\w+) = useTranslations\('([\w.]+)'\)/g)) vars.set(m[1], m[2]);
    for (const [v, ns] of vars) {
      const re = new RegExp(`(?<![\\w.])${v}\\(\\s*(?:'([^']+)'|\`([^\`]+)\`)`, 'g');
      for (const m of src.matchAll(re)) {
        if (m[1]) used.set(`${ns}.${m[1]}`, file);
        else if (m[2]!.includes('${')) dynamic.set(`${ns}.${m[2]!.split('${')[0]}`, file);
        else used.set(`${ns}.${m[2]}`, file);
      }
    }
  }
  const missing = [...used].filter(([k]) => lookup(messages.en, k) === undefined).map(([k, f]) => ({ key: k, file: path.relative(root, f) }));
  const missingDynamic = [...dynamic]
    .filter(([prefix]) => {
      const cut = prefix.lastIndexOf('.', prefix.length - 2);
      const parentPath = prefix.endsWith('.') ? prefix.slice(0, -1) : prefix.slice(0, cut);
      const leafStart = prefix.endsWith('.') ? '' : prefix.slice(cut + 1);
      let cur: any = messages.en;
      for (const part of parentPath.split('.')) cur = cur?.[part];
      if (typeof cur !== 'object' || cur === null) return true;
      return leafStart ? !Object.keys(cur).some((k) => k.startsWith(leafStart)) : false;
    })
    .map(([k, f]) => ({ prefix: k, file: path.relative(root, f) }));
  return { used: used.size, missing, missingDynamic };
}

if (require.main === module) {
  const r = scan();
  console.log(JSON.stringify(r, null, 2));
}
