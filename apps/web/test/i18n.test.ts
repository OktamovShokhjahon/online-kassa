import { describe, expect, it } from 'vitest';
import { scan } from '../scripts/i18n-usage';

describe('interface texts (spec 14.5)', () => {
  it('every translation key used in the web source exists (CI fails otherwise)', () => {
    const r = scan();
    expect(r.missing, `Missing keys: ${r.missing.map((m) => `${m.key} (${m.file})`).join(', ')}`).toEqual([]);
    expect(r.missingDynamic).toEqual([]);
    expect(r.used).toBeGreaterThan(300);
  });
});
