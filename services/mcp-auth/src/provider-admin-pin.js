import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { adminTransactionContext } from "./admin-transaction.js";
import { adminProofAdmitted } from "./admin-dpop.js";

// 9.12.2's validator has no public nonce-store hook. Adapt its internal nonce
// interface, retaining its complete embedded-JWK signature and key checks.
// This exact pin is a reviewed integration boundary, never a version fallback.
export async function bindProviderAdminNonceStore(provider) {
  const require = createRequire(import.meta.url);
  const library = dirname(require.resolve("oidc-provider"));
  const manifest = JSON.parse(await readFile(resolve(library, "../package.json"), "utf8"));
  if (manifest.version !== "9.12.2") throw new Error("admin provider pin changed");
  const { default: instance } = await import(pathToFileURL(resolve(library, "helpers/weak_cache.js")).href);
  const internal = instance(provider), prior = internal.DPoPNonces;
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
