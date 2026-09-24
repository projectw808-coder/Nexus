/**
 * The tenant-scoped client (§5.3) — the security boundary of the application.
 *
 * `withTenant(actor, fn)` is the only sanctioned way to read or write tenant data. It opens a
 * transaction, issues `SET LOCAL app.workspace_id` so Postgres row-level security applies (the
 * belt), and hands `fn` a Prisma client extension that rewrites every operation on a tenant
 * model to carry the actor's workspaceId (the braces):
 *
 *  - reads and bulk writes get `workspaceId` AND-ed into `where`;
 *  - unique-where operations (findUnique, update, delete, upsert) get `workspaceId` added as a
 *    top-level filter (Prisma's extended where-unique), or throw if it disagrees;
 *  - creates must carry the actor's workspaceId explicitly — never defaulted, never mismatched;
 *  - `include` / `select` of list relations, relation filters in `where`, and nested writes are
 *    walked recursively using MODEL_META so a scoped Person query cannot reach another
 *    tenant's Conversations through a relation;
 *  - `Workspace` itself is scoped by `id`.
 *
 * `TENANT_MODELS` and `MODEL_META` are generated from the Prisma data model, so a new model is
 * scoped the moment it has a `workspaceId` field. Raw SQL is banned outside packages/db by lint.
 */
import type { PrismaClient } from './generated/prisma/client.ts';
import type { ActorType, ConnPermission, Role } from './generated/prisma/enums.ts';
import { MODEL_META, TENANT_MODELS } from './generated-tenant-models.ts';

export type ActorGrant = { connectionId: string; permission: ConnPermission };

/** Who is acting, in which workspace, with what standing. Built once per request. */
export type Actor = {
  workspaceId: string;
  /** null for API keys, workflows, connectors and system jobs. */
  userId: string | null;
  role: Role;
  grants: readonly ActorGrant[];
  actorType?: ActorType;
  /** ApiKey id / workflow id / connection id when actorType is not USER. */
  actorRef?: string | null;
  ip?: string | null;
  userAgent?: string | null;
};

export class TenantScopeError extends Error {
  override readonly name = 'TenantScopeError';
  constructor(
    message: string,
    readonly model: string,
    readonly operation: string,
  ) {
    super(`[${model}.${operation}] ${message}`);
  }
}

type Dict = Record<string, unknown>;
const isDict = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);

const UNIQUE_WHERE_OPS = new Set(['findUnique', 'findUniqueOrThrow', 'update', 'delete', 'upsert']);
const FILTER_WHERE_OPS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'updateMany',
  'updateManyAndReturn',
  'deleteMany',
]);
const CREATE_OPS = new Set(['create', 'createMany', 'createManyAndReturn']);

const TENANT_FIELD = 'workspaceId';

function relationsOf(model: string) {
  return MODEL_META[model]?.relations ?? {};
}

function isTenant(model: string): boolean {
  return TENANT_MODELS.has(model);
}

// ── where ─────────────────────────────────────────────────────────────────────

/** AND a workspace filter into a non-unique where. */
function andTenant(where: unknown, ws: string, model: string): Dict {
  const scoped = scopeWhere(model, where, ws);
  return { AND: [scoped ?? {}, { [TENANT_FIELD]: ws }] };
}

/** Add workspaceId as a top-level field of a unique where; throw on disagreement. */
function uniqueTenant(where: unknown, ws: string, model: string, op: string): Dict {
  const w = isDict(where) ? scopeWhere(model, where, ws) : {};
  const existing = (w as Dict)[TENANT_FIELD];
  if (existing !== undefined && existing !== ws) {
    throw new TenantScopeError(
      `where.${TENANT_FIELD} does not match the actor's workspace`,
      model,
      op,
    );
  }
  return { ...(w as Dict), [TENANT_FIELD]: ws };
}

