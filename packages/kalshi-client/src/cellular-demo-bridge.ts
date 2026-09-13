/** One private-pipe request per process; DEMO only, no automatic retries.
 * Credentials travel only on stdin. Nothing from an error response is echoed.
 * Python persists the reservation and submission intent before invoking submit.
 */
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { pathToFileURL } from "node:url";
import { CellularDemoAdapter, checkEnvironment, requireManualCount, validateV2 } from "./cellular.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function fail(reason: string): never { throw new Error(reason); }
function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("demo_bridge_shape");
  return raw as Record<string, unknown>;
}
function quantity(raw: unknown): bigint {
  if (typeof raw !== "string" || !/^\d+\.\d{2}$/.test(raw)) fail("demo_ack_quantity");
  return BigInt(raw.replace(".", ""));
}

export async function demoBridgeRequest(raw: unknown, transport: typeof fetch = fetch,
                                       env: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown>> {
  checkEnvironment(env, "DEMO");
  const r = record(raw);
  const keys = ["schemaId", "id", "command", "environment", "credentials", "firstN", "seriesUntested", ...(r.command === "submit" ? ["wire", "submitBefore"] : [])].sort();
  if (JSON.stringify(Object.keys(r).sort()) !== JSON.stringify(keys) ||
      r.schemaId !== "cellular.demo-adapter-request.v1" || r.environment !== "DEMO" ||
      typeof r.id !== "string" || !uuid.test(r.id) || !["ping", "submit"].includes(String(r.command))) fail("demo_bridge_identity_or_command");
  if (typeof r.seriesUntested !== "boolean" || typeof r.firstN !== "number" || r.firstN < 3) fail("demo_first_three_required");
  requireManualCount(r.seriesUntested, r.firstN);
  const creds = record(r.credentials);
  if (Object.keys(creds).sort().join(",") !== "keyId,privateKeyPem" ||
      typeof creds.keyId !== "string" || !uuid.test(creds.keyId) ||
      typeof creds.privateKeyPem !== "string" || Buffer.byteLength(creds.privateKeyPem) > 16384) fail("demo_credentials_shape");
  const privateKey = createPrivateKey(creds.privateKeyPem);
  if (privateKey.asymmetricKeyType !== "rsa" || (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) fail("demo_rsa_key_required");
  const identity = createHash("sha256").update(createPublicKey(privateKey).export({type:"spki",format:"der"})).digest("hex");
  const base = {schemaId:"cellular.demo-adapter-response.v1", id:r.id, environment:"DEMO", accountIdentity:identity};
  if (r.command === "ping") return {...base, status:"READY", transport:"brti_demo"};
  validateV2(r.wire);
  if (typeof r.submitBefore !== "string" || !/(Z|\+00:00)$/.test(r.submitBefore) || !Number.isFinite(Date.parse(r.submitBefore))) fail("demo_submission_deadline_required");
  if (!uuid.test(r.wire.client_order_id) || r.wire.reduce_only || r.wire.subaccount !== 0) fail("demo_entry_primary_scope_required");
  const adapter = new CellularDemoAdapter({keyId:creds.keyId, privateKey}, transport, env);
  const ack = record(await adapter.submit(r.wire, Date.parse(r.submitBefore)));
  if (typeof ack.order_id !== "string" || !uuid.test(ack.order_id) ||
      ack.client_order_id !== r.wire.client_order_id || !Number.isSafeInteger(ack.ts_ms) || Number(ack.ts_ms) <= 0) fail("demo_ack_identity_or_timestamp");
  const filled = quantity(ack.fill_count), remaining = quantity(ack.remaining_count);
  if (filled > quantity(r.wire.count) || remaining !== 0n) fail("demo_ioc_ack_quantity");
  // Acknowledgment is not a fill receipt. The durable GET reconciler imports
  // execution quantities, costs and fees; no fill defaults are invented here.
  return {...base, status:"ACKNOWLEDGED", order_id:ack.order_id, client_order_id:ack.client_order_id};
}

export async function demoBridgeMain(transport: typeof fetch = fetch): Promise<void> {
  if (process.argv.length !== 2) fail("demo_bridge_arguments_refused");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 65536) fail("demo_bridge_request_size");
    chunks.push(chunk);
  }
  const response = await demoBridgeRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")), transport);
  process.stdout.write(JSON.stringify(response) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  demoBridgeMain().catch(() => {
    process.stdout.write(JSON.stringify({schemaId:"cellular.demo-adapter-response.v1",status:"REFUSED",reason:"demo_request_unacknowledged"}) + "\n");
    process.exitCode = 1;
  });
}
