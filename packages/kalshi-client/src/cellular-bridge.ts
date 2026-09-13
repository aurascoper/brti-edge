/** Private JSON-lines translation bridge. This process has no order transport. */
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { checkEnvironment, requireManualCount, translate, validateV2, type Intent } from "./cellular.js";

export function bridgeRequest(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("bridge_request_shape");
  const r = raw as Record<string, unknown>;
  if (r.schemaId !== "cellular.adapter-request.v1" || typeof r.id !== "string" || !r.id) throw new Error("bridge_request_identity");
  if (r.command === "ping" && Object.keys(r).length === 3) return {schemaId:"cellular.adapter-response.v1",id:r.id,status:"READY",transport:"translation_only"};
  if (r.command !== "translate" || Object.keys(r).sort().join(",") !== "command,id,intent,schemaId") throw new Error("bridge_command_refused");
  const intent = r.intent as Intent;
  if (!intent || !["action,clientOrderId,outcome,priceDollars,quantity,subaccount,ticker", "action,clientOrderId,exchangeIndex,outcome,priceDollars,quantity,subaccount,ticker"].includes(Object.keys(intent).sort().join(","))) throw new Error("bridge_intent_shape");
  const wire = translate(intent);
  validateV2(wire);
  return {schemaId:"cellular.adapter-response.v1",id:r.id,status:"TRANSLATED",wire};
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--manual-first-n" || args[2] !== "--series-untested" || !/^(true|false)$/.test(args[3] ?? "") || !/^\d+$/.test(args[1] ?? "")) throw new Error("manual_confirmation_configuration_required");
  checkEnvironment(process.env, "PAPER");
  requireManualCount(args[3] === "true", Number(args[1]));
  const input = createInterface({input:process.stdin, crlfDelay:Infinity});
  for await (const line of input) {
    if (Buffer.byteLength(line) > 65536) throw new Error("bridge_request_size");
    try {
      process.stdout.write(JSON.stringify(bridgeRequest(JSON.parse(line))) + "\n");
    } catch {
      process.stdout.write(JSON.stringify({schemaId:"cellular.adapter-response.v1",status:"REFUSED",reason:"bridge_request_invalid"}) + "\n");
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write("cellular_bridge_startup_or_input_refused\n"); process.exitCode = 1; });
}
