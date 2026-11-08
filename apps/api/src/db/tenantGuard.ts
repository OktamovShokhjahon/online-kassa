import type { Schema } from 'mongoose';

/**
 * Defense in depth for multi-tenancy (spec 3.1). The repository layer adds `shopId` to every
 * query; this plugin makes any query/aggregate on a shop-owned collection THROW when it has no
 * `shopId` condition, so a forgotten filter fails loudly instead of leaking another shop's data.
 *
 * Deliberate cross-tenant access (login lookup, background workers) must opt in with
 * `.setOptions({ crossTenant: true })`.
 */
function hasShopId(filter: any): boolean {
  if (!filter || typeof filter !== 'object') return false;
  if (filter.shopId !== undefined) return true;
  if (Array.isArray(filter.$and)) return filter.$and.some(hasShopId);
  return false;
}

export class TenantGuardError extends Error {
  constructor(model: string, op: string) {
    super(`TENANT_GUARD: ${op} on "${model}" without a shopId condition`);
    this.name = 'TenantGuardError';
  }
}

const QUERY_OPS = [
  'find',
  'findOne',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'countDocuments',
  'distinct',
] as const;

export function tenantGuard(schema: Schema): void {
  for (const op of QUERY_OPS) {
    schema.pre(op as any, function (this: any) {
      if (this.getOptions?.().crossTenant) return;
      if (!hasShopId(this.getFilter())) throw new TenantGuardError(this.model.modelName, op);
    });
  }
  schema.pre('aggregate', function (this: any) {
    if (this.options?.crossTenant) return;
    const first = this.pipeline()[0];
    if (!first || !first.$match || !hasShopId(first.$match)) {
      throw new TenantGuardError(this.model.modelName, 'aggregate');
    }
  });
  schema.pre('insertMany', function (this: any, next: (err?: Error) => void, docs: any) {
    const list = Array.isArray(docs) ? docs : [docs];
    for (const d of list) {
      if (!d || d.shopId === undefined) return next(new TenantGuardError(this.modelName, 'insertMany'));
    }
    next();
  });
}