/** Walk a where tree and scope relation filters (some/every/none/is/isNot) to the tenant. */
function scopeWhere(model: string, where: unknown, ws: string): unknown {
  if (Array.isArray(where)) return where.map((w) => scopeWhere(model, w, ws));
  if (!isDict(where)) return where;
  const rels = relationsOf(model);
  const out: Dict = {};
  for (const [key, value] of Object.entries(where)) {
    if (key === 'AND' || key === 'OR' || key === 'NOT') {
      out[key] = scopeWhere(model, value, ws);
      continue;
    }
    const rel = rels[key];
    if (!rel || !isDict(value)) {
      out[key] = value;
      continue;
    }
    const target = rel.model;
    if (rel.isList) {
      const scopedList: Dict = {};
      for (const [q, filter] of Object.entries(value)) {
        scopedList[q] =
          (q === 'some' || q === 'every' || q === 'none') && isTenant(target)
            ? andTenant(filter, ws, target)
            : filter;
      }
      out[key] = scopedList;
    } else if ('is' in value || 'isNot' in value) {
      const scopedOne: Dict = {};
      for (const [q, filter] of Object.entries(value)) {
        scopedOne[q] =
          filter === null || !isTenant(target) ? filter : andTenant(filter, ws, target);
      }
      out[key] = scopedOne;
    } else {
      out[key] = isTenant(target) ? andTenant(value, ws, target) : value;
    }
  }
  return out;
}

// ── include / select ──────────────────────────────────────────────────────────

function scopeSelection(model: string, selection: unknown, ws: string): unknown {
  if (!isDict(selection)) return selection;
  const rels = relationsOf(model);
  const out: Dict = {};
  for (const [key, value] of Object.entries(selection)) {
    const rel = rels[key];
    if (!rel || !value) {
      out[key] = value;
      continue;
    }
    const target = rel.model;
    const sub: Dict = isDict(value) ? { ...value } : {};
    if (rel.isList && isTenant(target)) {
      sub['where'] = andTenant(sub['where'], ws, target);
    } else if (isDict(sub['where'])) {
      sub['where'] = scopeWhere(target, sub['where'], ws);
    }
    if (sub['include']) sub['include'] = scopeSelection(target, sub['include'], ws);
    if (sub['select']) sub['select'] = scopeSelection(target, sub['select'], ws);
    out[key] = sub;
  }
  return out;
}

// ── data (creates and nested writes) ──────────────────────────────────────────

/** §5.3 assertWorkspace: throws on a missing OR mismatched workspaceId. Never defaults. */
function assertWorkspace(data: unknown, ws: string, model: string, op: string): void {
  if (!isDict(data)) throw new TenantScopeError('create data must be an object', model, op);
  const direct = data[TENANT_FIELD];
  const workspace = data['workspace'];
  const viaRelation = isDict(workspace) ? workspace['connect'] : undefined;
  const connected = isDict(viaRelation) ? viaRelation['id'] : undefined;
  const given = direct ?? connected;
  if (given === undefined) {
    throw new TenantScopeError(`${TENANT_FIELD} is required on create`, model, op);
  }
  if (given !== ws) {
    throw new TenantScopeError(`${TENANT_FIELD} does not match the actor's workspace`, model, op);
  }
}

function scopeData(
  model: string,
  data: unknown,
  ws: string,
  op: string,
  creating: boolean,
): unknown {
  if (Array.isArray(data)) return data.map((d) => scopeData(model, d, ws, op, creating));
  if (!isDict(data)) return data;
  if (isTenant(model)) {
    if (creating) assertWorkspace(data, ws, model, op);
    else if (data[TENANT_FIELD] !== undefined && data[TENANT_FIELD] !== ws) {
      throw new TenantScopeError('rows cannot be moved to another workspace', model, op);
    }
  }
  const rels = relationsOf(model);
  const out: Dict = {};
  for (const [key, value] of Object.entries(data)) {
    const rel = rels[key];
    if (!rel || !isDict(value)) {
      out[key] = value;
      continue;
    }
    out[key] = scopeNestedWrite(rel.model, value, ws, op);
  }
  return out;
}

