import assert from "node:assert/strict";
import { constants, generateKeyPairSync, verify } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { demoBridgeRequest } from "./cellular-demo-bridge.js";
import { translate } from "./cellular.js";

const {privateKey, publicKey} = generateKeyPairSync("rsa", {modulusLength:2048});
const env = {CELLULAR_PROCESS_ROLE:"executor"};
const clientId = "11111111-1111-4111-8111-111111111111";
const orderId = "22222222-2222-4222-8222-222222222222";
const request = {
  schemaId:"cellular.demo-adapter-request.v1", id:clientId, command:"submit", environment:"DEMO",
  credentials:{keyId:clientId, privateKeyPem:privateKey.export({type:"pkcs8", format:"pem"}).toString()},
  firstN:3, seriesUntested:true,
  submitBefore:new Date(Date.now()+60000).toISOString(),
  wire:translate({ticker:"KXBTC15M-FIXTURE",clientOrderId:clientId,outcome:"NO",action:"buy",priceDollars:"0.48",quantity:"1",subaccount:0}),
};
const ack = {order_id:orderId, client_order_id:clientId, fill_count:"0.25", remaining_count:"0.00", ts_ms:Date.now()};
const {wire: ignoredWire, submitBefore: ignoredDeadline, ...cancelBase} = request;
const cancel = {...cancelBase, command:"cancel", cancelBefore:request.submitBefore,
  target:{order_id:orderId,client_order_id:clientId,ticker:"KXBTC15M-FIXTURE",exchange_index:2,subaccount:0,remaining_count:"0.75"}};
const cancelAck = {order_id:orderId,client_order_id:clientId,reduced_by:"0.75",ts_ms:Date.now()};
function response(body: unknown = ack, status = 201) { return new Response(JSON.stringify(body), {status}); }

test("DEMO bridge calls the real BRTI adapter, signs the fixed route, and preserves the exact NO preview", async () => {
  let calls = 0;
  const transport: typeof fetch = async (url, options) => {
    calls++;
    assert.equal(url,"https://external-api.demo.kalshi.co/trade-api/v2/portfolio/events/orders");
    assert.equal(options?.method,"POST");
    assert.equal(options?.redirect,"error");
    assert.ok(options?.signal);
    assert.deepEqual(JSON.parse(String(options?.body)),request.wire);
    assert.equal(request.wire.side,"ask"); assert.equal(request.wire.price,"0.5200");
    assert.equal(request.wire.exchange_index,0);
    const headers = new Headers(options?.headers);
    assert.equal(headers.get("KALSHI-ACCESS-KEY"),clientId);
    const content = headers.get("KALSHI-ACCESS-TIMESTAMP") + "POST/trade-api/v2/portfolio/events/orders";
    assert.ok(verify("RSA-SHA256",Buffer.from(content), {key:publicKey,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32}, Buffer.from(headers.get("KALSHI-ACCESS-SIGNATURE")!,"base64")));
    assert.equal(verify("RSA-SHA256",Buffer.from(content+"?changed"), {key:publicKey,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32}, Buffer.from(headers.get("KALSHI-ACCESS-SIGNATURE")!,"base64")),false);
    return response();
  };
  const result = await demoBridgeRequest(request,transport,env);
  assert.equal(calls,1); assert.equal(result.status,"ACKNOWLEDGED");
  assert.equal(result.order_id,orderId); assert.equal(result.client_order_id,clientId);
  assert.ok(!JSON.stringify(result).includes("PRIVATE KEY"));
  assert.ok(!("fill_count" in result));
});

test("DEMO bridge rejects production, missing manual slots, foreign scopes and credential contamination before network", async () => {
  let calls = 0;
  const transport: typeof fetch = async () => { calls++; return response(); };
  for (const raw of [
    {...request,environment:"PRODUCTION"}, {...request,firstN:0}, {...request,firstN:2},
    {...request,command:"cancel"}, {...request,wire:{...request.wire,exchange_index:1}},
    {...request,wire:{...request.wire,subaccount:1}}, {...request,wire:{...request.wire,reduce_only:true}},
    {...request,baseUrl:"https://external-api.kalshi.com"},
    {...request,submitBefore:new Date(0).toISOString()}, {...request,submitBefore:"not-a-date"},
  ]) await assert.rejects(demoBridgeRequest(raw,transport,env));
  for (const bad of [{CELLULAR_PROCESS_ROLE:"arena"}, {...env,KALSHI_API_KEY_ID:"foreign"}, {...env,KALSHI_PROD_KEY:"foreign"}])
    await assert.rejects(demoBridgeRequest(request,transport,bad));
  assert.equal(calls,0);
});

test("explicit BTC exchange 2 survives translation and signed demo handoff; other shards refuse", async () => {
  const wire = translate({ticker:"KXBTC15M-FIXTURE",clientOrderId:clientId,outcome:"NO",action:"buy",priceDollars:"0.48",quantity:"1",subaccount:0,exchangeIndex:2});
  let calls = 0;
  const transport: typeof fetch = async (_url, options) => {
    calls++; assert.deepEqual(JSON.parse(String(options?.body)),wire);
    assert.equal(wire.exchange_index,2); assert.equal(wire.subaccount,0);
    return response();
  };
  assert.equal((await demoBridgeRequest({...request,wire},transport,env)).status,"ACKNOWLEDGED");
  assert.equal(calls,1);
  for (const exchange_index of [-1,1,3,2.5,"2",null])
    await assert.rejects(demoBridgeRequest({...request,wire:{...wire,exchange_index}},transport,env));
  assert.equal(calls,1);
});

