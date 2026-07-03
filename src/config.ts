import { z } from 'zod';

/**
 * Environment configuration. Validates presence WITHOUT ever printing values.
 * Missing required variables are reported by name only.
 */

/** Required in all runs. */
const CORE_REQUIRED = [
  'GOOGLE_SHEET_ID',
  'GOOGLE_SERVICE_ACCOUNT_B64',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_PUBLIC_BUCKET',
  'R2_PRIVATE_BUCKET',
  'R2_ENDPOINT',
  'R2_PUBLIC_BASE_URL',
  'TOKEN_ENCRYPTION_KEY',
] as const;

/** Required only for LIVE publication. Tolerated-missing in TEST mode. */
const INSTAGRAM_REQUIRED = ['INSTAGRAM_ACCESS_TOKEN', 'INSTAGRAM_USER_ID'] as const;

export interface AppConfig {
  googleSheetId: string;
  googleServiceAccountB64: string;
  r2: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    publicBucket: string;
    privateBucket: string;
    endpoint: string;
    publicBaseUrl: string;
  };
  instagram: {
    accessToken: string | undefined;
    userId: string | undefined;
    graphApiVersion: string;
  };
  tokenEncryptionKey: string;
  timezone: string;
  nodeEnv: string;
  /** Names of required env vars that are absent. */
  missingCore: string[];
  missingInstagram: string[];
}

const NonEmpty = z.string().min(1);

/** Names of required-but-missing core env vars (no values touched). */
export function missingCoreVars(): string[] {
  return CORE_REQUIRED.filter((k) => {
    const v = process.env[k];
    return !v || v.trim() === '';
  });
}

/** Names of required-but-missing Instagram env vars. */
export function missingInstagramVars(): string[] {
  return INSTAGRAM_REQUIRED.filter((k) => {
    const v = process.env[k];
    return !v || v.trim() === '';
  });
}

/**
 * Load config. Throws (with variable NAMES only) when core vars are missing.
 * Instagram vars are allowed to be missing here; enforcement happens at
 * publish time based on MODE.
 */
export function loadConfig(): AppConfig {
  const missingCore = missingCoreVars();
  if (missingCore.length > 0) {
    throw new Error(`Missing required environment variables: ${missingCore.join(', ')}`);
  }

  const missingInstagram = missingInstagramVars();
  const graphVersion = (process.env.META_GRAPH_API_VERSION ?? '').trim() || 'v21.0';
  const timezone = (process.env.TIMEZONE ?? '').trim() || 'America/Toronto';

  // Normalize URLs: some environments provide bare hosts without a scheme.
  const withScheme = (raw: string): string => {
    const v = raw.trim().replace(/\/+$/, '');
    if (/^https?:\/\//i.test(v)) return v;
    return `https://${v}`;
  };

  const cfg: AppConfig = {
    googleSheetId: NonEmpty.parse(process.env.GOOGLE_SHEET_ID),
    googleServiceAccountB64: NonEmpty.parse(process.env.GOOGLE_SERVICE_ACCOUNT_B64),
    r2: {
      accountId: NonEmpty.parse(process.env.R2_ACCOUNT_ID),
      accessKeyId: NonEmpty.parse(process.env.R2_ACCESS_KEY_ID),
      secretAccessKey: NonEmpty.parse(process.env.R2_SECRET_ACCESS_KEY),
      publicBucket: NonEmpty.parse(process.env.R2_PUBLIC_BUCKET),
      privateBucket: NonEmpty.parse(process.env.R2_PRIVATE_BUCKET),
      endpoint: withScheme(NonEmpty.parse(process.env.R2_ENDPOINT)),
      publicBaseUrl: withScheme(NonEmpty.parse(process.env.R2_PUBLIC_BASE_URL)),
    },
    instagram: {
      accessToken: process.env.INSTAGRAM_ACCESS_TOKEN?.trim() || undefined,
      userId: process.env.INSTAGRAM_USER_ID?.trim() || undefined,
      graphApiVersion: graphVersion,
    },
    tokenEncryptionKey: NonEmpty.parse(process.env.TOKEN_ENCRYPTION_KEY),
    timezone,
    nodeEnv: (process.env.NODE_ENV ?? '').trim() || 'production',
    missingCore,
    missingInstagram,
  };

  return cfg;
}

/** True when Instagram integration is fully configured. */
export function instagramConfigured(cfg: AppConfig): boolean {
  return !!cfg.instagram.accessToken && !!cfg.instagram.userId;
}
