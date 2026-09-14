"use client";

import * as React from "react";

interface CellularState {
  transport:string;
  day1?: {status:string; ordersEnabled:boolean; day1StartedAt:string|null;
    activationRequest?:Record<string,unknown>|null};
  campaign: {mode:string; reading:string|null; terminal:number};
  risk: {settled_capital_usd:string; daily_gross_loss_usd:string; unresolved_risk_usd:string};
  remaining: Record<string,string>;
  monitor: {status:string; reasons:string[]; availableRiskUsd:string;
    executionExchangeIndex?:number; executionCashUsd?:string|null;
    arenas:Record<string,{status:string}>; geolocator:{status:string;reason?:string}};
  activationBlockers:string[];
  confirmations: {firstN:number; remaining:number; environment:string; pending:OrderPreview[]};
  protectiveCancellation?: {orders:{clientOrderId:string; ticker:string}[];
    attempts:{requestId:string;clientOrderId:string;status:string}[]};
  demoMechanics?: {selectedTicker:string|null; allOrdersRequireConfirmation:boolean;
    quote:{ticker:string; quoteDigest:string; asksUsd:{YES:string;NO:string}; closeTime:string}|null};
}

interface OrderPreview {
  previewId:string; digest:string; status:string; expiresAt:string; reservationStatus:string;
  intent:{ticker:string;outcome:string;action:string;priceDollars:string;quantity:string;subaccount:number};
  translatedOrder:{side:string;price:string;count:string;time_in_force:string;exchange_index?:number};
  risk:{worst_loss_usd:string;fee_reserve_usd:string};
}