test("Timeout after delivery, HTTP failure and non-201 never retry or acknowledge", async () => {
  for (const status of [0, 401, 429, 500, 200]) {
    let calls = 0;
    const transport: typeof fetch = async () => { calls++; if (!status) throw new Error("private transport details"); return response(ack,status); };
    await assert.rejects(demoBridgeRequest(request,transport,env));
    assert.equal(calls,1);
  }
});

test("wrong client, impossible fill, resting IOC and missing fields remain unacknowledged", async () => {
  for (const bad of [
    {...ack,client_order_id:orderId}, {...ack,order_id:""}, {...ack,fill_count:"1.01"},
    {...ack,remaining_count:"0.01"}, {...ack,fill_count:"NaN"}, {...ack,ts_ms:0}, {},
  ]) await assert.rejects(demoBridgeRequest(request, async () => response(bad), env));
  const zero = await demoBridgeRequest(request, async () => response({...ack,fill_count:"0.00"}), env);
  assert.equal(zero.status,"ACKNOWLEDGED");
});

test("one-shot executable validates a private-pipe ping and redacts malformed key input", () => {
  const path = fileURLToPath(new URL("./cellular-demo-bridge.js",import.meta.url));
  const {wire, submitBefore, ...base} = request;
  const good = spawnSync(process.execPath,[path],{input:JSON.stringify({...base,command:"ping"}),env:{...env,PATH:process.env.PATH},encoding:"utf8"});
  assert.equal(good.status,0); assert.equal(JSON.parse(good.stdout).status,"READY");
  const secret = "NEVER_ECHO_SYNTHETIC_PRIVATE_MATERIAL";
  const bad = spawnSync(process.execPath,[path],{input:JSON.stringify({...base,command:"ping",credentials:{...base.credentials,privateKeyPem:secret}}),env:{...env,PATH:process.env.PATH},encoding:"utf8"});
  assert.equal(bad.status,1); assert.equal(JSON.parse(bad.stdout).status,"REFUSED");
  assert.equal(bad.stderr,""); assert.ok(!bad.stdout.includes(secret));
});

test("protective cancellation signs one fixed DEMO DELETE with explicit exchange and no body", async () => {
  let calls = 0;
  const result = await demoBridgeRequest(cancel,async (url,opts)=>{
    calls++;
    assert.equal(url,`https://external-api.demo.kalshi.co/trade-api/v2/portfolio/events/orders/${orderId}?subaccount=0&exchange_index=2`);
    assert.equal(opts?.method,"DELETE"); assert.equal(opts?.body,undefined);
    assert.equal(opts?.redirect,"error"); assert.ok(opts?.signal);
    const headers = new Headers(opts?.headers);
    const content = headers.get("KALSHI-ACCESS-TIMESTAMP") + `DELETE/trade-api/v2/portfolio/events/orders/${orderId}`;
    assert.ok(verify("RSA-SHA256",Buffer.from(content),{key:publicKey,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32},Buffer.from(headers.get("KALSHI-ACCESS-SIGNATURE")!,"base64")));
    return response(cancelAck,200);
  },env);
  assert.equal(calls,1); assert.equal(result.status,"ACKNOWLEDGED");
  assert.ok(!("reduced_by" in result));
});

test("cancel refuses arbitrary scope, route, deadlines and shape before DELETE", async () => {
  let calls=0;
  const transport: typeof fetch = async ()=>{calls++; return response(cancelAck,200);};
  for (const target of [
    {...cancel.target,exchange_index:-1},{...cancel.target,subaccount:1},
    {...cancel.target,order_id:"../all"},{...cancel.target,client_order_id:"unknown"},
    {...cancel.target,remaining_count:"0.00"},{...cancel.target,remaining_count:"0.001"},
    {...cancel.target,ticker:"KXOTHER-TEST"},{...cancel.target,path:"/all"},
  ]) await assert.rejects(demoBridgeRequest({...cancel,target},transport,env));
  for (const raw of [{...cancel,cancelBefore:new Date(0).toISOString()},
    {...cancel,cancelBefore:"bad"},{...cancel,environment:"PRODUCTION"},{...cancel,wire:request.wire}])
    await assert.rejects(demoBridgeRequest(raw,transport,env));
  assert.equal(calls,0);
});

test("cancel acknowledgment cannot invent released risk, and ambiguous transport never retries", async () => {
  for (const bad of [{}, {...cancelAck,order_id:clientId},{...cancelAck,client_order_id:orderId},
    {...cancelAck,reduced_by:"0.76"},{...cancelAck,reduced_by:"NaN"},{...cancelAck,ts_ms:0}])
    await assert.rejects(demoBridgeRequest(cancel,async()=>response(bad,200),env));
  for (const status of [0,201,404,429,500]) {
    let calls=0;
    await assert.rejects(demoBridgeRequest(cancel,async()=>{calls++; if (!status) throw new Error("lost"); return response(cancelAck,status);},env));
    assert.equal(calls,1);
  }
  assert.equal((await demoBridgeRequest(cancel,async()=>response({...cancelAck,reduced_by:"0.00"},200),env)).status,"ACKNOWLEDGED");
});
