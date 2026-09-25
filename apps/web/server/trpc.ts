/**
 * tRPC foundation (§11.1). Three procedure tiers:
 *
 *  - publicProcedure  — no session (invitation preview, health).
 *  - userProcedure    — signed-in user, no workspace (list/create workspaces, accept invite).
 *  - tenantProcedure  — signed-in member of `ctx.slug`: the resolver runs inside
 *    `withTenant(actor)` (one transaction, RLS set, scoped client), with a CASL ability and an
 *    audit recorder. A mutation that finishes without writing an audit row is rejected and
 *    rolled back — "every mutation writes an audit row" is enforced, not remembered.
 *
 * `authorize(action, subject)` gates a procedure on the ability. `NexusError`s thrown inside
 * resolvers become TRPCErrors with the taxonomy code and remediation attached under
 * `error.data.nexus`, so the UI renders the sentence from §9.2.
 */
import { NexusError, type FailureClass } from '@nexus/core';
import {
  writeAudit,
  TenantScopeError,
  type Actor,
  type AuditEntry,
  type Tenancy,
  type TenantDb,
  type TenantRuntime,
} from '@nexus/db';
import { initTRPC, TRPCError, type TRPC_ERROR_CODE_KEY } from '@trpc/server';
import superjson from 'superjson';
import type { MailProvider } from '@/lib/mail/provider';
import type { SyncDeps } from '@nexus/sync';
import type { JobDispatcher } from './jobs';
import { defineAbilityFor, type Action, type AppAbility, type Subject } from './abilities';

export type SessionUser = { id: string; email: string; name: string | null };

export type Context = {
  session: SessionUser | null;
  /** Workspace slug the request addresses (header `x-nexus-workspace` or explicit). */
  slug: string | null;
  ip: string | null;
  userAgent: string | null;
  runtime: TenantRuntime;
  tenancy: Tenancy;
  mail: MailProvider;
  appUrl: string;
  jobs: JobDispatcher;
  /** The sync engine handle (Phase 4): registry, vault, limiter and bus. */
  sync: SyncDeps;
};

export type AuditRecorder = {
  (entry: AuditEntry): Promise<void>;
  readonly count: number;
};

export type TenantContext = Context & {
  session: SessionUser;
  actor: Actor;
  workspace: { id: string; name: string; slug: string };
  ability: AppAbility;
  db: TenantDb;
  audit: AuditRecorder;
};

const CODE_MAP: Record<FailureClass, TRPC_ERROR_CODE_KEY> = {
  AUTH_EXPIRED: 'UNAUTHORIZED',
  SCOPE_MISSING: 'FORBIDDEN',
  RATE_LIMITED: 'TOO_MANY_REQUESTS',
  QUOTA_EXHAUSTED: 'TOO_MANY_REQUESTS',
  PLATFORM_DOWN: 'BAD_GATEWAY',
  SCHEMA_DRIFT: 'UNPROCESSABLE_CONTENT',
  POLICY_BLOCKED: 'PRECONDITION_FAILED',
  DUPLICATE: 'CONFLICT',
  VALIDATION: 'BAD_REQUEST',
  NOT_FOUND: 'NOT_FOUND',
  FORBIDDEN: 'FORBIDDEN',
  CONFLICT: 'CONFLICT',
  INTERNAL: 'INTERNAL_SERVER_ERROR',
};

export function toTrpcError(e: unknown): TRPCError {
  if (e instanceof TRPCError) {
    // tRPC wraps anything thrown by a resolver or a later middleware as INTERNAL_SERVER_ERROR
    // with the original under `cause`; classify from the cause when it is one of ours.
    if (e.code === 'INTERNAL_SERVER_ERROR' && e.cause && !(e.cause instanceof TRPCError)) {
      return toTrpcError(e.cause);
    }
    return e;
  }
  if (NexusError.is(e)) {
    return new TRPCError({ code: CODE_MAP[e.code], message: e.userMessage || e.message, cause: e });
  }
  if (e instanceof TenantScopeError) {
    // A scoping violation is a programming error, never a user error; do not leak details.
    return new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Request could not be completed.',
      cause: e,
    });
  }
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Something went wrong on our side.',
    cause: e instanceof Error ? e : undefined,
  });
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    const cause = error.cause;
    const nexus = NexusError.is(cause)
      ? { code: cause.code, userMessage: cause.userMessage, remediation: cause.remediation }
      : null;
    return { ...shape, data: { ...shape.data, nexus } };
  },
});

