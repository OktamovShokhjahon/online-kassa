'use client';

import QRCode from 'qrcode';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { barcodeModules } from '@kass/shared';
import { Icon } from './icons';

/** SVG markup of a barcode (EAN-13 when valid, else Code 128), black on white so any scanner reads it. */
export function barcodeSvg(code: string, height = 64): string | null {
  let modules: number[];
  try {
    modules = barcodeModules(code).modules;
  } catch {
    return null;
  }
  const quiet = 11;
  const w = modules.length + quiet * 2;
  let bars = '';
  for (let i = 0; i < modules.length; ) {
    if (!modules[i]) { i++; continue; }
    let j = i;
    while (j < modules.length && modules[j]) j++;
    bars += `<rect x="${quiet + i}" y="4" width="${j - i}" height="${height}"/>`;
    i = j;
  }
  const textY = height + 16;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${height + 20}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><g fill="#0d1e24">${bars}</g><text x="${w / 2}" y="${textY}" text-anchor="middle" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="11" letter-spacing="1.5" fill="#0d1e24">${code.replace(/[<&>"]/g, '')}</text></svg>`;
}

function useQrSvg(value: string): string {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let alive = true;
    QRCode.toString(value, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0d1e24', light: '#ffffff' } })
      .then((s) => alive && setSvg(s))
      .catch(() => alive && setSvg(''));
    return () => { alive = false; };
  }, [value]);
  return svg;
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Renders SVG markup to a PNG (white background, `width` px wide) for printing or sending. */
async function svgToPng(svg: string, width: number): Promise<Blob> {
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    await new Promise<void>((ok, fail) => { img.onload = () => ok(); img.onerror = () => fail(new Error('svg')); img.src = url; });
    const ratio = (img.naturalHeight || img.height) / (img.naturalWidth || img.width) || 1;
    const canvas = Object.assign(document.createElement('canvas'), { width, height: Math.round(width * ratio) });
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error('png'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

const fileBase = (code: string, name?: string) => (code + (name ? '-' + name : '')).replace(/[^\w.-]+/g, '_').slice(0, 60);

/** PNG image of the barcode or the QR code of `code`. */
export async function codePngBlob(kind: 'barcode' | 'qr', code: string): Promise<Blob> {
  const svg = kind === 'qr'
    ? await QRCode.toString(code, { type: 'svg', margin: 2, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } })
    : barcodeSvg(code, 48);
  if (!svg) throw new Error('This code cannot be drawn as a barcode');
  // a width attribute lets the browser rasterise the SVG at a known size
  return svgToPng(svg.replace('<svg ', '<svg width="1000" '), kind === 'qr' ? 1000 : 1200);
}

/** Downloads the barcode or the QR code of `code` as a PNG image. */
export async function downloadCodePng(kind: 'barcode' | 'qr', code: string, name?: string) {
  saveBlob(await codePngBlob(kind, code), `${fileBase(code, name)}-${kind === 'qr' ? 'qr' : 'barcode'}.png`);
}

/**
 * One ZIP with the printable PDF sheet and an `images/` folder holding a PNG for every product:
 *   qr-codes.zip
 *   ├─ qr-codes.pdf
 *   └─ images/<code>-<product name>.png
 */
export async function downloadCodesZip(
  kind: 'barcode' | 'qr',
  items: Array<{ name: string; code: string }>,
  pdf: Blob,
  onProgress?: (done: number, total: number) => void,
) {
  const { default: JSZip } = await import('jszip');
  const base = kind === 'qr' ? 'qr-codes' : 'barcodes';
  const zip = new JSZip();
  zip.file(`${base}.pdf`, pdf);
  const images = zip.folder('images')!;
  const used = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const { name, code } = items[i];
    let file = fileBase(code, name);
    for (let n = 2; used.has(file); n++) file = `${fileBase(code, name)}_${n}`;
    used.add(file);
    try {
      images.file(`${file}.png`, await codePngBlob(kind, code));
    } catch {
      /* a code that cannot be drawn is left out of the images, it is still in the PDF list */
    }
    onProgress?.(i + 1, items.length);
  }
  saveBlob(await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } }), `${base}.zip`);
}

/**
 * Barcode + QR code of a product code, shown side by side in the product form. The QR code holds
 * the same value as the barcode, so the till finds the product from either.
 */
export function ProductCodes({ code, name }: { code: string; name?: string }) {
  const t = useTranslations('shop.products');
  const bar = useMemo(() => barcodeSvg(code), [code]);
  const qr = useQrSvg(code);
  return (
    <div className="anim-fade grid gap-3 rounded-xl border border-border bg-surface-2/60 p-3 sm:grid-cols-[1fr_auto]">
      <figure className="flex min-w-0 flex-col">
        <figcaption className="mb-1.5 flex items-center justify-between gap-2 text-xs text-muted">
          <span>{t('barcodeImage')}</span>
          {bar && <button type="button" onClick={() => void downloadCodePng('barcode', code, name)} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-primary hover:bg-primary/10"><Icon name="arrowDown" className="h-3.5 w-3.5" />PNG</button>}
        </figcaption>
        <div className="flex flex-1 items-center justify-center rounded-lg bg-white p-2 shadow-sm">
          {bar ? <div className="h-24 w-full max-w-xs [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: bar }} /> : <span className="text-xs text-danger">{t('barcodeInvalid')}</span>}
        </div>
      </figure>
      <figure className="flex flex-col">
        <figcaption className="mb-1.5 flex items-center justify-between gap-2 text-xs text-muted">
          <span>{t('qrImage')}</span>
          {qr && <button type="button" onClick={() => void downloadCodePng('qr', code, name)} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-primary hover:bg-primary/10"><Icon name="arrowDown" className="h-3.5 w-3.5" />PNG</button>}
        </figcaption>
        <div className="grid place-items-center rounded-lg bg-white p-2 shadow-sm">
          {qr ? <div className="h-24 w-24 [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: qr }} /> : <div className="skeleton h-24 w-24 rounded" />}
        </div>
      </figure>
    </div>
  );
}
