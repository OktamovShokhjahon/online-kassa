import type { Types } from 'mongoose';
import type { Language, Permission, Role } from '@kass/shared';
import type { ShopDoc, UserDoc } from './models/core';

export interface AuthContext {
  kind: 'user';
  userId: Types.ObjectId;
  role: Role;
  /** null for the superadmin. */
  shopId: Types.ObjectId | null;
  branchIds: Types.ObjectId[];
  permissions: Set<string>;
  user: UserDoc;
  shop: ShopDoc | null;
  sessionId?: string;
  impersonatedBy?: string;
  graceDaysLeft: number | null;
}

export interface ApiKeyContext {
  kind: 'apiKey';
  keyId: Types.ObjectId;
  shopId: Types.ObjectId;
  scopes: Set<string>;
  branchId: Types.ObjectId | null;
  shop: ShopDoc;
  /** Keys of downloadable programs (cash-desk program) are bound to one terminal and cashier. */
  program: { kind: 'desk'; terminalId: Types.ObjectId; cashierId: Types.ObjectId } | null;
}

export interface AgentContext {
  kind: 'agent';
  terminalId: Types.ObjectId;
  shopId: Types.ObjectId;
  branchId: Types.ObjectId;
  shop: ShopDoc;
}

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      lang: Language;
      auth?: AuthContext;
      apiKey?: ApiKeyContext;
      agent?: AgentContext;
    }
  }
}

export type { Permission };
