"use client";

import * as React from "react";

interface CellularState {
  campaign: {mode:string; reading:string|null; terminal:number};
  risk: {settled_capital_usd:string; daily_gross_loss_usd:string; unresolved_risk_usd:string};
  remaining: Record<string,string>;
  monitor: {status:string; reasons:string[]; availableRiskUsd:string;
    arenas:Record<string,{status:string}>; geolocator:{status:string;reason?:string}};
  activationBlockers:string[];
}

export function CellularPanel() {
  const [token,setToken] = React.useState("");
  const [state,setState] = React.useState<CellularState|null>(null);
  const [error,setError] = React.useState<string|null>(null);
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
  const action = async (name:string) => {
    try {
      const response = await fetch("/api/cellular",{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({action:name})});
      const body=await response.json();
      if (!response.ok) throw new Error(body.reason ?? "control_refused");
      await load();
    } catch(e) { setError(e instanceof Error ? e.message : "control_refused"); }
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
      <div className="flex gap-2">{[["pause","Pause"],["acknowledge","Acknowledge → manage only"],["resume-paper","Resume paper"]].map(([name,label])=>
        <button key={name} onClick={()=>void action(name!)} className="rounded border border-zinc-600 px-2 py-1">{label}</button>)}</div>
      {error && <p className="mt-2 text-rose-300">{error}</p>}
    </>}
  </section>;
}
