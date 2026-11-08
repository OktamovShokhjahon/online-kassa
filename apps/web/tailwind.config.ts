import type { Config } from 'tailwindcss';

const v = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

const config: Config = {
  darkMode: ['selector', '[data-theme="dark"]'],
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: v('bg'), surface: v('surface'), 'surface-2': v('surface-2'), border: v('border'), fg: v('fg'), muted: v('muted'),
        primary: v('primary'), 'primary-fg': v('primary-fg'), 'primary-deep': v('primary-deep'), accent: v('accent'),
        danger: v('danger'), 'danger-fg': v('danger-fg'), success: v('success'), warn: v('warn'),
      },
      fontFamily: {
        sans: ['"Onest Variable"', 'Onest', 'system-ui', 'Segoe UI', 'Roboto', 'sans-serif'],
        display: ['"Unbounded Variable"', 'Unbounded', '"Onest Variable"', 'system-ui', 'sans-serif'],
      },
      borderRadius: { xl: '14px', '2xl': '20px' },
      boxShadow: { sm: 'var(--shadow-sm)', DEFAULT: 'var(--shadow-md)', md: 'var(--shadow-md)', lg: 'var(--shadow-lg)', xl: 'var(--shadow-lg)' },
    },
  },
  plugins: [],
};
export default config;
