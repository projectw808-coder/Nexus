import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseArgs } from './index.ts';
import { renderTemplates, scaffoldConnector } from './new-connector.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'nexus-cli-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('argument parsing', () => {
  it('splits positionals and flags', () => {
    expect(parseArgs(['dlq', 'replay', 'abc', '--workspace', 'ws1', '--all'])).toEqual({
      _: ['dlq', 'replay', 'abc'],
      flags: { workspace: 'ws1', all: true },
    });
  });
});

describe('new-connector', () => {
  it('renders every file with the name substituted and no leftover placeholders', () => {
    const files = renderTemplates({ name: 'Acme Social', platform: 'MOCK', rootDir: dir });
    const paths = Object.keys(files);
    expect(paths).toContain('packages/connectors/acme-social/src/connector.ts');
    expect(paths).toContain('packages/connectors/acme-social/src/connector.test.ts');
    expect(paths).toContain('docs/connectors/acme-social.md');
    for (const [p, content] of Object.entries(files)) {
      expect(content, p).not.toMatch(/__[A-Z]+__/);
    }
    expect(files['packages/connectors/acme-social/src/manifest.ts']).toContain("platform: 'MOCK'");
    expect(files['packages/connectors/acme-social/src/index.ts']).toContain(
      'createAcmeSocialConnector',
    );
    // Identifiers derived from a hyphenated name must stay valid TypeScript.
    expect(files['packages/connectors/acme-social/src/manifest.ts']).toContain(
      'export const acmeSocialManifest',
    );
    expect(files['packages/connectors/acme-social/src/connector.ts']).not.toMatch(
      /acme-socialManifest/,
    );
    expect(
      JSON.parse(files['packages/connectors/acme-social/package.json']!) as { name: string },
    ).toMatchObject({ name: '@nexus/connector-acme-social' });
  });

  it('names the one core touch a brand-new platform needs', () => {
    expect(() => renderTemplates({ name: 'Acme Social', rootDir: dir })).toThrow(
      /Platform.*schema.prisma/,
    );
  });

  it('writes the tree and refuses to overwrite without --force', () => {
    const written = scaffoldConnector({ name: 'demo', platform: 'MOCK', rootDir: dir });
    expect(written.length).toBe(9);
    expect(
      readFileSync(path.join(dir, 'packages/connectors/demo/src/manifest.ts'), 'utf8'),
    ).toContain("platform: 'MOCK'");
    expect(() => scaffoldConnector({ name: 'demo', platform: 'MOCK', rootDir: dir })).toThrow(
      /already exists/,
    );
    expect(
      scaffoldConnector({ name: 'demo', platform: 'MOCK', rootDir: dir, force: true }).length,
    ).toBe(9);
  });
});
