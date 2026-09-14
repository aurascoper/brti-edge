import assert from "node:assert/strict";
import {constants,generateKeyPairSync,verify} from "node:crypto";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import test from "node:test";
import {productionBridgeRequest} from "./cellular-production-bridge.js";
import {demoBridgeRequest} from "./cellular-demo-bridge.js";
import {translate} from "./cellular.js";

const {privateKey,publicKey}=generateKeyPairSync("rsa",{modulusLength:2048});
const env={CELLULAR_PROCESS_ROLE:"executor"};
const id="11111111-1111-4111-8111-111111111111";
const request={schemaId:"cellular.production-adapter-request.v1",id,command:"submit",environment:"PRODUCTION",
  credentials:{keyId:id,privateKeyPem:privateKey.export({type:"pkcs8",format:"pem"}).toString()},firstN:3,seriesUntested:true,
  submitBefore:new Date(Date.now()+60000).toISOString(),
  wire:translate({ticker:"KXBTC15M-FIXTURE",clientOrderId:id,outcome:"NO",action:"buy",priceDollars:"0.48",quantity:"1",subaccount:0,exchangeIndex:2})};
const ack={order_id:id,client_order_id:id,fill_count:"0.00",remaining_count:"0.00",ts_ms:Date.now()};
const response=(status=201)=>new Response(JSON.stringify(ack),{status});

test("production bridge signs the fixed BTC exchange-2 route and zero fill is an acknowledgment only",async()=>{
  let calls=0;
  const result=await productionBridgeRequest(request,async(url,opts)=>{
    calls++;
    assert.equal(url,"https://external-api.kalshi.com/trade-api/v2/portfolio/events/orders");
    assert.equal(opts?.method,"POST"); assert.equal(opts?.redirect,"error"); assert.ok(opts?.signal);
    assert.deepEqual(JSON.parse(String(opts?.body)),request.wire);
    const headers=new Headers(opts?.headers);
    const signed=headers.get("KALSHI-ACCESS-TIMESTAMP")+"POST/trade-api/v2/portfolio/events/orders";
    const signature=Buffer.from(headers.get("KALSHI-ACCESS-SIGNATURE")!,"base64");
    const key={key:publicKey,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32};
    assert.ok(verify("RSA-SHA256",Buffer.from(signed),key,signature));
    assert.equal(verify("RSA-SHA256",Buffer.from(signed+"?exchange_index=0"),key,signature),false);
    return response();
  },env);
  assert.equal(calls,1); assert.equal(result.environment,"PRODUCTION");
  assert.equal(result.status,"ACKNOWLEDGED"); assert.ok(!("fill_count" in result));
});

test("production refuses cross-environment, mutable hosts, wrong shards, manual count and role before network",async()=>{
  let calls=0; const transport:typeof fetch=async()=>{calls++;return response();};
  for(const raw of [
    {...request,environment:"DEMO"},{...request,schemaId:"cellular.demo-adapter-request.v1"},
    {...request,firstN:0},{...request,firstN:2},{...request,firstN:4},
    {...request,baseUrl:"https://example.invalid"},{...request,wire:{...request.wire,exchange_index:0}},
    {...request,wire:{...request.wire,exchange_index:1}},{...request,wire:{...request.wire,subaccount:1}},
    {...request,submitBefore:new Date(0).toISOString()},
  ]) await assert.rejects(productionBridgeRequest(raw,transport,env));
  await assert.rejects(demoBridgeRequest(request,transport,env));
  await assert.rejects(productionBridgeRequest(request,transport,{CELLULAR_PROCESS_ROLE:"arena"}));
  await assert.rejects(productionBridgeRequest(request,transport,{...env,KALSHI_API_KEY_ID:"unscoped"}));
  assert.equal(calls,0);
});

test("production timeout or unsuccessful response cannot retry or turn into acceptance",async()=>{
  for(const status of [0,200,401,429,500]){
    let calls=0;
    await assert.rejects(productionBridgeRequest(request,async()=>{
      calls++; if(!status) throw new Error("SYNTHETIC lost acknowledgment"); return response(status);
    },env));
    assert.equal(calls,1);
  }
});

test("production protective DELETE is exchange 2 and cannot become a new order",async()=>{
  const {wire,submitBefore,...base}=request;
  const target={order_id:id,client_order_id:id,ticker:wire.ticker,exchange_index:2,subaccount:0,remaining_count:"0.75"};
  const cancel={...base,command:"cancel",target,cancelBefore:submitBefore};
  let calls=0;
  const transport:typeof fetch=async(url,opts)=>{
    calls++;assert.equal(url,`https://external-api.kalshi.com/trade-api/v2/portfolio/events/orders/${id}?subaccount=0&exchange_index=2`);
    assert.equal(opts?.method,"DELETE");assert.equal(opts?.body,undefined);
    return new Response(JSON.stringify({order_id:id,client_order_id:id,reduced_by:"0.75",ts_ms:Date.now()}),{status:200});
  };
  assert.equal((await productionBridgeRequest(cancel,transport,env)).status,"ACKNOWLEDGED");
  await assert.rejects(productionBridgeRequest({...cancel,target:{...target,exchange_index:0}},transport,env));
  assert.equal(calls,1);
});

test("distinct executable accepts only production ping and redacts malformed credentials",()=>{
  const script=fileURLToPath(new URL("./cellular-production-bridge.js",import.meta.url));
  const {wire,submitBefore,...base}=request;
  const ping={...base,command:"ping"};
  const run=(body:unknown)=>spawnSync(process.execPath,[script],{input:JSON.stringify(body),encoding:"utf8",env:{...env,PATH:process.env.PATH}});
  const good=run(ping);assert.equal(good.status,0);assert.equal(JSON.parse(good.stdout).transport,"brti_production");
  const wrong=run({...ping,environment:"DEMO"});assert.equal(wrong.status,1);
  const secret="SYNTHETIC_NEVER_ECHO_PRIVATE_MATERIAL";
  const bad=run({...ping,credentials:{...ping.credentials,privateKeyPem:secret}});
  assert.equal(bad.status,1);assert.equal(bad.stderr,"");assert.ok(!bad.stdout.includes(secret));
});
