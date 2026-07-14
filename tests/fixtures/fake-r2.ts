import { R2 } from '../../src/r2.js';

/**
 * In-memory S3-compatible fake for R2. Dispatches on command class name so the
 * real @aws-sdk command objects work unmodified in unit tests.
 */
export function createFakeR2(): R2 & {
  store: Map<string, { body: Buffer; contentType?: string; etag: string }>;
} {
  const store = new Map<string, { body: Buffer; contentType?: string; etag: string }>();
  let etagCounter = 0;

  const objKey = (bucket: string, key: string): string => `${bucket}//${key}`;

  const preconditionFailed = (): never => {
    const err = new Error('PreconditionFailed') as Error & {
      name: string;
      $metadata: { httpStatusCode: number };
    };
    err.name = 'PreconditionFailed';
    err.$metadata = { httpStatusCode: 412 };
    throw err;
  };

  const client = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      const name = command.constructor.name;
      const input = command.input;
      const bucket = input.Bucket as string;
      const key = input.Key as string | undefined;

      if (name === 'PutObjectCommand') {
        const existing = store.get(objKey(bucket, key!));
        // Emulate R2's conditional-write semantics (If-None-Match / If-Match).
        if (input.IfNoneMatch === '*' && existing) preconditionFailed();
        if (input.IfMatch !== undefined && (!existing || existing.etag !== input.IfMatch)) {
          preconditionFailed();
        }
        const bodyRaw = input.Body as Buffer | string;
        const body = Buffer.isBuffer(bodyRaw) ? bodyRaw : Buffer.from(String(bodyRaw));
        const etag = `"fake-etag-${++etagCounter}"`;
        store.set(objKey(bucket, key!), { body, contentType: input.ContentType as string, etag });
        return { ETag: etag };
      }
      if (name === 'HeadObjectCommand') {
        const obj = store.get(objKey(bucket, key!));
        if (!obj) {
          const err = new Error('NotFound') as Error & {
            name: string;
            $metadata: { httpStatusCode: number };
          };
          err.name = 'NotFound';
          err.$metadata = { httpStatusCode: 404 };
          throw err;
        }
        return { ContentType: obj.contentType, ContentLength: obj.body.length, ETag: obj.etag };
      }
      if (name === 'GetObjectCommand') {
        const obj = store.get(objKey(bucket, key!));
        if (!obj) {
          const err = new Error('NoSuchKey') as Error & {
            name: string;
            $metadata: { httpStatusCode: number };
          };
          err.name = 'NoSuchKey';
          err.$metadata = { httpStatusCode: 404 };
          throw err;
        }
        async function* gen() {
          yield new Uint8Array(obj!.body);
        }
        return { Body: gen(), ETag: obj.etag };
      }
      if (name === 'DeleteObjectCommand') {
        store.delete(objKey(bucket, key!));
        return {};
      }
      if (name === 'ListObjectsV2Command') {
        const prefix = (input.Prefix as string) ?? '';
        const contents = [...store.keys()]
          .filter((k) => k.startsWith(`${bucket}//`))
          .map((k) => k.slice(`${bucket}//`.length))
          .filter((k) => k.startsWith(prefix))
          .map((k) => ({ Key: k }));
        return { Contents: contents };
      }
      throw new Error(`fake R2: unhandled command ${name}`);
    },
  };

  return {
    client: client as unknown as R2['client'],
    publicBucket: 'public-test',
    privateBucket: 'private-test',
    publicBaseUrl: 'https://cdn.test',
    store,
  };
}
