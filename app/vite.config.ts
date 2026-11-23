import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

declare const process: {
  cwd(): string;
  env: Record<string, string | undefined>;
};

const PRODUCTION_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' blob: data:; connect-src 'self' https://api.commonswarm.com wss://api.commonswarm.com; object-src 'none'; base-uri 'none'; form-action 'none'";

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function resolvePublicConfig(
  mode: string,
): { url: string; anonKey: string } | null {
  const fileEnv = loadEnv(mode, process.cwd(), 'PUBLIC_');
  const url = (
    process.env.PUBLIC_SUPABASE_URL ??
    fileEnv.PUBLIC_SUPABASE_URL ??
    ''
  ).trim();
  const anonKey = (
    process.env.PUBLIC_SUPABASE_ANON_KEY ??
    fileEnv.PUBLIC_SUPABASE_ANON_KEY ??
    ''
  ).trim();

  if (Boolean(url) !== Boolean(anonKey)) {
    const missing = url
      ? 'PUBLIC_SUPABASE_ANON_KEY'
      : 'PUBLIC_SUPABASE_URL';
    throw new Error(
      `Incomplete CommonSwarm runtime config: set both PUBLIC_SUPABASE_URL and PUBLIC_SUPABASE_ANON_KEY, or omit both (missing ${missing}).`,
    );
  }

  return url && anonKey ? { url, anonKey } : null;
}

function commonSwarmHtmlPlugin(command: 'build' | 'serve', mode: string): Plugin {
  return {
    name: 'commonswarm-html-meta',
    buildStart() {
      resolvePublicConfig(mode);
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const lines: string[] = [];

        if (command === 'build') {
          lines.push(
            `    <meta http-equiv="Content-Security-Policy" content="${PRODUCTION_CSP}" />`,
          );
        }

        const runtimeConfig = resolvePublicConfig(mode);
        if (runtimeConfig) {
          lines.push(
            `    <meta name="commonswarm:url" content="${escapeHtmlAttr(runtimeConfig.url)}" />`,
            `    <meta name="commonswarm:anon-key" content="${escapeHtmlAttr(runtimeConfig.anonKey)}" />`,
          );
        }

        if (lines.length === 0) {
          return html;
        }

        return html.replace('  </head>', `${lines.join('\n')}\n  </head>`);
      },
    },
  };
}

const APP_ROOT = decodeURIComponent(
  new URL('.', import.meta.url).pathname,
).replace(/\/$/, '');
const SHARED_BROWSER_SESSION_ROOT = decodeURIComponent(
  new URL('../shared/browser-session', import.meta.url).pathname,
).replace(/\/$/, '');

export default defineConfig(({ command, mode }) => ({
  base: '/next/',
  plugins: [react(), tailwindcss(), commonSwarmHtmlPlugin(command, mode)],
  // Dev server serves only app/ and the shared browser session module.
  server: {
    fs: {
      allow: [APP_ROOT, SHARED_BROWSER_SESSION_ROOT],
    },
  },
}));
