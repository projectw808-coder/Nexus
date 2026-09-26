/**
 * §15 migration drift gate.
 *
 * Runs `prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma`
 * against a shadow database and fails if the migrations and the schema disagree — except for
 * objects that deliberately live outside schema.prisma (GIN/HNSW/trigram indexes, the RLS helper,
 * generated columns for `Attribute.isIndexed`), which are enumerated in
 * `prisma/drift-allowlist.json`. Every statement in the diff must mention an allowlisted object;
 * anything else is real drift.
 *
 * Usage: SHADOW_DATABASE_URL=postgresql://… tsx scripts/drift-gate.ts
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Allowlist = {
  extensions: string[];
  indexes: string[];
  functions: string[];
  patterns: { columns: string[]; indexes: string[]; policies: string[]; functions: string[] };
};

const root = resolve(import.meta.dirname, '..');
const shadowUrl = process.env['SHADOW_DATABASE_URL'];
if (!shadowUrl) {
  console.error(
    'drift-gate: SHADOW_DATABASE_URL is required (an empty database Prisma may reset).',
  );
  process.exit(2);
}

const allow = JSON.parse(
  readFileSync(resolve(root, 'prisma/drift-allowlist.json'), 'utf8'),
) as Allowlist;

const literalNames = [...allow.extensions, ...allow.indexes, ...allow.functions];
const patterns = [
  ...allow.patterns.columns,
  ...allow.patterns.indexes,
  ...allow.patterns.policies,
  ...allow.patterns.functions,
].map((p) => new RegExp(p));

const diff = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  [
    'prisma',
    'migrate',
    'diff',
    '--from-migrations',
    'prisma/migrations',
    '--to-schema',
    'prisma/schema.prisma',
    '--script',
  ],
  {
    cwd: root,
    encoding: 'utf8',
    // Prisma 7 removed the `--shadow-database-url` flag; the shadow URL now comes from
    // prisma.config.ts's `datasource.shadowDatabaseUrl`, which reads this same env var.
    env: { ...process.env, SHADOW_DATABASE_URL: shadowUrl },
    shell: process.platform === 'win32',
  },
);

if (diff.status !== 0 && !diff.stdout) {
  console.error(diff.stderr || diff.stdout);
  process.exit(diff.status ?? 1);
}

const statements = diff.stdout
  .split(/;\s*\n/)
  .map((s) =>
    s
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .trim(),
  )
  .filter((s) => s.length > 0 && !/^This is an empty migration/i.test(s));

/** Identifiers quoted or bare that appear in the statement. */
const identifiersOf = (sql: string): string[] =>
  Array.from(sql.matchAll(/"([^"]+)"|\b([a-z_][a-z0-9_]*)\b/gi)).map((m) => m[1] ?? m[2] ?? '');

const isAllowlisted = (sql: string): boolean => {
  const ids = identifiersOf(sql);
  return ids.some((id) => literalNames.includes(id) || patterns.some((p) => p.test(id)));
};

const drift = statements.filter((s) => !isAllowlisted(s));

if (drift.length === 0) {
  console.log(
    `drift-gate: ok (${statements.length} statement${statements.length === 1 ? '' : 's'} in diff, all allowlisted)`,
  );
  process.exit(0);
}

console.error(
  `drift-gate: ${drift.length} statement(s) differ between migrations and schema.prisma:\n`,
);
for (const s of drift) console.error(`  ${s.replace(/\n/g, '\n  ')};\n`);
console.error(
  'Write a migration (`pnpm db:migrate --name <verb_noun>`) or add the object to prisma/drift-allowlist.json.',
);
process.exit(1);