export const router = t.router;
export const mergeRouters = t.mergeRouters;
export const createCallerFactory = t.createCallerFactory;
export const publicProcedure = t.procedure;

const errorBoundary = t.middleware(async ({ next }) => {
  const result = await next();
  if (!result.ok) throw toTrpcError(result.error);
  return result;
});

export const userProcedure = t.procedure.use(errorBoundary).use(async ({ ctx, next }) => {
  if (!ctx.session) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in to continue.' });
  return next({ ctx: { ...ctx, session: ctx.session } });
});

export const tenantProcedure = userProcedure.use(async ({ ctx, next, type, path }) => {
  if (!ctx.slug) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'No workspace selected.' });
  }
  const resolved = await ctx.tenancy.resolveActor(ctx.session.id, ctx.slug, {
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
  if (!resolved) {
    // Not a member (or the workspace does not exist): indistinguishable on purpose.
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace not found.' });
  }
  const { workspace, ...actor } = resolved;
  const ability = defineAbilityFor(actor);

  return ctx.runtime.withTenant(actor, async (db) => {
    let count = 0;
    const record = async (entry: AuditEntry): Promise<void> => {
      await writeAudit(db, actor, entry);
      count += 1;
    };
    const audit = Object.defineProperty(record, 'count', { get: () => count }) as AuditRecorder;

    const result = await next({
      ctx: { ...ctx, actor, workspace, ability, db, audit } satisfies TenantContext,
    });
    if (!result.ok) throw result.error; // rolls the transaction back
    if (type === 'mutation' && audit.count === 0) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Request could not be completed.',
        cause: new Error(`mutation ${path} completed without writing an audit row`),
      });
    }
    return result;
  });
});

/**
 * Like tenantProcedure but WITHOUT the ambient transaction: for long-running work (imports,
 * index builds) that opens its own short transactions through `ctx.runtime`. Mutations audit
 * through `ctx.audit`, which writes in a transaction of its own.
 */
export const tenantJobProcedure = userProcedure.use(async ({ ctx, next, type, path }) => {
  if (!ctx.slug) throw new TRPCError({ code: 'BAD_REQUEST', message: 'No workspace selected.' });
  const resolved = await ctx.tenancy.resolveActor(ctx.session.id, ctx.slug, {
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
  if (!resolved) throw new TRPCError({ code: 'NOT_FOUND', message: 'Workspace not found.' });
  const { workspace, ...actor } = resolved;
  const ability = defineAbilityFor(actor);
  let count = 0;
  const record = async (entry: AuditEntry): Promise<void> => {
    await ctx.runtime.withTenant(actor, (db) => writeAudit(db, actor, entry));
    count += 1;
  };
  const audit = Object.defineProperty(record, 'count', { get: () => count }) as AuditRecorder;
  const result = await next({ ctx: { ...ctx, actor, workspace, ability, audit } });
  if (result.ok && type === 'mutation' && audit.count === 0) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Request could not be completed.',
      cause: new Error(`mutation ${path} completed without writing an audit row`),
    });
  }
  return result;
});

export type TenantJobContext = Omit<TenantContext, 'db'>;

/** Gate a tenant procedure on the CASL ability. */
export function authorize(action: Action, subject: Subject) {
  return t.middleware(async ({ ctx, next }) => {
    const ability = (ctx as Partial<TenantContext>).ability;
    if (!ability || !ability.can(action, subject)) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'You do not have permission to do that.',
        cause: new NexusError('FORBIDDEN', { details: { action, subject } }),
      });
    }
    return next();
  });
}
