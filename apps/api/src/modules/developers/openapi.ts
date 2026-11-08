import { Router } from 'express';
import { API_PREFIX } from '@kass/shared';
import { env } from '../../config/env';
import { h } from '../../lib/http';
import { API_SCOPES, WEBHOOK_EVENTS } from '../../models/integrations';

export const API_VERSION = '1.0.0';
export const API_CHANGELOG = [
  { version: '1.0.0', date: '2026-11-06', changes: ['Initial public API: products, prices, stock, sales, customers, daily report.', 'Signed webhooks with retries for 24 hours.', 'Per-key rate limit of 120 requests per minute.'] },
];

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{24}$' } };
const page = [
  { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 }, description: 'Up to 100 (1000 for prices/stock).' },
];
const branchQ = (required: boolean) => ({ name: 'branchId', in: 'query', required, schema: { type: 'string' } });
const secured = (scope: string) => ({ security: [{ bearerAuth: [] }], 'x-required-scope': scope });
const ok = (schema: object, description = 'OK') => ({ 200: { description, content: { 'application/json': { schema } } }, 401: ref401, 403: ref403, 429: { description: 'Rate limit exceeded (120 requests per minute per key)' } });
const ref401 = { description: 'Missing or invalid API key (API_KEY_INVALID)' };
const ref403 = { description: 'Scope missing (SCOPE_MISSING) or shop blocked (SHOP_BLOCKED)' };
const list = (item: string) => ({ type: 'object', properties: { data: { type: 'array', items: ref(item) }, meta: ref('PageMeta') } });
const one = (item: string) => ({ type: 'object', properties: { data: ref(item) } });

