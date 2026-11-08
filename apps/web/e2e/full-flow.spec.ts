import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * The flow from spec section 13: create shop -> admin login -> product, prices, stock -> sell ->
 * offline sale and sync -> return -> close shift. Setup that is not the point of a step goes through the
 * public HTTP API (the same calls `seed-demo` uses); everything the cashier and the owner do is driven through the UI.
 */
const API = process.env.E2E_API_URL ?? 'http://localhost:4000/api/v1';
const WEB = process.env.E2E_WEB_URL ?? 'http://localhost:3000';
const run = Date.now().toString(36);
const ADMIN = { login: `e2e.admin.${run}`, password: 'e2e-pass-12345' };
const CASHIER = { login: `e2e.cashier.${run}`, password: 'e2e-pass-12345' };
const BARCODE = '4006381333931';

let ids: { terminalId: string; productName: string };

async function call(request: APIRequestContext, method: 'get' | 'post' | 'patch', path: string, token?: string, data?: unknown) {
  const res = await request[method](`${API}${path}`, { data, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const json = await res.json();
  if (!res.ok()) throw new Error(`${method} ${path} -> ${res.status()} ${JSON.stringify(json.error)}`);
  return json.data;
}

async function login(page: Page, who: { login: string; password: string }) {
  await page.context().addCookies([{ name: 'NEXT_LOCALE', value: 'en', url: WEB }]);
  await page.goto('/login');
  await page.locator('input').nth(0).fill(who.login);
  await page.locator('input[type=password]').fill(who.password);
  await page.keyboard.press('Enter');
}

const menu = async (page: Page, item: string) => {
  await page.getByRole('button', { name: 'menu', exact: true }).click();
  await page.getByRole('menuitem', { name: item }).click();
};

test.describe.serial('Online Kass end to end', () => {
  test('platform owner creates a shop; the shop owner sets up products, prices and stock', async ({ page, request }) => {
    const sa = (await call(request, 'post', '/auth/login', undefined, { login: process.env.E2E_SA_LOGIN ?? 'admin', password: process.env.E2E_SA_PASSWORD ?? 'a@a@admina@a@' })).accessToken;
    await call(request, 'post', '/admin/shops', sa, {
      name: `E2E Market ${run}`, adminFullName: 'E2E Owner', adminPhone: '+998 90 111 22 33', adminLogin: ADMIN.login, adminPassword: ADMIN.password,
      firstBranchName: 'Main', address: 'Tashkent', currency: 'UZS', paidUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });

    // the owner logs in through the UI and lands in the back office
    await login(page, ADMIN);
    await expect(page).toHaveURL(/\/shop/);

    const admin = (await call(request, 'post', '/auth/login', undefined, ADMIN)).accessToken;
    const branch = (await call(request, 'get', '/branches', admin))[0].id;
    const terminal = await call(request, 'post', '/terminals', admin, { name: 'Till 1', branchId: branch });
    await call(request, 'post', '/users', admin, { role: 'cashier', fullName: 'E2E Cashier', login: CASHIER.login, password: CASHIER.password, branchIds: [branch], pin: '1234', permissions: ['sales.refund'] });
    const product = await call(request, 'post', '/products', admin, { name: `E2E Cola ${run}`, barcodes: [BARCODE], unit: 'piece', vatRate: 12, prices: [{ branchId: branch, price: 1_000_000 }] });
    const supplier = await call(request, 'post', '/suppliers', admin, { name: 'E2E Supplier' });
    await call(request, 'post', '/goods-receipts', admin, { supplierId: supplier.id, branchId: branch, post: true, lines: [{ productId: product.id, qty: 20, cost: 600_000 }] });
    ids = { terminalId: terminal.id, productName: product.name };

    // the product, its price and the stock are visible in the owner's panel
    await page.goto('/shop/products');
    await expect(page.getByText(product.name).filter({ visible: true })).toBeVisible();
    await page.goto('/shop/stock');
    await expect(page.getByText(product.name).filter({ visible: true })).toBeVisible();
  });

  test('cashier opens a shift, sells online, sells offline, syncs, returns, closes the shift', async ({ page }) => {
    await login(page, CASHIER);
    await expect(page).toHaveURL(/\/pos/);

    // open the shift with an empty drawer
    await page.getByRole('button', { name: 'Open shift' }).click();
    const search = page.getByPlaceholder(/Scan a barcode/);
    await expect(search).toBeVisible();

    const sell = async () => {
      await search.fill(BARCODE);
      await search.press('Enter');
      await expect(page.getByText(ids.productName).first()).toBeVisible();
      // the name also shows in the search suggestions; wait until the line is really in the receipt
      await expect(page.getByRole('button', { name: /Pay \(F9\)/ })).toBeEnabled();
      await page.keyboard.press('F9');
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.keyboard.press('F12');
    };

    // 1. online sale
    await sell();
    await expect(page.getByText('Sale completed')).toBeVisible();
    await expect(page.getByText(/№ 1-0000\d+/)).toBeVisible();
    await page.getByRole('button', { name: 'New sale' }).click();

    // 2. offline sale: POST /sales and the sync endpoint are unreachable
    await page.route('**/api/v1/sales', (route) => (route.request().method() === 'POST' ? route.abort('internetdisconnected') : route.continue()));
    await page.route('**/api/v1/sales/sync', (route) => route.abort('internetdisconnected'));
    await sell();
    await expect(page.getByText('Saved offline, will be sent when the internet is back')).toBeVisible();
    await page.getByRole('button', { name: 'New sale' }).click();
    await expect(page.getByText(/1 waiting to send/)).toBeVisible();

    // 3. the connection returns: the queue is sent
    await page.unroute('**/api/v1/sales');
    await page.unroute('**/api/v1/sales/sync');
    await menu(page, 'Send queued sales');
    await expect(page.getByText(/waiting to send/)).toHaveCount(0, { timeout: 30_000 });

    // 4. return the first (online) receipt by its number
    await menu(page, 'X-report');
    await expect(page.getByText('Receipts')).toBeVisible();
    await page.keyboard.press('Escape');
    await menu(page, 'Return');
    await page.getByPlaceholder('Receipt number').fill('1-000001');
    await page.keyboard.press('Enter');
    await expect(page.getByText(ids.productName).last()).toBeVisible();
    await page.locator('table input').first().fill('1');
    await page.locator('textarea').fill('E2E return');
    await page.getByRole('button', { name: 'Return', exact: true }).last().click();
    await expect(page.getByText(/Return completed/)).toBeVisible();

    // 5. close the shift: 2 sales - 1 refund = one item's price (10 000) in the drawer
    await menu(page, 'Close shift');
    await expect(page.getByText('Expected cash')).toBeVisible();
    await expect(page.getByText('10 000').first()).toBeVisible();
    await page.getByRole('dialog').locator('input').first().fill('10000');
    await page.getByRole('button', { name: /Close the shift/ }).click();
    await expect(page.getByText('Shift closed')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open shift' })).toBeVisible();
  });
});
