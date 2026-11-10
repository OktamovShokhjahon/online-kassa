import type { ReactNode, SVGProps } from 'react';

/** Small stroke icon set (24px grid, 1.75 stroke). Paths only, no dependency. */
const P: Record<string, ReactNode> = {
  dashboard: <><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>,
  products: <><path d="M21 8l-9-5-9 5 9 5 9-5z" /><path d="M3 8v8l9 5 9-5V8" /><path d="M12 13v8" /></>,
  categories: <><path d="M12 3l9 5-9 5-9-5 9-5z" /><path d="M3 12.5l9 5 9-5" /><path d="M3 17l9 5 9-5" /></>,
  prices: <><path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z" /><circle cx="7.5" cy="7.5" r="1" fill="currentColor" /></>,
  promotions: <><path d="M19 5L5 19" /><circle cx="6.5" cy="6.5" r="2.5" /><circle cx="17.5" cy="17.5" r="2.5" /></>,
  history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" /></>,
  warehouse: <><path d="M3 21V9l9-6 9 6v12" /><path d="M7 21v-8h10v8" /><path d="M7 17h10" /></>,
  stock: <><rect x="2" y="3" width="20" height="5" rx="1" /><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" /><path d="M10 12h4" /></>,
  receipts: <><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z" /><path d="M8 8h8M8 12h8M8 16h5" /></>,
  transfers: <><path d="M7 7h13l-4-4" /><path d="M17 17H4l4 4" /></>,
  writeoffs: <><path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /></>,
  counts: <><rect x="8" y="2" width="8" height="4" rx="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><path d="M9 14l2 2 4-4" /></>,
  suppliers: <><path d="M10 17h4V5H2v12h3" /><path d="M14 8h4l4 4v5h-2" /><circle cx="7.5" cy="17.5" r="2.5" /><circle cx="17.5" cy="17.5" r="2.5" /></>,
  customers: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.9" /><path d="M16 3.1a4 4 0 0 1 0 7.8" /></>,
  staff: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="11" r="2" /><path d="M15 9h3M15 13h3" /><path d="M6 17c.5-2 2-3 3-3s2.5 1 3 3" /></>,
  reports: <><path d="M3 3v18h18" /><path d="M7 16v-5M12 16V7M17 16v-3" /></>,
  branches: <><path d="M3 9l1-5h16l1 5" /><path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0" /><path d="M5 12v8h14v-8" /><path d="M10 20v-5h4v5" /></>,
  shops: <><path d="M3 9l1-5h16l1 5" /><path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0" /><path d="M5 12v8h14v-8" /><path d="M10 20v-5h4v5" /></>,
  terminals: <><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></>,
  developers: <><path d="M16 18l6-6-6-6" /><path d="M8 6l-6 6 6 6" /></>,
  settings: <><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" /><path d="M1 14h6M9 8h6M17 16h6" /></>,
  audit: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="M9 12l2 2 4-4" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  moon: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5M21 12H9" /></>,
  check: <path d="M20 6L9 17l-5-5" />,
  x: <path d="M18 6L6 18M6 6l12 12" />,
  search: <><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></>,
  chevron: <path d="M6 9l6 6 6-6" />,
  wifi: <><path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0" /><circle cx="12" cy="19.5" r=".8" fill="currentColor" /><path d="M2 9a15 15 0 0 1 20 0" /></>,
  wifiOff: <><path d="M2 2l20 20" /><path d="M8.5 16a5 5 0 0 1 7 0M5 12.5a10 10 0 0 1 5.2-2.8M2 9a15 15 0 0 1 4.3-2.7M19 12.5a10 10 0 0 0-2.2-1.7" /><circle cx="12" cy="19.5" r=".8" fill="currentColor" /></>,
  printer: <><path d="M6 9V3h12v6" /><rect x="3" y="9" width="18" height="9" rx="2" /><rect x="7" y="14" width="10" height="7" rx="1" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  arrowUp: <path d="M12 19V5M5 12l7-7 7 7" />,
  arrowDown: <path d="M12 5v14M19 12l-7 7-7-7" />,
  wallet: <><path d="M3 7a2 2 0 0 1 2-2h13v4" /><path d="M3 7v11a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-3" /><path d="M21 9H16a2 2 0 0 0 0 4h5z" /></>,
  bolt: <path d="M13 2L4 14h7l-1 8 9-12h-7z" />,
  cloud: <><path d="M17.5 19a4.5 4.5 0 1 0-1.4-8.8A6 6 0 1 0 6 18.5" /><path d="M12 12v8M9 17l3 3 3-3" /></>,
  box: <><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></>,
  alert: <><path d="M12 3l10 18H2L12 3z" /><path d="M12 10v5M12 18h.01" /></>,
};

export type IconName = keyof typeof P;

export function Icon({ name, className = 'h-[18px] w-[18px]', ...p }: { name: IconName | string; className?: string } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className={className} {...p}>
      {P[name] ?? P.box}
    </svg>
  );
}

/** The eight-pointed star of glazed tilework: two squares turned 45° against each other. */
export function StarMark({ className = 'h-6 w-6', ...p }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className} {...p}>
      <rect x="4.6" y="4.6" width="14.8" height="14.8" rx="1.4" fill="currentColor" />
      <rect x="4.6" y="4.6" width="14.8" height="14.8" rx="1.4" fill="currentColor" transform="rotate(45 12 12)" />
    </svg>
  );
}

/** Brand tile: the star on a deep teal square. */
export function LogoMark({ size = 36, className = '' }: { size?: number; className?: string }) {
  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[11px] bg-gradient-to-br from-primary to-primary-deep text-primary-fg shadow-[0_6px_16px_-6px_rgb(var(--primary)/0.7)] ${className}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <StarMark className="h-[62%] w-[62%]" />
    </span>
  );
}

/** Tiling star pattern (decorative). The caller sets the colour through `text-*` and sizes the box. */
export function StarPattern({ id = 'kass-star', size = 72, className = '' }: { id?: string; size?: number; className?: string }) {
  const c = size / 2;
  const a = size * 0.26;
  const d = size * 0.4;
  return (
    <svg width="100%" height="100%" className={className} aria-hidden="true" focusable="false">
      <defs>
        <pattern id={id} width={size} height={size} patternUnits="userSpaceOnUse">
          <g fill="none" stroke="currentColor" strokeWidth="1">
            <rect x={c - a} y={c - a} width={a * 2} height={a * 2} />
            <polygon points={`${c},${c - d} ${c + d},${c} ${c},${c + d} ${c - d},${c}`} />
            <circle cx={c} cy={c} r={a * 0.45} />
            <path d={`M0 0l${a * 0.5} ${a * 0.5}M${size} 0l-${a * 0.5} ${a * 0.5}M0 ${size}l${a * 0.5} -${a * 0.5}M${size} ${size}l-${a * 0.5} -${a * 0.5}`} />
          </g>
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
}