/** OpenAPI 3 description of the public REST API (spec 10). Served as JSON and rendered on /shop/developers. */
export function buildOpenApi() {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Online Kass public API',
      version: API_VERSION,
      description:
        'Connect external systems to your shop. Authenticate with `Authorization: Bearer <api_key>`. ' +
        'Create keys in **Developers → API keys**; the full key is shown once. Every response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`. ' +
        'Money is an integer in minor units (tiyin/cents/kopeks). Times are ISO 8601 UTC. **Selling prices cannot be changed through this API** - they are set only by the shop owner in the panel.',
    },
    servers: [{ url: `${env.PUBLIC_API_URL}${API_PREFIX}` }],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: `Scopes: ${API_SCOPES.join(', ')}` } },
      schemas: {
        PageMeta: { type: 'object', properties: { page: { type: 'integer' }, limit: { type: 'integer' }, total: { type: 'integer' } } },
        Error: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string', example: 'PRODUCT_NOT_FOUND' }, message: { type: 'string' }, details: {} } } } },
        Product: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, sku: { type: 'string', nullable: true }, barcodes: { type: 'array', items: { type: 'string' } }, categoryId: { type: 'string', nullable: true }, unit: { type: 'string', enum: ['piece', 'kg', 'gram', 'litre', 'metre', 'pack'] }, isWeighted: { type: 'boolean' }, vatRate: { type: 'number', nullable: true }, mxikCode: { type: 'string', nullable: true }, packageCode: { type: 'string', nullable: true }, isActive: { type: 'boolean' }, updatedAt: { type: 'string', format: 'date-time' }, price: { type: 'integer', description: 'Only when branchId is given and the key has prices:read' } } },
        ProductInput: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, sku: { type: 'string' }, barcodes: { type: 'array', items: { type: 'string' } }, categoryId: { type: 'string' }, unit: { type: 'string' }, isWeighted: { type: 'boolean' }, vatRate: { type: 'number' }, mxikCode: { type: 'string', description: '17 digits' }, packageCode: { type: 'string' }, isMarked: { type: 'boolean' } } },
        Price: { type: 'object', properties: { productId: { type: 'string' }, branchId: { type: 'string' }, price: { type: 'integer' }, updatedAt: { type: 'string', format: 'date-time' } } },
        Stock: { type: 'object', properties: { productId: { type: 'string' }, branchId: { type: 'string' }, quantity: { type: 'number' }, minStock: { type: 'number' } } },
        Sale: { type: 'object', properties: { id: { type: 'string' }, number: { type: 'string' }, branchId: { type: 'string' }, createdAt: { type: 'string', format: 'date-time' }, total: { type: 'integer' }, discount: { type: 'integer' }, currency: { type: 'string' }, status: { type: 'string', enum: ['completed', 'partially_refunded', 'refunded'] }, customerId: { type: 'string', nullable: true }, payments: { type: 'array', items: { type: 'object', properties: { method: { type: 'string' }, amount: { type: 'integer' } } } }, fiscal: { type: 'object', nullable: true }, lines: { type: 'array', items: { type: 'object' } } } },
        SaleInput: { type: 'object', required: ['clientRequestId', 'terminalId', 'shiftId', 'lines', 'payments'], properties: { clientRequestId: { type: 'string', description: 'Idempotency key: retrying with the same value never creates a second receipt.' }, terminalId: { type: 'string' }, shiftId: { type: 'string', description: 'An open shift on the terminal reserved for the integration.' }, customerId: { type: 'string' }, lines: { type: 'array', items: { type: 'object', required: ['productId', 'qty'], properties: { productId: { type: 'string' }, qty: { type: 'number' }, discount: { type: 'integer' }, markingCode: { type: 'string' } } } }, discount: { type: 'integer' }, payments: { type: 'array', items: { type: 'object', required: ['method', 'amount'], properties: { method: { type: 'string', enum: ['cash', 'card', 'bonus', 'credit'] }, amount: { type: 'integer' } } } } } },
        Customer: { type: 'object', properties: { id: { type: 'string' }, fullName: { type: 'string' }, phone: { type: 'string' }, cardBarcode: { type: 'string', nullable: true }, bonusBalance: { type: 'integer' }, debtBalance: { type: 'integer' } } },
        DailyReport: { type: 'object', properties: { date: { type: 'string' }, branchId: { type: 'string' }, branchName: { type: 'string' }, receipts: { type: 'integer' }, revenue: { type: 'integer' }, discounts: { type: 'integer' }, returns: { type: 'integer' }, netRevenue: { type: 'integer' } } },
      },
    },
    paths: {
      '/public/products': {
        get: { summary: 'List products', tags: ['Products'], ...secured('products:read'), parameters: [...page, { name: 'q', in: 'query', schema: { type: 'string' } }, { name: 'categoryId', in: 'query', schema: { type: 'string' } }, { name: 'updatedSince', in: 'query', schema: { type: 'string', format: 'date-time' } }, { name: 'active', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } }], responses: ok(list('Product')) },
        post: { summary: 'Create a product', description: 'Prices cannot be set here.', tags: ['Products'], ...secured('products:write'), requestBody: { required: true, content: { 'application/json': { schema: ref('ProductInput') } } }, responses: { 201: { description: 'Created', content: { 'application/json': { schema: one('Product') } } }, 409: { description: 'DUPLICATE_BARCODE / DUPLICATE_SKU' } } },
      },
      '/public/products/by-barcode/{barcode}': {
        get: { summary: 'Find a product by barcode (scanners, price checkers)', tags: ['Products'], ...secured('products:read'), parameters: [{ name: 'barcode', in: 'path', required: true, schema: { type: 'string' } }, branchQ(false)], responses: ok(one('Product')) },
      },
      '/public/products/{id}': {
        patch: { summary: 'Update name, barcodes or category', tags: ['Products'], ...secured('products:write'), parameters: [idParam], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, barcodes: { type: 'array', items: { type: 'string' } }, categoryId: { type: 'string', nullable: true } } } } } }, responses: ok(one('Product')) },
      },
      '/public/prices': { get: { summary: 'Selling prices of a branch', tags: ['Prices'], ...secured('prices:read'), parameters: [branchQ(true), ...page], responses: ok(list('Price')) } },
      '/public/stock': { get: { summary: 'Stock balance of a branch', tags: ['Stock'], ...secured('stock:read'), parameters: [branchQ(true), ...page], responses: ok(list('Stock')) } },
      '/public/sales': {
        get: { summary: 'Receipts for a period', tags: ['Sales'], ...secured('sales:read'), parameters: [...page, { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } }, { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } }, branchQ(false), { name: 'number', in: 'query', schema: { type: 'string' } }], responses: ok(list('Sale')) },
        post: { summary: 'Register a sale from an external system', description: 'Booked on an open shift of a terminal reserved for the integration. Idempotent on `clientRequestId`.', tags: ['Sales'], ...secured('sales:write'), requestBody: { required: true, content: { 'application/json': { schema: ref('SaleInput') } } }, responses: { 201: { description: 'Created', content: { 'application/json': { schema: one('Sale') } } }, 200: { description: 'Duplicate request: the original receipt' }, 422: { description: 'Business rule (NO_PRICE, INSUFFICIENT_STOCK, PAYMENT_INSUFFICIENT...)' } } },
      },
      '/public/sales/{id}': { get: { summary: 'Receipt details', tags: ['Sales'], ...secured('sales:read'), parameters: [idParam], responses: ok(one('Sale')) } },
      '/public/customers': { get: { summary: 'Customers and bonus balances', tags: ['Customers'], ...secured('customers:read'), parameters: [...page, { name: 'q', in: 'query', schema: { type: 'string' } }], responses: ok(list('Customer')) } },
      '/public/reports/daily': { get: { summary: 'Daily totals per branch', tags: ['Reports'], ...secured('reports:read'), parameters: [{ name: 'from', in: 'query', schema: { type: 'string', example: '2026-11-01' } }, { name: 'to', in: 'query', schema: { type: 'string', example: '2026-11-06' } }, branchQ(false)], responses: ok({ type: 'object', properties: { data: { type: 'array', items: ref('DailyReport') } } }) } },
    },
    'x-webhooks': {
      description: 'Signed POST requests. Header `X-Kass-Signature: sha256=<hex>` = HMAC-SHA256(secret, `${X-Kass-Timestamp}.${rawBody}`). Retried with exponential backoff for up to 24 hours until a 2xx answer.',
      events: WEBHOOK_EVENTS,
    },
    'x-changelog': API_CHANGELOG,
  };
}

export const docsRouter = Router();
docsRouter.get('/openapi.json', h(async (_req, res) => void res.json(buildOpenApi())));
docsRouter.get('/changelog', h(async (_req, res) => void res.json({ data: API_CHANGELOG })));