function scopeNestedWrite(target: string, nested: Dict, ws: string, op: string): Dict {
  const out: Dict = {};
  for (const [verb, value] of Object.entries(nested)) {
    switch (verb) {
      case 'create':
        out[verb] = scopeData(target, value, ws, op, true);
        break;
      case 'createMany': {
        const v = isDict(value) ? { ...value } : value;
        if (isDict(v) && v['data'] !== undefined)
          v['data'] = scopeData(target, v['data'], ws, op, true);
        out[verb] = v;
        break;
      }
      case 'connectOrCreate': {
        const items: unknown[] = Array.isArray(value) ? (value as unknown[]) : [value];
        const scoped = items.map((item) =>
          isDict(item)
            ? {
                ...item,
                where: isTenant(target)
                  ? uniqueTenant(item['where'], ws, target, op)
                  : item['where'],
                create: scopeData(target, item['create'], ws, op, true),
              }
            : item,
        );
        out[verb] = Array.isArray(value) ? scoped : scoped[0];
        break;
      }
      case 'update':
      case 'upsert': {
        const items: unknown[] = Array.isArray(value) ? (value as unknown[]) : [value];
        const scoped = items.map((item) => {
          if (!isDict(item)) return item;
          const next: Dict = { ...item };
          if ('where' in item && isTenant(target))
            next['where'] = uniqueTenant(item['where'], ws, target, op);
          if ('data' in item) next['data'] = scopeData(target, item['data'], ws, op, false);
          if ('update' in item) next['update'] = scopeData(target, item['update'], ws, op, false);
          if ('create' in item) next['create'] = scopeData(target, item['create'], ws, op, true);
          // to-one `update: { field: value }` (no where) is plain data
          if (
            !('where' in item) &&
            !('data' in item) &&
            !('update' in item) &&
            !('create' in item)
          ) {
            return scopeData(target, item, ws, op, false);
          }
          return next;
        });
        out[verb] = Array.isArray(value) ? scoped : scoped[0];
        break;
      }
      case 'updateMany': {
        // nested updateMany: { where, data } | [...]
        const items: unknown[] = Array.isArray(value) ? (value as unknown[]) : [value];
        const scoped = items.map((item) => {
          if (!isDict(item)) return item;
          const next: Dict = { ...item };
          next['where'] = isTenant(target)
            ? andTenant(item['where'], ws, target)
            : scopeWhere(target, item['where'], ws);
          if ('data' in item) next['data'] = scopeData(target, item['data'], ws, op, false);
          return next;
        });
        out[verb] = Array.isArray(value) ? scoped : scoped[0];
        break;
      }
      case 'deleteMany': {
        // nested deleteMany: the value IS the filter (or an array of filters)
        const items: unknown[] = Array.isArray(value) ? (value as unknown[]) : [value];
        const scoped = items.map((filter) =>
          isTenant(target) ? andTenant(filter, ws, target) : scopeWhere(target, filter, ws),
        );
        out[verb] = Array.isArray(value) ? scoped : scoped[0];
        break;
      }
      default:
        // connect / disconnect / set by id: cannot be verified client-side; RLS rejects a
        // cross-tenant target at the database.
        out[verb] = value;
    }
  }
  return out;
}

// ── the rewrite ───────────────────────────────────────────────────────────────

/** Rewrite one operation's args so it cannot leave the actor's workspace. Exported for tests. */
export function scopeArgs(model: string, operation: string, rawArgs: unknown, ws: string): Dict {
  const args: Dict = isDict(rawArgs) ? { ...rawArgs } : {};

  if (model === 'Workspace') return scopeWorkspaceArgs(operation, args, ws);

  // Non-tenant models (User, Auth.js tables) are not filtered themselves, but anything they
  // reach through a relation is: their where / include / select / nested writes are walked too.
  const tenant = isTenant(model);
  if (UNIQUE_WHERE_OPS.has(operation)) {
    args['where'] = tenant
      ? uniqueTenant(args['where'], ws, model, operation)
      : scopeWhere(model, args['where'], ws);
  } else if (FILTER_WHERE_OPS.has(operation)) {
    args['where'] = tenant
      ? andTenant(args['where'], ws, model)
      : scopeWhere(model, args['where'], ws);
  }

  if (CREATE_OPS.has(operation)) {
    args['data'] = scopeData(model, args['data'], ws, operation, true);
  }
  if (operation === 'upsert') {
    args['create'] = scopeData(model, args['create'], ws, operation, true);
    args['update'] = scopeData(model, args['update'], ws, operation, false);
  }
  if (operation === 'update' || operation === 'updateMany' || operation === 'updateManyAndReturn') {
    args['data'] = scopeData(model, args['data'], ws, operation, false);
  }

  if (args['include']) args['include'] = scopeSelection(model, args['include'], ws);
  if (args['select']) args['select'] = scopeSelection(model, args['select'], ws);
  return args;
}

