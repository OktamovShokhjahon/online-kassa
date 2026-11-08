import type { Types } from 'mongoose';
import type { z } from 'zod';
import type { managerApprovalSchema } from '@kass/shared';
import { forbidden } from '../../lib/errors';
import * as limiter from '../../lib/rateLimit';
import { can, canAccessBranch, effectivePermissions } from '../../middleware/auth';
import { User, type UserDoc } from '../../models/core';
import { compareSecret } from '../auth/service';
import type { AuthContext } from '../../types';

/**
 * A manager's login + PIN authorises one action (discount above the cashier limit, refund).
 * The approver must belong to the same shop, hold the permission and reach the branch.
 * Failed attempts are rate limited per approver so a PIN cannot be brute-forced at the till.
 */
export async function verifyApproval(
  a: AuthContext,
  branchId: Types.ObjectId,
  approval: z.infer<typeof managerApprovalSchema> | undefined,
  permission: string,
): Promise<UserDoc> {
  if (!approval || !a.shopId) throw forbidden('APPROVAL_INVALID');
  const key = `approval:${a.shopId}:${approval.login.toLowerCase()}`;
  if ((await limiter.peek(key)) >= 5) throw forbidden('TOO_MANY_ATTEMPTS');
  const approver = await User.findOne({ shopId: a.shopId, login: approval.login.toLowerCase(), isActive: true });
  const pinOk = !!approver?.pinHash && (await compareSecret(approval.pin, approver.pinHash));
  const approverCtx = approver
    ? ({ role: approver.role, permissions: effectivePermissions(approver.role as any, approver.permissions), branchIds: approver.branchIds } as unknown as AuthContext)
    : null;
  if (!approver || !pinOk || !approverCtx || !can(approverCtx, permission) || !canAccessBranch(approverCtx, branchId)) {
    await limiter.hit(key, 15 * 60_000);
    throw forbidden('APPROVAL_INVALID');
  }
  await limiter.reset(key);
  return approver;
}
