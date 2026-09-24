/**
 * Repo-local ESLint rules that enforce the spec's structural guarantees:
 *
 *  - no-direct-platform-fetch (§0.4): nothing outside packages/connectors may call fetch()
 *    against a platform host. All platform I/O goes through the connector SPI.
 *  - no-base-prisma (§5.3): `basePrisma` (the unscoped client) may only be imported inside
 *    packages/db and apps/worker/src/system. Feature code uses the tenant-scoped client.
 *  - no-raw-query (§5.3): `$queryRaw` / `$executeRaw` are banned outside packages/db unless the
 *    call is preceded by a `// nexus-allow-raw: <reason>` comment.
 */

const PLATFORM_HOSTS = [
  'graph.facebook.com',
  'graph.instagram.com',
  'api.twitter.com',
  'api.x.com',
  'api.linkedin.com',
  'open.tiktokapis.com',
  'business-api.tiktok.com',
  'www.googleapis.com',
  'youtube.googleapis.com',
  'gmail.googleapis.com',
  'oauth2.googleapis.com',
  'admin_api/v1', // Keitaro base path
];

const normalize = (p) => String(p).replace(/\\/g, '/');

const isInsideConnectors = (filename) => /\/packages\/connectors\//.test(normalize(filename));
const isInsideDb = (filename) => /\/packages\/db\//.test(normalize(filename));
const isWorkerSystem = (filename) => /\/apps\/worker\/src\/system\//.test(normalize(filename));

const literalOf = (node) => {
  if (!node) return undefined;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral') return node.quasis.map((q) => q.value.cooked ?? '').join('');
  return undefined;
};

const noDirectPlatformFetch = {
  meta: {
    type: 'problem',
    docs: { description: 'Platform HTTP calls must go through the connector SPI (§0.4).' },
    schema: [],
    messages: {
      direct:
        'Direct call to a platform API ({{host}}). Route it through the connector SPI in packages/connectors.',
    },
  },
  create(context) {
    if (isInsideConnectors(context.filename)) return {};
    return {
      CallExpression(node) {
        const callee = node.callee;
        const isFetch =
          (callee.type === 'Identifier' && callee.name === 'fetch') ||
          (callee.type === 'MemberExpression' &&
            callee.property.type === 'Identifier' &&
            callee.property.name === 'fetch');
        if (!isFetch) return;
        const url = literalOf(node.arguments[0]);
        if (!url) return;
        const host = PLATFORM_HOSTS.find((h) => url.includes(h));
        if (host) context.report({ node, messageId: 'direct', data: { host } });
      },
    };
  },
};

const noBasePrisma = {
  meta: {
    type: 'problem',
    docs: { description: 'Only packages/db and apps/worker/src/system may use basePrisma (§5.3).' },
    schema: [],
    messages: {
      banned:
        'basePrisma / withSystem bypass tenant scoping. Use withTenant(actor, db => …) from @nexus/db instead.',
    },
  },
  create(context) {
    const f = context.filename;
    if (isInsideDb(f) || isWorkerSystem(f)) return {};
    return {
      ImportSpecifier(node) {
        const imported =
          node.imported.type === 'Identifier' ? node.imported.name : node.imported.value;
        if (
          imported === 'basePrisma' ||
          imported === 'getBasePrisma' ||
          imported === 'withSystem'
        ) {
          context.report({ node, messageId: 'banned' });
        }
      },
      ImportDeclaration(node) {
        if (/generated\/prisma/.test(String(node.source.value))) {
          context.report({ node, messageId: 'banned' });
        }
      },
    };
  },
};

const noRawQuery = {
  meta: {
    type: 'problem',
    docs: { description: 'Raw SQL needs an explicit workspaceId and an exemption comment (§5.3).' },
    schema: [],
    messages: {
      raw: '{{name}} outside packages/db requires a preceding `// nexus-allow-raw: <reason>` comment.',
    },
  },
  create(context) {
    if (isInsideDb(context.filename)) return {};
    const sourceCode = context.sourceCode;
    return {
      MemberExpression(node) {
        const prop = node.property;
        const name =
          prop.type === 'Identifier'
            ? prop.name
            : prop.type === 'Literal'
              ? String(prop.value)
              : '';
        if (!/^\$(queryRaw|executeRaw|queryRawUnsafe|executeRawUnsafe)$/.test(name)) return;
        const comments = sourceCode.getCommentsBefore(node) ?? [];
        const stmt = sourceCode
          .getAncestors(node)
          .reverse()
          .find((a) => /Statement|Declaration/.test(a.type));
        const stmtComments = stmt ? sourceCode.getCommentsBefore(stmt) : [];
        const ok = [...comments, ...stmtComments].some((c) =>
          /nexus-allow-raw:\s*\S/.test(c.value),
        );
        if (!ok) context.report({ node, messageId: 'raw', data: { name } });
      },
    };
  },
};

const plugin = {
  meta: { name: 'eslint-plugin-nexus', version: '0.0.0' },
  rules: {
    'no-direct-platform-fetch': noDirectPlatformFetch,
    'no-base-prisma': noBasePrisma,
    'no-raw-query': noRawQuery,
  },
};

export default plugin;
