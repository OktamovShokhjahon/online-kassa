/**
 * Fiscal module adapter (spec 8.5). Each provider is ONE implementation of this interface;
 * the provider is chosen per terminal, so adding another provider never touches the POS.
 */
export interface FiscalLineItem {
  name: string;
  qty: number;
  /** Unit price after discounts are spread into the line total, minor units. */
  price: number;
  total: number;
  vatRate?: number | null;
  mxikCode?: string | null;
  packageCode?: string | null;
  markingCode?: string | null;
}

export interface FiscalDoc {
  number: string;
  lines: FiscalLineItem[];
  total: number;
  payments: Array<{ method: string; amount: number }>;
  createdAt: Date;
  /** Set for refund receipts: the fiscal receipt id of the original sale. */
  refundOfReceiptId?: string;
  isOffline?: boolean;
}

export interface FiscalContext {
  terminalId: string;
  moduleId?: string | null;
  tin?: string | null;
  /** Decrypted provider credentials (API keys etc.). Never logged. */
  credentials: Record<string, any>;
  timeoutMs: number;
}

export interface FiscalResult {
  sign: string;
  receiptId: string;
  qr: string;
  moduleId?: string;
  raw?: unknown;
}

export interface FiscalStatus {
  online: boolean;
  shiftOpen?: boolean;
  message?: string;
}

export interface FiscalProvider {
  readonly name: string;
  /** Can receipts be fiscalized later (offline selling)? If not, offline sales are blocked. */
  readonly supportsOffline: boolean;
  openShift(ctx: FiscalContext): Promise<{ fiscalShiftId: string }>;
  registerSale(ctx: FiscalContext, doc: FiscalDoc): Promise<FiscalResult>;
  registerRefund(ctx: FiscalContext, doc: FiscalDoc): Promise<FiscalResult>;
  closeShift(ctx: FiscalContext, fiscalShiftId?: string | null): Promise<{ report?: unknown }>;
  getStatus(ctx: FiscalContext): Promise<FiscalStatus>;
}
