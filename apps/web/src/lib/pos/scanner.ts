/**
 * Barcode scanner capture (spec 7.2, 9.7). A USB HID scanner types like a very fast keyboard and ends
 * with Enter. We recognise a scan by its keystroke rhythm, not by input focus, and read PHYSICAL key
 * codes (`event.code`), so a Russian or Uzbek keyboard layout on the PC never garbles a code that
 * contains letters.
 */
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

const SYMBOLS: Record<string, [string, string]> = {
  Minus: ['-', '_'], Equal: ['=', '+'], BracketLeft: ['[', '{'], BracketRight: [']', '}'], Backslash: ['\\', '|'], Semicolon: [';', ':'], Quote: ["'", '"'],
  Comma: [',', '<'], Period: ['.', '>'], Slash: ['/', '?'], Backquote: ['`', '~'], Space: [' ', ' '],
};
const SHIFT_DIGITS = ')!@#$%^&*(';

/** Character of a physical key, layout independent (US key positions, as scanners send them). */
export function charFromEvent(e: Pick<KeyboardEvent, 'code' | 'key' | 'shiftKey' | 'ctrlKey' | 'getModifierState'>): string | null {
  const { code } = e;
  // a scanner configured to send the GS control character (0x1D) of DataMatrix codes presses Ctrl+]
  if (e.ctrlKey && code === 'BracketRight') return '\x1d';
  if (e.ctrlKey) return null;
  if (/^Key[A-Z]$/.test(code)) {
    const letter = LETTERS[code.charCodeAt(3) - 65];
    const caps = !!e.getModifierState?.('CapsLock');
    return e.shiftKey !== caps ? letter.toUpperCase() : letter;
  }
  if (/^Digit[0-9]$/.test(code)) return e.shiftKey ? SHIFT_DIGITS[Number(code[5])] : code[5];
  if (/^Numpad[0-9]$/.test(code)) return code[6];
  if (code === 'NumpadDecimal') return '.';
  if (code === 'NumpadSubtract') return '-';
  if (code === 'NumpadDivide') return '/';
  const sym = SYMBOLS[code];
  if (sym) return sym[e.shiftKey ? 1 : 0];
  return null;
}

export interface ScannerOptions {
  /** Max gap between two keystrokes of one scan, ms. Humans type slower than this. */
  maxGapMs?: number;
  minLength?: number;
  onScan: (code: string) => void;
  now?: () => number;
}

/**
 * Stateful burst detector. Feed it every keydown; it returns what to do with the event.
 * `buffer` holds the characters of the current burst; Enter after >= minLength fast characters is a scan.
 */
export class ScanDetector {
  private buffer = '';
  private last = 0;
  private fast = 0;
  private opts: Required<Omit<ScannerOptions, 'onScan'>> & Pick<ScannerOptions, 'onScan'>;

  constructor(opts: ScannerOptions) {
    this.opts = { maxGapMs: 60, minLength: 4, now: () => performance.now(), ...opts };
  }

  /** @returns 'scan' when the event completed a scan, 'buffering' while a burst is in progress, 'ignore' otherwise. */
  feed(e: Pick<KeyboardEvent, 'code' | 'key' | 'shiftKey' | 'ctrlKey' | 'getModifierState'>): 'scan' | 'buffering' | 'ignore' {
    const t = this.opts.now();
    const gap = t - this.last;
    this.last = t;

    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      const code = this.buffer;
      const wasFast = this.fast >= this.opts.minLength - 1;
      this.reset();
      if (code.length >= this.opts.minLength && wasFast) {
        this.opts.onScan(code);
        return 'scan';
      }
      return 'ignore';
    }

    const ch = charFromEvent(e);
    if (ch === null) return 'ignore';
    if (this.buffer && gap > this.opts.maxGapMs) this.reset(); // too slow: a human, start over
    this.fast = this.buffer ? this.fast + 1 : 0;
    this.buffer += ch;
    return 'buffering';
  }

  reset() {
    this.buffer = '';
    this.fast = 0;
  }
  get pending() {
    return this.buffer;
  }
}

/**
 * Attaches the detector to the document. Characters typed by a scanner into a focused input are
 * removed again, so scanning never pollutes a search or quantity field.
 */
export function attachScanner(opts: ScannerOptions): () => void {
  const det = new ScanDetector(opts);
  let snapshot: { el: HTMLInputElement | HTMLTextAreaElement; value: string } | null = null;
  const onKey = (e: KeyboardEvent) => {
    if (e.isComposing || e.altKey || e.metaKey) return;
    const target = e.target as HTMLElement | null;
    const isField = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
    if (isField && !det.pending) snapshot = { el: target, value: (target as HTMLInputElement).value };
    const r = det.feed(e);
    if (r === 'scan') {
      e.preventDefault();
      e.stopPropagation();
      if (snapshot && snapshot.el === target) snapshot.el.value = snapshot.value; // drop the typed copy of the code
      snapshot = null;
    }
  };
  document.addEventListener('keydown', onKey, true);
  return () => document.removeEventListener('keydown', onKey, true);
}
