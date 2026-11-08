import { describe, expect, it } from 'vitest';
import { ScanDetector, charFromEvent } from '../src/lib/pos/scanner';

type Ev = Parameters<ScanDetector['feed']>[0];
const key = (code: string, extra: Partial<Ev> = {}): Ev => ({ code, key: '', shiftKey: false, ctrlKey: false, getModifierState: () => false, ...extra });
const codeFor = (ch: string): Ev => {
  if (/[a-z]/.test(ch)) return key(`Key${ch.toUpperCase()}`);
  if (/[A-Z]/.test(ch)) return key(`Key${ch}`, { shiftKey: true });
  if (/[0-9]/.test(ch)) return key(`Digit${ch}`);
  if (ch === '-') return key('Minus');
  if (ch === '/') return key('Slash');
  throw new Error(ch);
};

function detector(gapMs = 8) {
  let t = 0;
  const scans: string[] = [];
  const d = new ScanDetector({ onScan: (c) => scans.push(c), now: () => t });
  const type = (text: string, gap = gapMs) => {
    for (const ch of text) { t += gap; d.feed(codeFor(ch)); }
  };
  const enter = (gap = gapMs) => { t += gap; return d.feed(key('Enter')); };
  return { d, scans, type, enter, wait: (ms: number) => (t += ms) };
}

describe('scanner burst detection (spec 7.2, 9.7)', () => {
  it('recognises a fast burst ending with Enter as a scan', () => {
    const s = detector();
    s.type('4006381333931');
    expect(s.enter()).toBe('scan');
    expect(s.scans).toEqual(['4006381333931']);
  });

  it('reads physical key codes, so letters survive a Russian or Uzbek keyboard layout', () => {
    // with a Russian layout `event.key` is Cyrillic; only `event.code` is trusted
    let t = 0;
    const scans: string[] = [];
    const d = new ScanDetector({ onScan: (c) => scans.push(c), now: () => t });
    for (const ch of 'AB-12x') { t += 5; d.feed({ ...codeFor(ch), key: 'ы' }); }
    t += 5;
    d.feed(key('Enter'));
    expect(scans).toEqual(['AB-12x']);
  });

  it('does not treat human typing as a scan', () => {
    const s = detector();
    s.type('4006381333931', 180); // 180 ms between keys
    expect(s.enter(180)).toBe('ignore');
    expect(s.scans).toEqual([]);
  });

  it('ignores short bursts and a lone Enter', () => {
    const s = detector();
    s.type('12');
    expect(s.enter()).toBe('ignore');
    expect(s.enter()).toBe('ignore');
    expect(s.scans).toEqual([]);
  });

  it('a slow keystroke starts a new burst, so a stray character before the scan does not corrupt it', () => {
    const s = detector();
    s.type('7', 5);
    s.wait(900); // the cashier hesitated
    s.type('4600000000017');
    s.enter();
    expect(s.scans).toEqual(['4600000000017']);
  });

  it('two scans in a row', () => {
    const s = detector();
    s.type('4006381333931'); s.enter();
    s.wait(300);
    s.type('4006381333948'); s.enter();
    expect(s.scans).toEqual(['4006381333931', '4006381333948']);
  });

  it('keeps the GS control character that DataMatrix marking codes contain (Ctrl+])', () => {
    let t = 0;
    const scans: string[] = [];
    const d = new ScanDetector({ onScan: (c) => scans.push(c), now: () => t });
    const feed = (e: Ev) => { t += 4; d.feed(e); };
    for (const ch of '01046') feed(codeFor(ch));
    feed(key('BracketRight', { ctrlKey: true }));
    for (const ch of '93x') feed(codeFor(ch));
    t += 4; d.feed(key('Enter'));
    expect(scans).toEqual(['01046\x1d93x']);
  });

  it('maps characters by physical position, with shift and caps lock', () => {
    expect(charFromEvent(key('KeyA'))).toBe('a');
    expect(charFromEvent(key('KeyA', { shiftKey: true }))).toBe('A');
    expect(charFromEvent(key('KeyA', { getModifierState: (k: string) => k === 'CapsLock' }))).toBe('A');
    expect(charFromEvent(key('Digit5', { shiftKey: true }))).toBe('%');
    expect(charFromEvent(key('Slash'))).toBe('/');
    expect(charFromEvent(key('F5'))).toBeNull();
    expect(charFromEvent(key('KeyC', { ctrlKey: true }))).toBeNull();
  });
});
