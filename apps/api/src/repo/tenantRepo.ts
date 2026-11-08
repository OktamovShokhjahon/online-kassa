import type { ClientSession, Model, PipelineStage, Types } from 'mongoose';

type Filter = Record<string, any>;
interface Opts {
  session?: ClientSession | null;
  select?: string | Record<string, 0 | 1>;
  sort?: string | Record<string, 1 | -1>;
  lean?: boolean;
}

/**
 * Tenant-scoped repository (spec 3.1). The `shopId` always comes from the authenticated
 * session, never from request input, and is applied LAST so a caller-supplied `shopId`
 * in a filter or document can never override it. Controllers must not build tenant
 * filters themselves.
 */
export class TenantRepo<T = any> {
  constructor(
    readonly model: Model<T>,
    readonly shopId: Types.ObjectId,
  ) {}

  scope(filter: Filter = {}): Filter {
    return { ...filter, shopId: this.shopId };
  }

  find(filter: Filter = {}, opts: Opts = {}) {
    let q = this.model.find(this.scope(filter));
    if (opts.select) q = q.select(opts.select);
    if (opts.sort) q = q.sort(opts.sort);
    if (opts.session) q = q.session(opts.session);
    return q;
  }

  findOne(filter: Filter = {}, opts: Opts = {}) {
    let q = this.model.findOne(this.scope(filter));
    if (opts.select) q = q.select(opts.select);
    if (opts.session) q = q.session(opts.session);
    return q;
  }

  findById(id: string | Types.ObjectId, opts: Opts = {}) {
    return this.findOne({ _id: id }, opts);
  }

  count(filter: Filter = {}) {
    return this.model.countDocuments(this.scope(filter));
  }

  exists(filter: Filter = {}) {
    return this.model.exists(this.scope(filter));
  }

  async create(doc: Filter, session?: ClientSession | null) {
    const [created] = await this.model.create([{ ...doc, shopId: this.shopId }], { session: session ?? undefined });
    return created as any;
  }

  async insertMany(docs: Filter[], session?: ClientSession | null) {
    return this.model.insertMany(
      docs.map((d) => ({ ...d, shopId: this.shopId })),
      { session: session ?? undefined },
    );
  }

  updateOne(filter: Filter, update: Filter, session?: ClientSession | null) {
    return this.model.updateOne(this.scope(filter), update, { session: session ?? undefined });
  }

  updateMany(filter: Filter, update: Filter, session?: ClientSession | null) {
    return this.model.updateMany(this.scope(filter), update, { session: session ?? undefined });
  }

  findOneAndUpdate(filter: Filter, update: Filter, opts: Filter = {}) {
    return this.model.findOneAndUpdate(this.scope(filter), update, { new: true, ...opts });
  }

  deleteOne(filter: Filter, session?: ClientSession | null) {
    return this.model.deleteOne(this.scope(filter), { session: session ?? undefined });
  }

  bulkWrite(ops: any[], session?: ClientSession | null) {
    const scoped = ops.map((op) => {
      const k = Object.keys(op)[0];
      const body = { ...op[k] };
      if (body.filter) body.filter = this.scope(body.filter);
      if (body.document) body.document = { ...body.document, shopId: this.shopId };
      if (body.upsert && body.update && k !== 'replaceOne') {
        body.update = { ...body.update, $setOnInsert: { ...(body.update.$setOnInsert ?? {}), shopId: this.shopId } };
      }
      return { [k]: body };
    });
    return this.model.bulkWrite(scoped as any, { session: session ?? undefined });
  }

  /** Aggregation always starts with the tenant `$match`. */
  aggregate<R = any>(pipeline: PipelineStage[], session?: ClientSession | null) {
    const agg = this.model.aggregate<R>([{ $match: { shopId: this.shopId } }, ...pipeline]);
    if (session) agg.session(session);
    return agg;
  }

  /** Paged list `{ items, meta }` following the API convention. */
  async paginate(
    filter: Filter,
    { page, limit, sort }: { page: number; limit: number; sort?: string | Record<string, 1 | -1> },
    opts: { select?: string } = {},
  ) {
    const q = this.scope(filter);
    const [items, total] = await Promise.all([
      this.model
        .find(q)
        .select(opts.select ?? '')
        .sort(sort ?? '-createdAt')
        .skip((page - 1) * limit)
        .limit(limit),
      this.model.countDocuments(q),
    ]);
    return { items, meta: { page, limit, total } };
  }
}
