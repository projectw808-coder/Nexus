/**
 * The default tenant runtime, bound lazily to the process-wide client so importing @nexus/db
 * for enums and types never requires DATABASE_URL.
 */
import { createTenantRuntime, type TenantRuntime } from './scoped.ts';
import { createTenancy, type Tenancy } from './tenancy.ts';

let cached: TenantRuntime | undefined;

async function get(): Promise<TenantRuntime> {
  if (!cached) {
    const { getBasePrisma } = await import('./client.ts');
    cached = createTenantRuntime(await getBasePrisma());
  }
  return cached;
}

export const withTenant: TenantRuntime['withTenant'] = async (actor, fn, opts) =>
  (await get()).withTenant(actor, fn, opts);

/** @internal cross-tenant scope — importable only from packages/db and apps/worker/src/system. */
export const withSystem: TenantRuntime['withSystem'] = async (fn, opts) =>
  (await get()).withSystem(fn, opts);

/** The default runtime as one object, for code that takes a `TenantRuntime` (tRPC context). */
export const runtime: TenantRuntime = { withTenant, withSystem };

export const tenancy: Tenancy = createTenancy(runtime);