export function CellularPanel() {
  const [token,setToken] = React.useState("");
  const [state,setState] = React.useState<CellularState|null>(null);
  const [error,setError] = React.useState<string|null>(null);
  const [busy,setBusy] = React.useState(false);
  const [ticker,setTicker] = React.useState("");
  const [outcome,setOutcome] = React.useState<"YES"|"NO">("YES");
  const [quantity,setQuantity] = React.useState("1");
  const [activationDecision,setActivationDecision] = React.useState("");
  const production = state?.transport === "brti_production";
  const loading = React.useRef(false);
  const load = React.useCallback(async () => {
    if (!token) { setState(null); return; }
    if (loading.current) return;
    loading.current = true;
    try {
      const response = await fetch("/api/cellular",{headers:{Authorization:`Bearer ${token}`},cache:"no-store"});
      const body = await response.json();
      if (!response.ok || !body.campaign || !body.monitor) throw new Error(body.reason ?? "invalid_state");
      setState(body); setError(null);
    } catch (e) { setState(null); setError(e instanceof Error ? e.message : "unavailable"); }
    finally { loading.current = false; }
  },[token]);
  React.useEffect(() => { void load(); const timer=setInterval(()=>void load(),3000); return ()=>clearInterval(timer); },[load]);
  const action = async (name:string, preview?:OrderPreview, details:Record<string,unknown>={}) => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch("/api/cellular",{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({action:name,...details,...(preview?{previewId:preview.previewId,digest:preview.digest}:{})})});
      const body=await response.json();
      if (!response.ok || body.status === "REFUSED") throw new Error(body.reason ?? body.preview?.reason ?? "control_refused");
      await load();
    } catch(e) { setError(e instanceof Error ? e.message : "control_refused"); }
    finally { setBusy(false); }
  };
  const activate = async () => {
    try {
      const decision = JSON.parse(activationDecision);
      if (!decision || typeof decision !== "object" || !decision.signature || !decision.record)
        throw new Error("A signed activation decision is required.");
      await action("activate-live",undefined,{decision});
      setActivationDecision("");
    } catch(e) { setError(e instanceof Error ? e.message : "Invalid activation decision."); }
  };
  return <section className="mb-3 rounded border border-zinc-700 p-3 text-xs text-zinc-300">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <strong>Cellular · Kalshi {production ? "PRODUCTION pilot" : state?.demoMechanics ? "DEMO mechanics" : "paper pilot"}</strong>
      <input type="password" aria-label="Cellular operator token" autoComplete="off" placeholder="Operator token" value={token}
        onChange={e=>setToken(e.target.value)} className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1" />
    </div>
    <p className="my-2">Operations validation · $50 allocation · $10 campaign loss cap · $1 per entry · $2 daily gross losses plus risk.</p>
    {!state && <p>{error ?? "Connect to view the supervisor."}</p>}
    {state && <>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <span>Mode: {state.campaign.mode} {state.campaign.reading}</span>
        <span>Settled capital: ${state.risk.settled_capital_usd}</span>
        <span>Daily gross loss: ${state.risk.daily_gross_loss_usd}</span>
        <span>Available risk: ${state.monitor.availableRiskUsd}</span>
        {state.demoMechanics && <span>Exchange {state.monitor.executionExchangeIndex} cash: {state.monitor.executionCashUsd == null ? "unverified" : `$${state.monitor.executionCashUsd}`}</span>}
        {Object.entries(state.monitor.arenas).map(([host,item])=><span key={host}>{host}: {item.status}</span>)}
        <span>Geolocator shadow: {state.monitor.geolocator.status}</span>
        <span>Unresolved risk: ${state.risk.unresolved_risk_usd}</span>
      </div>
      <p className="mt-2">Arenas check determinism. They cannot promote a policy. Pilot P&amp;L cannot establish edge.</p>
      <p className="mt-2 text-amber-300">{state.monitor.reasons.join(" · ")}</p>
      <details className="my-2"><summary>Activation blockers ({state.activationBlockers.length})</summary>
        <ul>{state.activationBlockers.map(reason=><li key={reason}>{reason}</li>)}</ul></details>
      {production && state.day1 && <div className="my-3 space-y-2 rounded border border-amber-700 p-3" aria-label="Production activation">
        <p>Day 1: {state.day1.status} · Orders {state.day1.ordersEnabled ? "enabled" : "disabled"} · Started {state.day1.day1StartedAt ?? "not started"}</p>
        <p>Activation requires reviewed evidence and a separate signed operator decision. Resuming preserves the original start time and all loss and confirmation counters.</p>
        {state.day1.activationRequest && <details><summary>Activation request to sign</summary><pre className="overflow-x-auto whitespace-pre-wrap">{JSON.stringify(state.day1.activationRequest,null,2)}</pre></details>}
        <textarea aria-label="Signed activation decision" autoComplete="off" placeholder="Signed decision JSON" value={activationDecision} onChange={e=>setActivationDecision(e.target.value)} className="w-full rounded border bg-zinc-900 px-2 py-1" />
        <button disabled={busy || state.day1.status !== "READY_FOR_ACTIVATION" || !activationDecision} onClick={()=>void activate()} className="rounded border px-2 py-1">{state.day1.day1StartedAt ? "Resume production with signed decision" : "Activate Day 1 with signed decision"}</button>
        {state.campaign.reading === "VOID" && <button disabled={busy} onClick={()=>void action("restart-void-live")} className="ml-2 rounded border px-2 py-1">Record permitted VOID restart → manage only</button>}
      </div>}
      {state.demoMechanics && <div className="my-3 space-y-2 rounded border border-zinc-600 p-3" aria-label="Demo order preparation">
        <p>DEMO account only. Select a BTC 15-minute market. Every order needs confirmation and a separate release.</p>
        <div className="flex flex-wrap gap-2">
          <input aria-label="Demo market ticker" value={ticker} onChange={e=>setTicker(e.target.value)} placeholder="KXBTC15M-…" className="rounded border bg-zinc-900 px-2 py-1" />
          <button disabled={busy || !ticker} onClick={()=>void action("select-demo-market",undefined,{ticker})} className="rounded border px-2 py-1">Load demo quote</button>
        </div>
        {state.demoMechanics.quote && <>
          <p>{state.demoMechanics.quote.ticker} · YES ask ${state.demoMechanics.quote.asksUsd.YES} · NO ask ${state.demoMechanics.quote.asksUsd.NO} · closes {state.demoMechanics.quote.closeTime}</p>
          <div className="flex flex-wrap gap-2">
            <select aria-label="Demo outcome" value={outcome} onChange={e=>setOutcome(e.target.value as "YES"|"NO")} className="rounded border bg-zinc-900 px-2 py-1"><option>YES</option><option>NO</option></select>
            <input aria-label="Demo contract count" type="number" min="1" step="1" value={quantity} onChange={e=>setQuantity(e.target.value)} className="w-20 rounded border bg-zinc-900 px-2 py-1" />
            <button disabled={busy || state.campaign.mode !== "DEMO"} onClick={()=>void action("prepare-demo",undefined,{ticker:state.demoMechanics!.quote!.ticker,outcome,quantity,quoteDigest:state.demoMechanics!.quote!.quoteDigest})} className="rounded border px-2 py-1">Prepare demo preview</button>
          </div>
        </>}
      </div>}
      {state.confirmations && <div className="my-3 space-y-2" aria-label="Order confirmations">
        <p>Manual checks remaining: {state.confirmations.remaining} / {state.confirmations.firstN} · {state.confirmations.environment}</p>
        {state.confirmations.pending.map(preview=><article key={preview.previewId} className="rounded border border-amber-700 p-3">
          <strong>{preview.intent.ticker} · {preview.status}</strong>
          <p>Intended: {preview.intent.action} {preview.intent.quantity} {preview.intent.outcome} at ${preview.intent.priceDollars}</p>
          <p>Kalshi translation: YES-book {preview.translatedOrder.side} · ${preview.translatedOrder.price} · {preview.translatedOrder.count} contracts · IOC · exchange {preview.translatedOrder.exchange_index ?? "undeclared"}</p>
          <p>Maximum loss: ${preview.risk.worst_loss_usd} including up to ${preview.risk.fee_reserve_usd} fees.</p>
          <p>Expires: {preview.expiresAt} · {preview.reservationStatus === "NOT_RESERVED" ? "Risk is checked again and reserved at release." : "Risk reserved."}</p>
          <div className="mt-2 flex gap-2">
            {preview.status === "HELD" && <button disabled={busy} onClick={()=>void action("confirm-preview",preview)} className="rounded border px-2 py-1">Confirm translated order</button>}
            {preview.status === "CONFIRMED" && <button disabled={busy} onClick={()=>void action("release-preview",preview)} className="rounded border px-2 py-1">Release {state.confirmations.environment === "PRODUCTION" ? "production" : state.confirmations.environment === "DEMO" ? "demo" : "paper"} order</button>}
            {["HELD","CONFIRMED"].includes(preview.status) && <button disabled={busy} onClick={()=>void action("cancel-preview",preview)} className="rounded border px-2 py-1">Cancel preview</button>}
          </div>
        </article>)}
      </div>}
      <div className="flex gap-2">{[["pause","Pause"],["acknowledge","Acknowledge → manage only"],...(production ? [] : [state.demoMechanics ? ["resume-demo","Enable demo mechanics"] : ["resume-paper","Resume paper"]])].map(([name,label])=>
        <button key={name} disabled={busy} onClick={()=>void action(name!)} className="rounded border border-zinc-600 px-2 py-1">{label}</button>)}</div>
      {state.protectiveCancellation && <div className="my-3 space-y-2" aria-label={production ? "Protective production cancellation" : "Protective demo cancellation"}>
        <p>Cancel an owned {production ? "PRODUCTION" : "DEMO"} order’s unfilled remainder. A fresh venue read verifies ownership. Risk stays charged until reconciliation; filled contracts remain held to settlement.</p>
        {state.protectiveCancellation.orders.filter(order=>Number(state.remaining[order.clientOrderId] ?? 0)>0).map(order=><div key={order.clientOrderId}>
          <span>{order.ticker} · order {order.clientOrderId} </span>
          <button disabled={busy} onClick={()=>void action("cancel-owned-order",undefined,{clientOrderId:order.clientOrderId,requestId:crypto.randomUUID()})} className="rounded border px-2 py-1">Cancel owned {production ? "production" : "demo"} order</button>
        </div>)}
        {state.protectiveCancellation.attempts.map(attempt=><p key={attempt.requestId}>Cancellation result for {attempt.clientOrderId}: {attempt.status}</p>)}
      </div>}
      {error && <p className="mt-2 text-rose-300">{error}</p>}
    </>}
  </section>;
}