function scopeWorkspaceArgs(operation: string, args: Dict, ws: string): Dict {
  const where = isDict(args['where']) ? args['where'] : {};
  switch (operation) {
    case 'findUnique':
    case 'findUniqueOrThrow':
    case 'update':
    case 'delete':
    case 'upsert': {
      if (where['id'] !== undefined && where['id'] !== ws) {
        throw new TenantScopeError(
          "only the actor's workspace is reachable",
          'Workspace',
          operation,
        );
      }
      if (
        where['slug'] !== undefined &&
        operation !== 'findUnique' &&
        operation !== 'findUniqueOrThrow'
      ) {
        throw new TenantScopeError(
          'write to Workspace must address it by id',
          'Workspace',
          operation,
        );
      }
      args['where'] = { ...(scopeWhere('Workspace', where, ws) as Dict), id: ws };
      break;
    }
    case 'create':
    case 'createMany':
    case 'createManyAndReturn':
      throw new TenantScopeError(
        'workspaces are created through createWorkspace(), not inside a tenant scope',
        'Workspace',
        operation,
      );
    default:
      args['where'] = { AND: [scopeWhere('Workspace', where, ws) ?? {}, { id: ws }] };
  }
  if (isDict(args['data']) && 'id' in args['data']) {
    throw new TenantScopeError('Workspace.id is immutable', 'Workspace', operation);
  }
  if (args['include']) args['include'] = scopeSelection('Workspace', args['include'], ws);
  if (args['select']) args['select'] = scopeSelection('Workspace', args['select'], ws);
  return args;
}

// ── client ────────────────────────────────────────────────────────────────────

export function scopedClient(base: PrismaClient, actor: Actor) {
  const ws = actor.workspaceId;
  return base.$extends({
    name: 'nexus-tenant-scope',
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          return query(scopeArgs(model, operation, args, ws));
        },
      },
    },
  });
}

export type ScopedClient = ReturnType<typeof scopedClient>;
/** The client `withTenant` hands out: a transaction client with the scope extension applied. */
export type TenantDb = Parameters<Parameters<ScopedClient['$transaction']>[0]>[0];
/** The unscoped transaction client `withSystem` hands out. */
export type SystemDb = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

export type TenantContext = {
  actor: Actor;
  db: TenantDb;
};

export type TenantRuntime = {
  /**
   * Run `fn` inside one transaction that has `SET LOCAL app.workspace_id` (RLS) and a scoped
   * client. Every RSC loader, server action, tRPC procedure and queue processor uses this.
   */
  withTenant<T>(
    actor: Actor,
    fn: (db: TenantDb, ctx: TenantContext) => Promise<T>,
    opts?: { timeoutMs?: number },
  ): Promise<T>;
  /**
   * Cross-tenant maintenance only (retention purge, token refresh sweeps, DSAR, auth). Sets
   * `app.rls_bypass = on` for the transaction. Importable only from packages/db and
   * apps/worker/src/system — the `nexus/no-base-prisma` rule enforces it.
   */
  withSystem<T>(fn: (db: SystemDb) => Promise<T>, opts?: { timeoutMs?: number }): Promise<T>;
};

export function createTenantRuntime(base: PrismaClient): TenantRuntime {
  return {
    withTenant(actor, fn, opts) {
      const scoped = scopedClient(base, actor);
      return scoped.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.workspace_id', ${actor.workspaceId}, true)`;
          return fn(tx, { actor, db: tx });
        },
        { maxWait: 5_000, timeout: opts?.timeoutMs ?? 15_000 },
      );
    },
    withSystem(fn, opts) {
      return base.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.rls_bypass', 'on', true)`;
          return fn(tx);
        },
        { maxWait: 5_000, timeout: opts?.timeoutMs ?? 15_000 },
      );
    },
  };
}
