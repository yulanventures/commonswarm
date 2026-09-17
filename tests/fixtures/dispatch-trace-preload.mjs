import { channel } from "node:diagnostics_channel";

channel("commonswarm.cli.dispatch").subscribe((handler) => {
  if (typeof process.send === "function") {
    process.send({ type: "commonswarm-dispatch", handler });
  }
});
