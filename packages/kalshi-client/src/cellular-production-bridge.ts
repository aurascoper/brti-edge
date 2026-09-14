/** Explicit production executable; never auto-selects from credentials. */
import { pathToFileURL } from "node:url";
import { demoBridgeMain, venueBridgeRequest } from "./cellular-demo-bridge.js";

export function productionBridgeRequest(raw: unknown, transport: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env) {
  return venueBridgeRequest(raw, transport, env, true);
}
export function productionBridgeMain(transport: typeof fetch = fetch) {
  return demoBridgeMain(transport, true);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  productionBridgeMain().catch(() => {
    process.stdout.write(JSON.stringify({schemaId:"cellular.production-adapter-response.v1",status:"REFUSED",reason:"production_request_unacknowledged"})+"\n");
    process.exitCode = 1;
  });
}
