import supertest from 'supertest';
import { createApp } from '../src/app';
import { User } from '../src/models/core';
import { hashSecret } from '../src/modules/auth/service';

export const app = createApp();
export const api = () => supertest(app);
export const P = '/api/v1';

export const SUPER = { login: 'root', password: 'rootpass123' };

export async function seedSuperadmin() {
  return User.create({
    role: 'superadmin',
    shopId: null,
    fullName: 'Root',
    login: SUPER.login,
    passwordHash: await hashSecret(SUPER.password),
  });
}

export interface Session {
  token: string;
  cookies: string[];
  body: any;
}

export async function login(loginName: string, password: string, lang = 'en'): Promise<Session> {
  const res = await api().post(`${P}/auth/login`).set('Accept-Language', lang).send({ login: loginName, password });
  if (res.status !== 200) throw new Error(`login failed ${res.status}: ${JSON.stringify(res.body)}`);
  return { token: res.body.data.accessToken, cookies: res.headers['set-cookie'] as unknown as string[], body: res.body.data };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export async function superSession() {
  await seedSuperadmin();
  return login(SUPER.login, SUPER.password);
}

let seq = 0;
export function shopPayload(overrides: Record<string, unknown> = {}) {
  seq += 1;
  return {
    name: `Shop ${seq}`,
    adminFullName: `Admin ${seq}`,
    adminPhone: '+998901234567',
    adminLogin: `admin${seq}`,
    adminPassword: 'password123',
    firstBranchName: 'Main branch',
    ...overrides,
  };
}

/** Creates a shop through the real endpoint; returns ids and a logged-in admin session. */
export async function createShop(superToken: string, overrides: Record<string, unknown> = {}) {
  const payload = shopPayload(overrides);
  const res = await api().post(`${P}/admin/shops`).set(bearer(superToken)).send(payload);
  if (res.status !== 201) throw new Error(`createShop failed ${res.status}: ${JSON.stringify(res.body)}`);
  // An expired/blocked shop cannot log in; tests that create one on purpose get admin = null.
  const admin = await login(payload.adminLogin as string, payload.adminPassword as string).catch(() => null as unknown as Session);
  return {
    shopId: res.body.data.shop.id as string,
    branchId: res.body.data.branch.id as string,
    adminId: res.body.data.admin.id as string,
    payload,
    admin,
  };
}
