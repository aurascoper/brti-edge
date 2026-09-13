"use client";

import * as React from "react";

interface CellularState {
  campaign: {mode:string; reading:string|null; terminal:number};
  risk: {settled_capital_usd:string; daily_gross_loss_usd:string; unresolved_risk_usd:string};
  remaining: Record<string,string>;
  monitor: {status:string; reasons:string[]; availableRiskUsd:string;
    arenas:Record<string,{status:string}>; geolocator:{status:string;reason?:string}};
  activationBlockers:string[];
  confirmations: {firstN:number; remaining:number; environment:string; pending:OrderPreview[]};
}

interface OrderPreview {
  previewId:string; digest:string; status:string; expiresAt:string; reservationStatus:string;
  intent:{ticker:string;outcome:string;action:string;priceDollars:string;quantity:string;subaccount:number};
  translatedOrder:{side:string;price:string;count:string;time_in_force:string};
  risk:{worst_loss_usd:string;fee_reserve_usd:string};
}

export function CellularPanel() {
  const [token,setToken] = React.useState("");
  const [state,setState] = React.useState<CellularState|null>(null);
  const [error,setError] = React.useState<string|null>(null);
  const [busy,setBusy] = React.useState(false);
  const load = React.useCallback(async () => {
    if (!token) { setState(null); return; }
    try {
      const response = await fetch("/api/cellular",{headers:{Authorization:`Bearer ${token}`},cache:"no-store"});
      const body = await response.json();
      if (!response.ok || !body.campaign || !body.monitor) throw new Error(body.reason ?? "invalid_state");
      setState(body); setError(null);
    } catch (e) { setState(null); setError(e instanceof Error ? e.message : "unavailable"); }
  },[token]);
  React.useEffect(() => { void load(); const timer=setInterval(()=>void load(),3000); return ()=>clearInterval(timer); },[load]);
  const action = async (name:string, preview?:OrderPreview) => {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch("/api/cellular",{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({action:name,...(preview?{previewId:preview.previewId,digest:preview.digest}:{})})});
      const body=await response.json();
      if (!response.ok) throw new Error(body.reason ?? "control_refused");
      await load();
    } catch(e) { setError(e instanceof Error ? e.message : "control_refused"); }
    finally { setBusy(false); }
  };
  return <section className="mb-3 rounded border border-zinc-700 p-3 text-xs text-zinc-300">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <strong>Cellular · Kalshi paper pilot</strong>
      <input type="password" aria-label="Cellular operator token" autoComplete="off" placeholder="Operator token" value={token}
        onChange={e=>setToken(e.target.value)} className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1" />
    </div>
    <p className="my-2">Operations validation · $50 allocation · $10 campaign loss cap · $1 per entry · $2 daily gross losses plus risk.</p>
    {!state && <p>{error ?? "Connect to view the paper supervisor."}</p>}
    {state && <>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <span>Mode: {state.campaign.mode} {state.campaign.reading}</span>
        <span>Settled capital: ${state.risk.settled_capital_usd}</span>
        <span>Daily gross loss: ${state.risk.daily_gross_loss_usd}</span>
        <span>Available risk: ${state.monitor.availableRiskUsd}</span>
        {Object.entries(state.monitor.arenas).map(([host,item])=><span key={host}>{host}: {item.status}</span>)}
        <span>Geolocator shadow: {state.monitor.geolocator.status}</span>
        <span>Unresolved risk: ${state.risk.unresolved_risk_usd}</span>
      </div>
      <p className="mt-2">Arenas check determinism. They cannot promote a policy. Pilot P&amp;L cannot establish edge.</p>
      <p className="mt-2 text-amber-300">{state.monitor.reasons.join(" · ")}</p>
      <details className="my-2"><summary>Activation blockers ({state.activationBlockers.length})</summary>
        <ul>{state.activationBlockers.map(reason=><li key={reason}>{reason}</li>)}</ul></details>
      {state.confirmations && <div className="my-3 space-y-2" aria-label="Order confirmations">
        <p>Manual checks remaining: {state.confirmations.remaining} / {state.confirmations.firstN} · {state.confirmations.environment}</p>
        {state.confirmations.pending.map(preview=><article key={preview.previewId} className="rounded border border-amber-700 p-3">
          <strong>{preview.intent.ticker} · {preview.status}</strong>
          <p>Intended: {preview.intent.action} {preview.intent.quantity} {preview.intent.outcome} at ${preview.intent.priceDollars}</p>
          <p>Kalshi translation: YES-book {preview.translatedOrder.side} · ${preview.translatedOrder.price} · {preview.translatedOrder.count} contracts · IOC</p>
          <p>Maximum loss: ${preview.risk.worst_loss_usd} including up to ${preview.risk.fee_reserve_usd} fees.</p>
          <p>Expires: {preview.expiresAt} · {preview.reservationStatus === "NOT_RESERVED" ? "Risk is checked again and reserved at release." : "Risk reserved."}</p>
          <div className="mt-2 flex gap-2">
            {preview.status === "HELD" && <button disabled={busy} onClick={()=>void action("confirm-preview",preview)} className="rounded border px-2 py-1">Confirm translated order</button>}
            {preview.status === "CONFIRMED" && <button disabled={busy} onClick={()=>void action("release-preview",preview)} className="rounded border px-2 py-1">Release paper order</button>}
            {["HELD","CONFIRMED"].includes(preview.status) && <button disabled={busy} onClick={()=>void action("cancel-preview",preview)} className="rounded border px-2 py-1">Cancel preview</button>}
          </div>
        </article>)}
      </div>}
      <div className="flex gap-2">{[["pause","Pause"],["acknowledge","Acknowledge → manage only"],["resume-paper","Resume paper"]].map(([name,label])=>
        <button key={name} disabled={busy} onClick={()=>void action(name!)} className="rounded border border-zinc-600 px-2 py-1">{label}</button>)}</div>
      {error && <p className="mt-2 text-rose-300">{error}</p>}
    </>}
  </section>;
}
