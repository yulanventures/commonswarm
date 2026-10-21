import {
  type CallerContext,
  fail,
} from '../../../../src/protocol/org-channels-contract.js';
import {
  type OrgAuthorityState,
  type OrgLogoPendingUpload,
  authorizeOrgAction,
  findLiveOrg,
  registerOrgActionExecutor,
} from './invites.js';

export const ORG_LOGO_MAX_BYTES = 1_048_576; // 1 MB
export const ORG_LOGO_RENDITION_SIZES = [64, 128, 256] as const;
export const ORG_LOGO_ALLOWED_CONTENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/svg+xml',
] as const;

export type OrgLogoContentType = (typeof ORG_LOGO_ALLOWED_CONTENT_TYPES)[number];

function extForContentType(ct: OrgLogoContentType): 'png' | 'jpg' | 'webp' | 'svg' {
  if (ct === 'image/png') return 'png';
  if (ct === 'image/jpeg') return 'jpg';
  if (ct === 'image/webp') return 'webp';
  return 'svg';
}

function quickDigestHex(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < bytes.byteLength; i++) {
    const b = bytes[i]!;
    h1 ^= b;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= b;
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

export function sanitizeOrgLogoSvg(rawSvg: string): { sanitized: string; stripped: boolean } {
  let s = rawSvg;
  const before = s;
  s = s.replace(/<!DOCTYPE[\s\S]*?>/gi, '');
  s = s.replace(/<!ENTITY[\s\S]*?>/gi, '');
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<script\b[^>]*\/?>/gi, '');
  s = s.replace(/<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject>/gi, '');
  s = s.replace(/<(?:iframe|object|embed)\b[^>]*>[\s\S]*?<\/(?:iframe|object|embed)>/gi, '');
  s = s.replace(/<(?:iframe|object|embed)\b[^>]*\/?>/gi, '');
  s = s.replace(/\s+on[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  s = s.replace(
    /\s+(?:xlink:href|href|src)\s*=\s*(?:"\s*(?:https?:|\/\/|ftp:|javascript:|vbscript:|data:text\/html|data:application\/)[^"]*"|'\s*(?:https?:|\/\/|ftp:|javascript:|vbscript:|data:text\/html|data:application\/)[^']*')/gi,
    '',
  );
  s = s.replace(/@import\s+(?:url\([^)]*\)|"[^"]*"|'[^']*')\s*;?/gi, '');
  s = s.replace(/url\(\s*['"]?\s*(?:https?:|\/\/|javascript:|vbscript:|data:text\/html)[^)]*\)/gi, 'none');
  return { sanitized: s.trim(), stripped: s !== before };
}

export function detectAndVerifyOrgLogo(
  inputBytes: Uint8Array | string,
  declaredContentType?: string | null,
  orgSlug?: string | null,
) {
  const scope = { org: orgSlug ?? null };
  const raw =
    typeof inputBytes === 'string' ? new TextEncoder().encode(inputBytes) : inputBytes;

  if (raw.byteLength === 0) {
    return fail('ORG_LOGO_EMPTY', 'non_empty_logo_bytes', scope);
  }
  if (raw.byteLength > ORG_LOGO_MAX_BYTES) {
    return fail('ORG_LOGO_TOO_LARGE', 'logo_size_lte_1mb', scope);
  }

  let detectedType: OrgLogoContentType | null = null;
  let sanitizedSvgText: string | null = null;
  let stripped = false;

  // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
  if (
    raw.byteLength >= 8 &&
    raw[0] === 0x89 &&
    raw[1] === 0x50 &&
    raw[2] === 0x4e &&
    raw[3] === 0x47 &&
    raw[4] === 0x0d &&
    raw[5] === 0x0a &&
    raw[6] === 0x1a &&
    raw[7] === 0x0a
  ) {
    detectedType = 'image/png';
  } else if (
    // JPEG magic bytes: FF D8 FF
    raw.byteLength >= 3 &&
    raw[0] === 0xff &&
    raw[1] === 0xd8 &&
    raw[2] === 0xff
  ) {
    detectedType = 'image/jpeg';
  } else if (
    // WebP magic bytes: RIFF....WEBP
    raw.byteLength >= 12 &&
    raw[0] === 0x52 &&
    raw[1] === 0x49 &&
    raw[2] === 0x46 &&
    raw[3] === 0x46 &&
    raw[8] === 0x57 &&
    raw[9] === 0x45 &&
    raw[10] === 0x42 &&
    raw[11] === 0x50
  ) {
    detectedType = 'image/webp';
  } else if (!raw.includes(0)) {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(raw);
    if (/<svg[\s>]/i.test(text) && (/<\/svg>/i.test(text) || /<svg[^>]*\/>/i.test(text))) {
      const cleaned = sanitizeOrgLogoSvg(text);
      if (/<svg[\s>]/i.test(cleaned.sanitized)) {
        detectedType = 'image/svg+xml';
        sanitizedSvgText = cleaned.sanitized;
        stripped = cleaned.stripped;
      }
    }
  }

  if (!detectedType) {
    return fail('ORG_LOGO_INVALID_FORMAT', 'png_jpeg_webp_or_svg_magic_bytes', scope);
  }

  if (declaredContentType && declaredContentType !== detectedType) {
    return fail('ORG_LOGO_MAGIC_BYTE_MISMATCH', `matching_${detectedType}_magic_bytes`, scope);
  }

  const finalBytes =
    sanitizedSvgText !== null ? new TextEncoder().encode(sanitizedSvgText) : raw;

  return {
    ok: true as const,
    content_type: detectedType,
    ext: extForContentType(detectedType),
    bytes: finalBytes,
    svg_text: sanitizedSvgText,
    sanitized: stripped,
  };
}

export function orgLogoUploadPrepare(
  state: OrgAuthorityState,
  caller: CallerContext,
  input: {
    org_id: string;
    content_type: string;
    size_bytes?: number;
    require_approval?: boolean;
    now?: string;
  },
) {
  const now = input.now ?? new Date().toISOString();
  const org = findLiveOrg(state, input.org_id);
  if (!org) return fail('ORG_NOT_FOUND', 'organization', { org: input.org_id });

  const auth = authorizeOrgAction(state, caller, {
    org,
    min_role: 'admin',
    action_kind: 'org_logo_upload_prepare',
    payload: { ...input },
    require_approval: input.require_approval,
    now,
  });
  if (auth.status === 'refused') return auth.result;
  if (auth.status === 'approval_required') return auth.result;

  if (!(ORG_LOGO_ALLOWED_CONTENT_TYPES as readonly string[]).includes(input.content_type)) {
    return fail('ORG_LOGO_INVALID_FORMAT', 'supported_logo_content_type', { org: org.slug });
  }
  if (input.size_bytes !== undefined) {
    if (input.size_bytes <= 0) {
      return fail('ORG_LOGO_EMPTY', 'non_empty_logo_bytes', { org: org.slug });
    }
    if (input.size_bytes > ORG_LOGO_MAX_BYTES) {
      return fail('ORG_LOGO_TOO_LARGE', 'logo_size_lte_1mb', { org: org.slug });
    }
  }

  const ct = input.content_type as OrgLogoContentType;
  const ext = extForContentType(ct);
  const prefix = `orgs/${org.id}/logo`;
  const renditionKeys = {
    64: `${prefix}/64.${ext}`,
    128: `${prefix}/128.${ext}`,
    256: `${prefix}/256.${ext}`,
  };

  state.logoUploads ??= {};
  const upload: OrgLogoPendingUpload = {
    upload_id: `lgup-${crypto.randomUUID()}`,
    org_id: org.id,
    content_type: ct,
    max_bytes: ORG_LOGO_MAX_BYTES,
    object_prefix: prefix,
    rendition_keys: renditionKeys,
    requested_by: auth.actor_user_id,
    created_at: now,
    finalized_at: null,
  };
  state.logoUploads[upload.upload_id] = upload;

  return {
    ok: true as const,
    status: 'executed' as const,
    upload,
  };
}

export function orgLogoFinalize(
  state: OrgAuthorityState,
  caller: CallerContext,
  input: {
    org_id: string;
    upload_id?: string;
    content_type?: string | null;
    bytes: Uint8Array | string;
    require_approval?: boolean;
    now?: string;
  },
) {
  const now = input.now ?? new Date().toISOString();
  const org = findLiveOrg(state, input.org_id);
  if (!org) return fail('ORG_NOT_FOUND', 'organization', { org: input.org_id });

  const auth = authorizeOrgAction(state, caller, {
    org,
    min_role: 'admin',
    action_kind: 'org_logo_finalize',
    payload: { ...input },
    require_approval: input.require_approval,
    now,
  });
  if (auth.status === 'refused') return auth.result;
  if (auth.status === 'approval_required') return auth.result;

  const pending = input.upload_id ? state.logoUploads?.[input.upload_id] : undefined;
  if (input.upload_id && (!pending || pending.org_id !== org.id)) {
    return fail('ORG_LOGO_UPLOAD_NOT_FOUND', 'prepared_logo_upload', { org: org.slug });
  }

  const declaredType = input.content_type ?? pending?.content_type ?? null;
  const verified = detectAndVerifyOrgLogo(input.bytes, declaredType, org.slug);
  if (!verified.ok) return verified;

  state.logoObjects ??= {};
  const prefix = `orgs/${org.id}/logo`;
  for (const existingKey of Object.keys(state.logoObjects)) {
    if (existingKey.startsWith(`${prefix}/`)) {
      delete state.logoObjects[existingKey];
    }
  }

  const renditions = {
    64: `${prefix}/64.${verified.ext}`,
    128: `${prefix}/128.${verified.ext}`,
    256: `${prefix}/256.${verified.ext}`,
  };

  for (const size of ORG_LOGO_RENDITION_SIZES) {
    const key = renditions[size];
    const data =
      verified.svg_text !== null
        ? verified.svg_text.replace(
            /<svg\b/i,
            `<svg data-rendition="${size}x${size}" width="${size}" height="${size}"`,
          )
        : verified.bytes;
    const encoded = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    state.logoObjects[key] = {
      key,
      org_id: org.id,
      size,
      content_type: verified.content_type,
      byte_length: encoded.byteLength,
      sha256: quickDigestHex(encoded),
      data,
    };
  }

  if (pending) pending.finalized_at = now;
  org.logo_object_key = renditions[256];
  org.logo_updated_at = now;
  org.updated_at = now;

  return {
    ok: true as const,
    status: 'executed' as const,
    organization: org,
    content_type: verified.content_type,
    sanitized: verified.sanitized,
    logo_object_key: org.logo_object_key,
    renditions,
  };
}

export function orgLogoRemove(
  state: OrgAuthorityState,
  caller: CallerContext,
  input: {
    org_id: string;
    require_approval?: boolean;
    now?: string;
  },
) {
  const now = input.now ?? new Date().toISOString();
  const org = findLiveOrg(state, input.org_id);
  if (!org) return fail('ORG_NOT_FOUND', 'organization', { org: input.org_id });

  const auth = authorizeOrgAction(state, caller, {
    org,
    min_role: 'admin',
    action_kind: 'org_logo_remove',
    payload: { ...input },
    require_approval: input.require_approval,
    now,
  });
  if (auth.status === 'refused') return auth.result;
  if (auth.status === 'approval_required') return auth.result;

  const prefix = `orgs/${org.id}/logo/`;
  const removedKeys: string[] = [];
  if (state.logoObjects) {
    for (const k of Object.keys(state.logoObjects)) {
      if (k.startsWith(prefix)) {
        removedKeys.push(k);
        delete state.logoObjects[k];
      }
    }
  }
  org.logo_object_key = null;
  org.logo_updated_at = now;
  org.updated_at = now;

  return {
    ok: true as const,
    status: 'executed' as const,
    organization: org,
    removed_keys: removedKeys,
  };
}

registerOrgActionExecutor('org_logo_upload_prepare', (s, c, p) =>
  orgLogoUploadPrepare(s, c, p as Parameters<typeof orgLogoUploadPrepare>[2]),
);
registerOrgActionExecutor('org_logo_finalize', (s, c, p) =>
  orgLogoFinalize(s, c, p as Parameters<typeof orgLogoFinalize>[2]),
);
registerOrgActionExecutor('org_logo_remove', (s, c, p) =>
  orgLogoRemove(s, c, p as Parameters<typeof orgLogoRemove>[2]),
);

export const org_logo_upload_prepare = orgLogoUploadPrepare;
export const org_logo_finalize = orgLogoFinalize;
export const org_logo_remove = orgLogoRemove;
