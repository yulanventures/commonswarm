export interface ConfiguredRuntimeConfig {
  status: 'configured';
  url: string;
  anonKey: string;
}

export interface NotConfiguredRuntimeConfig {
  status: 'not_configured';
}

export interface InvalidRuntimeConfig {
  status: 'invalid';
  reason: string;
}

export type RuntimeConfig =
  | ConfiguredRuntimeConfig
  | NotConfiguredRuntimeConfig
  | InvalidRuntimeConfig;

function readMetaContent(doc: Document, name: string): string {
  const element = doc.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  return element?.content?.trim() ?? '';
}

export function readRuntimeConfig(doc?: Document | null): RuntimeConfig {
  const targetDoc =
    doc === undefined
      ? typeof document !== 'undefined'
        ? document
        : null
      : doc;

  if (!targetDoc) {
    return { status: 'not_configured' };
  }

  const rawUrl = readMetaContent(targetDoc, 'commonswarm:url');
  const rawAnonKey = readMetaContent(targetDoc, 'commonswarm:anon-key');

  if (!rawUrl && !rawAnonKey) {
    return { status: 'not_configured' };
  }

  if (!rawUrl) {
    return {
      status: 'invalid',
      reason: 'Missing meta[name="commonswarm:url"].',
    };
  }

  if (!rawAnonKey) {
    return {
      status: 'invalid',
      reason: 'Missing meta[name="commonswarm:anon-key"].',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return {
      status: 'invalid',
      reason: 'Invalid commonswarm:url: must be a valid https URL.',
    };
  }

  if (parsed.protocol !== 'https:' || !parsed.hostname) {
    return {
      status: 'invalid',
      reason: 'Invalid commonswarm:url: must use https.',
    };
  }

  if (parsed.username || parsed.password) {
    return {
      status: 'invalid',
      reason: 'Invalid commonswarm:url: must not contain embedded credentials.',
    };
  }

  if (parsed.search || parsed.hash) {
    return {
      status: 'invalid',
      reason: 'Invalid commonswarm:url: must not include query or fragment.',
    };
  }

  const normalizedPath = parsed.pathname.replace(/\/+$/, '');
  const url = normalizedPath
    ? `${parsed.origin}${normalizedPath}`
    : parsed.origin;

  return {
    status: 'configured',
    url,
    anonKey: rawAnonKey,
  };
}
