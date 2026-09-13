import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { bridgeRequest } from "./cellular-bridge.js";

test("translation bridge rejects submission commands and unknown intent fields", () => {
  const base = {schemaId:"cellular.adapter-request.v1",id:"fixture",command:"translate",intent:{ticker:"KXBTC15M-TEST",clientOrderId:"fixture",outcome:"NO",action:"buy",priceDollars:"0.48",quantity:"1",subaccount:0}};
  const response = bridgeRequest(base);
  assert.equal((response.wire as {side:string}).side, "ask");
  assert.equal((bridgeRequest({...base,intent:{...base.intent,exchangeIndex:2}}).wire as {exchange_index:number}).exchange_index,2);
  assert.throws(()=>bridgeRequest({...base,intent:{...base.intent,exchangeIndex:1}}),/exchange_index/);
  assert.throws(()=>bridgeRequest({...base,command:"submit"}),/command_refused/);
  assert.throws(()=>bridgeRequest({...base,intent:{...base.intent,apiKey:"dummy"}}),/intent_shape/);
});

test("real bridge startup refuses zero manual count for an untested series", () => {
  const path = fileURLToPath(new URL("./cellular-bridge.js", import.meta.url));
  const input = JSON.stringify({schemaId:"cellular.adapter-request.v1",id:"fixture",command:"ping"})+"\n";
  const env = {PATH:process.env.PATH,CELLULAR_PROCESS_ROLE:"executor"};
  const bad = spawnSync(process.execPath,[path,"--manual-first-n","0","--series-untested","true"],{input,env,encoding:"utf8"});
  assert.equal(bad.status,1); assert.equal(bad.stdout,"");
  const good = spawnSync(process.execPath,[path,"--manual-first-n","1","--series-untested","true"],{input,env,encoding:"utf8"});
  assert.equal(good.status,0); assert.equal(JSON.parse(good.stdout).status,"READY");
});
