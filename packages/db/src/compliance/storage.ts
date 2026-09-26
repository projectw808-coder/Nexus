/**
 * `ExportStorage` — where a DSAR portable export is parked, and what
 * `DataSubjectRequest.exportRef` points at (§5.5).
 *
 * The seam mirrors `@nexus/mail`'s `MailProvider` exactly: an interface, a real S3-compatible
 * implementation, an in-memory one, and a `getExportStorage()`/`setExportStorage()` pair so a
 * test can inject the memory one.
 *
 * The S3 implementation signs requests with AWS Signature V4 over `fetch` and `node:crypto`
 * rather than pulling in `@aws-sdk/client-s3`: PUT and GET of a single object is all a DSAR
 * export needs, the whole surface is ~70 lines, and the monorepo stays free of a large
 * transitive dependency tree (and of a lockfile change, while two other engineers are landing
 * in this same phase). `S3_ENDPOINT`/`S3_BUCKET`/`S3_ACCESS_KEY`/`S3_SECRET_KEY`/`S3_REGION`/
 * `S3_FORCE_PATH_STYLE` are read from `process.env` directly, the same way src/client.ts reads
 * `DATABASE_URL` — @nexus/db deliberately does not depend on @nexus/config.
 *
 * `ref` is an opaque handle (`s3://bucket/key` or `memory://key`), never a URL with credentials
 * in it, and never something the web tier hands to a browser unmediated.
 */
import { createHash, createHmac } from 'node:crypto';

export type PutResult = { ref: string };

export interface ExportStorage {
  /** Store `content` (UTF-8 text — a DSAR export is JSON) under `key`; returns its handle. */
  put(key: string, content: string): Promise<PutResult>;
  /** Read back what `ref` points at. Throws if it is not there. */
  get(ref: string): Promise<string>;
}

export type S3Config = {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
  forcePathStyle: boolean;
};

/** Records objects in a Map instead of writing them. Used by tests and when S3 is unconfigured. */
export class MemoryExportStorage implements ExportStorage {
  readonly objects = new Map<string, string>();
  async put(key: string, content: string): Promise<PutResult> {
    this.objects.set(key, content);
    return { ref: `memory://${key}` };
  }
  async get(ref: string): Promise<string> {
    const key = ref.startsWith('memory://') ? ref.slice('memory://'.length) : ref;
    const value = this.objects.get(key);
    if (value === undefined) throw new Error(`export not found: ${ref}`);
    return value;
  }
}

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');
const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac('sha256', key).update(data, 'utf8').digest();

/** RFC 3986 encoding of one path segment (AWS SigV4 requires `/` to stay unescaped in the path). */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Any S3-compatible object store (MinIO locally, S3/R2/Spaces in production). */
export class S3ExportStorage implements ExportStorage {
  constructor(private readonly config: S3Config) {}

  async put(key: string, content: string): Promise<PutResult> {
    const res = await this.send('PUT', key, content);
    if (!res.ok) {
      throw new Error(`S3 PUT ${key} failed: ${res.status} ${await res.text().catch(() => '')}`);
    }
    return { ref: `s3://${this.config.bucket}/${key}` };
  }

  async get(ref: string): Promise<string> {
    const key = this.keyOf(ref);
    const res = await this.send('GET', key, null);
    if (!res.ok) {
      throw new Error(`S3 GET ${key} failed: ${res.status}`);
    }
    return res.text();
  }

  private keyOf(ref: string): string {
    const prefix = `s3://${this.config.bucket}/`;
    return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
  }

  private send(method: 'PUT' | 'GET', key: string, body: string | null): Promise<Response> {
    const { url, headers } = this.sign(method, key, body);
    return fetch(url, { method, headers, ...(body === null ? {} : { body }) });
  }

  /**
   * AWS Signature V4 for a single-object request. Exposed for the signing test — the canonical
   * request and the credential scope are the parts that break silently if they are wrong.
   */
  sign(
    method: 'PUT' | 'GET',
    key: string,
    body: string | null,
    now = new Date(),
  ): { url: string; headers: Record<string, string> } {
    const { endpoint, bucket, region, accessKey, secretKey, forcePathStyle } = this.config;
    const base = new URL(endpoint);
    const keyPath = key.split('/').map(encodeSegment).join('/');
    const path = forcePathStyle
      ? `${base.pathname.replace(/\/$/, '')}/${encodeSegment(bucket)}/${keyPath}`
      : `${base.pathname.replace(/\/$/, '')}/${keyPath}`;
    const host = forcePathStyle ? base.host : `${bucket}.${base.host}`;

    const amzDate = `${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = body === null ? EMPTY_SHA256 : sha256Hex(body);

    const signed: Record<string, string> = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...(body === null ? {} : { 'content-type': 'application/json' }),
    };
    const names = Object.keys(signed).sort();
    const canonicalHeaders = names.map((n) => `${n}:${signed[n]!.trim()}\n`).join('');
    const signedHeaders = names.join(';');
    const canonicalRequest = [method, path, '', canonicalHeaders, signedHeaders, payloadHash].join(
      '\n',
    );

    const scope = `${dateStamp}/${region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join(
      '\n',
    );
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${secretKey}`, dateStamp), region), 's3'),
      'aws4_request',
    );
    const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

    return {
      url: `${base.protocol}//${host}${path}`,
      headers: {
        ...signed,
        Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
    };
  }
}

export function s3ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): S3Config | null {
  const endpoint = env['S3_ENDPOINT'];
  const bucket = env['S3_BUCKET'];
  const accessKey = env['S3_ACCESS_KEY'];
  const secretKey = env['S3_SECRET_KEY'];
  if (!endpoint || !bucket || !accessKey || !secretKey) return null;
  return {
    endpoint,
    bucket,
    accessKey,
    secretKey,
    region: env['S3_REGION'] ?? 'us-east-1',
    forcePathStyle: (env['S3_FORCE_PATH_STYLE'] ?? 'true') !== 'false',
  };
}

let storage: ExportStorage | undefined;

/**
 * The process-wide storage. S3 when the S3_* env is complete and this is not a test run;
 * otherwise an in-memory store, so a developer machine (and every test) works with no object
 * store at all — the export is still produced and `exportRef` still resolves.
 */
export function getExportStorage(): ExportStorage {
  if (storage) return storage;
  const config = process.env['NODE_ENV'] === 'test' ? null : s3ConfigFromEnv();
  storage = config ? new S3ExportStorage(config) : new MemoryExportStorage();
  return storage;
}

/** Test hook: swap the storage (e.g. for a `MemoryExportStorage` you can inspect). */
export function setExportStorage(next: ExportStorage | undefined): void {
  storage = next;
}
