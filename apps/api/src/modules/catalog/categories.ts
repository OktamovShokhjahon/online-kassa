import { Router } from 'express';
import { z } from 'zod';
import { categoryInputSchema, categoryMoveProductsSchema, objectId } from '@kass/shared';
import { audit } from '../../lib/audit';
import { notFound, unprocessable } from '../../lib/errors';
import { created, h, ok, repo } from '../../lib/http';
import { oid } from '../../lib/util';
import { authenticate, requirePermission } from '../../middleware/auth';
import { validate } from '../../middleware/core';
import { Category, Product } from '../../models/catalog';

export const categoriesRouter = Router();
categoriesRouter.use(authenticate);

const idParams = validate({ params: z.object({ id: objectId }) });
const MAX_DEPTH = 3;

/** ids of a category and all its descendants (used by product filters and bulk price changes). */
export async function categoryWithDescendants(req: Parameters<typeof repo>[0], id: string) {
  const rows = await repo(req, Category).find({ $or: [{ _id: id }, { path: oid(id) }] }).select('_id').lean();
  return rows.map((r) => r._id);
}

categoriesRouter.get(
  '/',
  h(async (req, res) => {
    const [cats, counts] = await Promise.all([
      repo(req, Category).find({}, { sort: 'depth sortOrder name' }),
      repo(req, Product).aggregate([{ $group: { _id: '$categoryId', n: { $sum: 1 } } }]),
    ]);
    const byCat = new Map(counts.map((c: any) => [String(c._id), c.n]));
    ok(res, cats.map((c) => ({ ...c.toJSON(), productCount: byCat.get(String(c._id)) ?? 0 })));
  }),
);

categoriesRouter.post(
  '/',
  requirePermission('categories.manage'),
  validate({ body: categoryInputSchema }),
  h(async (req, res) => {
    const r = repo(req, Category);
    let depth = 1;
    let path: any[] = [];
    if (req.body.parentId) {
      const parent = await r.findById(req.body.parentId);
      if (!parent) throw notFound();
      if (parent.depth >= MAX_DEPTH) throw unprocessable('CATEGORY_DEPTH');
      depth = parent.depth + 1;
      path = [...parent.path, parent._id];
    }
    const cat = await r.create({ ...req.body, parentId: req.body.parentId ?? null, depth, path });
    await audit(req, { action: 'category.created', entity: 'category', entityId: cat._id, after: cat });
    created(res, cat.toJSON());
  }),
);

categoriesRouter.patch(
  '/:id',
  idParams,
  requirePermission('categories.manage'),
  validate({ body: categoryInputSchema.partial() }),
  h(async (req, res) => {
    const r = repo(req, Category);
    const cat = await r.findById(req.params.id);
    if (!cat) throw notFound();
    const before = cat.toObject();
    const { parentId, ...rest } = req.body;
    Object.assign(cat, rest);

    if (parentId !== undefined && String(parentId ?? '') !== String(cat.parentId ?? '')) {
      const descendants = await r.find({ path: cat._id });
      let newDepth = 1;
      let newPath: any[] = [];
      if (parentId) {
        const parent = await r.findById(parentId);
        if (!parent) throw notFound();
        // a category cannot become its own descendant's child
        if (String(parent._id) === String(cat._id) || parent.path.some((p) => String(p) === String(cat._id))) {
          throw unprocessable('CATEGORY_DEPTH');
        }
        newDepth = parent.depth + 1;
        newPath = [...parent.path, parent._id];
      }
      const subtreeHeight = descendants.reduce((m, d) => Math.max(m, d.depth - cat.depth), 0);
      if (newDepth + subtreeHeight > MAX_DEPTH) throw unprocessable('CATEGORY_DEPTH');
      const depthDelta = newDepth - cat.depth;
      for (const d of descendants) {
        const idx = d.path.findIndex((p) => String(p) === String(cat._id));
        d.path = [...newPath, cat._id, ...d.path.slice(idx + 1)] as any;
        d.depth += depthDelta;
        await d.save();
      }
      cat.parentId = (parentId ? oid(parentId) : null) as any;
      cat.depth = newDepth;
      cat.path = newPath as any;
    }
    await cat.save();
    await audit(req, { action: 'category.updated', entity: 'category', entityId: cat._id, before, after: cat });
    ok(res, cat.toJSON());
  }),
);

/** Moves every product of a category to another one (or to "no category"). */
categoriesRouter.post(
  '/:id/move-products',
  idParams,
  requirePermission('categories.manage', 'products.manage'),
  validate({ body: categoryMoveProductsSchema }),
  h(async (req, res) => {
    const r = repo(req, Category);
    if (!(await r.exists({ _id: req.params.id }))) throw notFound();
    if (req.body.toCategoryId && !(await r.exists({ _id: req.body.toCategoryId }))) throw notFound();
    const result = await repo(req, Product).updateMany(
      { categoryId: req.params.id },
      { $set: { categoryId: req.body.toCategoryId ? oid(req.body.toCategoryId) : null } },
    );
    await audit(req, { action: 'category.products_moved', entity: 'category', entityId: req.params.id, meta: { to: req.body.toCategoryId, count: result.modifiedCount } });
    ok(res, { moved: result.modifiedCount });
  }),
);

categoriesRouter.delete(
  '/:id',
  idParams,
  requirePermission('categories.manage'),
  h(async (req, res) => {
    const r = repo(req, Category);
    const cat = await r.findById(req.params.id);
    if (!cat) throw notFound();
    if (await r.exists({ parentId: cat._id })) throw unprocessable('CATEGORY_HAS_CHILDREN');
    // A category with products cannot be deleted; it can be deactivated or its products moved.
    if (await repo(req, Product).exists({ categoryId: cat._id })) throw unprocessable('CATEGORY_HAS_PRODUCTS');
    await r.deleteOne({ _id: cat._id });
    await audit(req, { action: 'category.deleted', entity: 'category', entityId: cat._id, before: cat });
    ok(res, { deleted: true });
  }),
);

