import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { adminTransactionContext } from "./admin-transaction.js";
import { adminProofAdmitted } from "./admin-dpop.js";
import { AdminOAuthError } from "./admin-oauth-error.js";
import { errors } from "oidc-provider";

export const ADMIN_TOKEN_INGRESS = Symbol("admin-token-ingress");

// 9.12.2's validator has no public nonce-store hook. Adapt its internal nonce
// interface, retaining its complete embedded-JWK signature and key checks.
// This exact pin is a reviewed integration boundary, never a version fallback.
export async function bindProviderAdminNonceStore(provider, finishToken) {
  const require = createRequire(import.meta.url);
  const library = dirname(require.resolve("oidc-provider"));
  const manifest = JSON.parse(await readFile(resolve(library, "../package.json"), "utf8"));
  if (manifest.version !== "9.12.2") throw new Error("admin provider pin changed");
  const { default: instance } = await import(pathToFileURL(resolve(library, "helpers/weak_cache.js")).href);
  const internal = instance(provider), prior = internal.DPoPNonces;
  // The pinned handlers run after the provider's own bounded parser, client
  // authentication and duplicate checks, before any code/refresh consume.
  // Ordinary requests retain their IncomingMessage and provider parser.
  for (const [grantType, handler] of finishToken ? internal.grantTypeHandlers : []) {
    internal.grantTypeHandlers.set(grantType, async ctx => {
      const operation = async () => {
        try { await handler(ctx); await finishToken(ctx); }
        catch (error) {
          if (!(error instanceof AdminOAuthError)) throw error;
          const ErrorType = {
            invalid_grant: errors.InvalidGrant,
            invalid_scope: errors.InvalidScope,
            unauthorized_client: errors.UnauthorizedClient,
          }[error.error];
          // The provider catches OAuth errors. Retain the refusal for the
          // coordinator so it rolls back and preserves the intended status.
          const scope = adminTransactionContext(false);
          if (scope) scope.failure ??= error;
          if (!ErrorType) throw error;
          const mapped = ErrorType === errors.InvalidScope
            ? new ErrorType("requested scope is not allowed", undefined, { cause: error })
            : ErrorType === errors.UnauthorizedClient
              ? new ErrorType(undefined, { cause: error }) : new ErrorType({ cause: error });
          mapped.status = mapped.statusCode = error.statusCode;
          mapped.expose = true;
          throw mapped;
        }
      };
      const ingress = ctx.req[ADMIN_TOKEN_INGRESS];
      if (ingress) await ingress(ctx, operation);
      else await operation();
    });
  }

  internal.DPoPNonces = {
    nextChallenge() {
      const proof = adminTransactionContext(false)?.capability?.proof;
      return adminProofAdmitted(proof) ? proof.nonce : prior?.nextChallenge();
    },
    checkChallenge(nonce) {
      const proof = adminTransactionContext(false)?.capability?.proof;
      return adminProofAdmitted(proof) ? nonce === proof.nonce : (prior?.checkChallenge(nonce) ?? false);
    },
  };
}
