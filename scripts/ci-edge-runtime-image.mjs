// The runner and boot checks use the same Compose pin and ECR retry policy.
import { createHash } from "node:crypto";
import { composeEdgeRuntimeImage } from "../tests/support/edge-runtime-function-boot.ts";
import { ensureDockerImage } from "../tests/support/docker-image-pull.ts";

const image = composeEdgeRuntimeImage();
switch (process.argv[2]) {
  case "metadata":
    console.log(`image=${image}`);
    console.log(`key=${createHash("sha256").update(image).digest("hex")}`);
    break;
  case "ensure":
    await ensureDockerImage(image);
    break;
  default:
    throw new Error("Expected metadata or ensure");
}
