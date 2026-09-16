import { channel } from "node:diagnostics_channel";

/**
 * A test observer for the route that reached its handler. Publishing without a
 * subscriber is a no-op. The baseline test subscribes in a preload module, so
 * this exact instrument can stay in place while dispatch moves into the table.
 */
const DISPATCH_TRACE = channel("commonswarm.cli.dispatch");

export function recordDispatch(handler: string): void {
  DISPATCH_TRACE.publish(handler);
}
