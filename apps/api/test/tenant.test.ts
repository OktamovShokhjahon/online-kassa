import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { TenantGuardError } from '../src/db/tenantGuard';
import { TenantRepo } from '../src/repo/tenantRepo';
import { Branch, User } from '../src/models/core';
import { P, api, bearer, createShop, superSession } from './helpers';

describe('tenant guard (defence in depth)', () => {
  it('throws on queries against shop-owned collections without shopId', async () => {
    await expect(Branch.find({})).rejects.toBeInstanceOf(TenantGuardError);
    await expect(Branch.findOne({ name: 'x' })).rejects.toBeInstanceOf(TenantGuardError);
    await expect(Branch.updateMany({}, { name: 'x' })).rejects.toBeInstanceOf(TenantGuardError);
    await expect(Branch.deleteMany({})).rejects.toBeInstanceOf(TenantGuardError);
    await expect(Branch.countDocuments({})).rejects.toBeInstanceOf(TenantGuardError);
    await expect(Branch.aggregate([{ $group: { _id: null } }])).rejects.toBeInstanceOf(TenantGuardError);
    await expect(User.findById(new mongoose.Types.ObjectId())).rejects.toBeInstanceOf(TenantGuardError);
  });

  it('allows explicit cross-tenant access only when requested', async () => {
    await expect(Branch.find({}).setOptions({ crossTenant: true })).resolves.toEqual([]);
  });
});

describe('TenantRepo', () => {
  it('forces the session shopId even if the caller passes another one', async () => {
    const a = new mongoose.Types.ObjectId();
    const b = new mongoose.Types.ObjectId();
    const repoA = new TenantRepo(Branch, a);
    const repoB = new TenantRepo(Branch, b);

    const created = await repoA.create({ name: 'A branch', shopId: b }); // attempted override
    expect(String(created.shopId)).toBe(String(a));
    await repoB.create({ name: 'B branch' });

    expect(await repoA.count()).toBe(1);
    expect(await repoB.count()).toBe(1);
    // a filter that tries to select the other shop is still scoped to A
    expect(await repoA.find({ shopId: b })).toHaveLength(1);
    expect((await repoA.find({ shopId: b }))[0].name).toBe('A branch');
    // aggregates start with the tenant match
    const agg = await repoA.aggregate([{ $group: { _id: null, n: { $sum: 1 } } }]);
    expect(agg[0].n).toBe(1);
    // updates and deletes cannot cross over
    await repoA.updateMany({ shopId: b }, { name: 'hacked' });
    expect((await repoB.find())[0].name).toBe('B branch');
    await repoA.deleteOne({ shopId: b });
    expect(await repoB.count()).toBe(1);
  });
});

describe('role separation', () => {
  it('a shop admin can never reach superadmin routes', async () => {
    const sa = await superSession();
    const shop = await createShop(sa.token);
    for (const [method, path] of [
      ['get', '/admin/shops'],
      ['get', '/admin/dashboard'],
      ['post', `/admin/shops/${shop.shopId}/block`],
      ['get', '/admin/settings'],
      ['get', '/admin/audit-logs'],
    ] as const) {
      const r = await (api() as any)[method](`${P}${path}`).set(bearer(shop.admin.token)).send({ reason: 'x' });
      expect(r.status, `${method} ${path}`).toBe(403);
    }
  });

  it('shop A admin and shop B admin are separate tenants with their own branch', async () => {
    const sa = await superSession();
    const a = await createShop(sa.token);
    const b = await createShop(sa.token);
    expect(a.shopId).not.toBe(b.shopId);
    expect(a.branchId).not.toBe(b.branchId);
    const meA = await api().get(`${P}/auth/me`).set(bearer(a.admin.token));
    const meB = await api().get(`${P}/auth/me`).set(bearer(b.admin.token));
    expect(meA.body.data.shop.id).toBe(a.shopId);
    expect(meB.body.data.shop.id).toBe(b.shopId);
    expect(meA.body.data.user.branchIds).toEqual([a.branchId]);
  });

  it('unauthenticated and malformed tokens are rejected', async () => {
    await superSession();
    expect((await api().get(`${P}/admin/shops`)).status).toBe(401);
    expect((await api().get(`${P}/admin/shops`).set(bearer('garbage'))).status).toBe(401);
  });

  it('unknown routes return a JSON 404', async () => {
    const r = await api().get(`${P}/nope`);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('NOT_FOUND');
  });
});
