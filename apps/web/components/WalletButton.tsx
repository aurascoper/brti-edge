"use client";

import * as React from "react";
import {
  useAccount,
  useChainId,
  useConnect,
  useConnectors,
  useDisconnect,
  useSwitchChain,
} from "wagmi";
import { polygon } from "wagmi/chains";
import { HAS_WALLETCONNECT } from "../lib/wagmi";

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function WalletButton() {
  const { address, isConnected, connector: activeConnector } = useAccount();
  const { disconnect, disconnectAsync } = useDisconnect();
  const { connectAsync, isPending, error, variables, reset } = useConnect();
  const allConnectors = useConnectors();
  const chainId = useChainId();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  const connectWithReset = React.useCallback(
    async (connector: (typeof allConnectors)[number]) => {
      try {
        await connectAsync({ connector });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const stale = /already connected|connector\.connect/i.test(msg);
        if (!stale) return;
        try {
          for (const c of allConnectors) {
            try {
              await c.disconnect?.();
            } catch {}
          }
          await disconnectAsync();
        } catch {}
        reset();
        try {
          await connectAsync({ connector });
        } catch {}
      }
    },
    [allConnectors, connectAsync, disconnectAsync, reset],
  );

  if (!mounted) return <div style={{ width: 200 }} />;

  if (!isConnected || !address) {
    const injectedConnector =
      allConnectors.find((c) => c.id === "metaMask" || c.id === "io.metamask") ??
      allConnectors.find((c) => c.id === "injected");
    const wcConnector = allConnectors.find((c) => c.id === "walletConnect");
    const hasInjected =
      typeof window !== "undefined" && Boolean((window as { ethereum?: unknown }).ethereum);
    const pendingConnector = isPending ? variables?.connector : null;
    const pendingId =
      pendingConnector && "id" in pendingConnector ? pendingConnector.id : null;

    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex gap-2">
          <button
            type="button"
            disabled={!injectedConnector || isPending}
            onClick={() => injectedConnector && connectWithReset(injectedConnector)}
            className="rounded border border-cyan-700 bg-cyan-950/40 px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-cyan-200 transition hover:bg-cyan-950 disabled:opacity-50"
            title={hasInjected ? "browser wallet (MetaMask / injected)" : "no wallet detected"}
          >
            {pendingId === injectedConnector?.id ? "connecting…" : "browser wallet"}
          </button>
          {wcConnector && (
            <button
              type="button"
              disabled={isPending}
              onClick={() => connectWithReset(wcConnector)}
              className="rounded border border-violet-700 bg-violet-950/40 px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-violet-200 transition hover:bg-violet-950 disabled:opacity-50"
              title="WalletConnect (mobile wallet via QR)"
            >
              {pendingId === wcConnector.id ? "scan qr…" : "walletconnect"}
            </button>
          )}
        </div>
        {!hasInjected && !HAS_WALLETCONNECT && (
          <span className="font-mono text-[9px] text-amber-300">
            no wallet detected · install one or set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
          </span>
        )}
        {error && (
          <span
            className="max-w-[280px] truncate font-mono text-[9px] text-rose-300"
            title={error.message}
          >
            {error.message}
          </span>
        )}
        <button
          type="button"
          onClick={async () => {
            try {
              for (const c of allConnectors) {
                try {
                  await c.disconnect?.();
                } catch {}
              }
              await disconnectAsync();
            } catch {}
            reset();
            if (typeof window !== "undefined") {
              try {
                const ls = window.localStorage;
                const ss = window.sessionStorage;
                const drop = (s: Storage) => {
                  const keys: string[] = [];
                  for (let i = 0; i < s.length; i++) {
                    const k = s.key(i);
                    if (!k) continue;
                    if (/^(wc@|walletconnect|wagmi|W3M|@w3m)/i.test(k)) keys.push(k);
                  }
                  keys.forEach((k) => s.removeItem(k));
                };
                drop(ls);
                drop(ss);
              } catch {}
            }
          }}
          className="font-mono text-[9px] text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline"
          title="clear stale wagmi/walletconnect state"
        >
          stuck? force reset
        </button>
      </div>
    );
  }

  const onWrongChain = chainId !== polygon.id;
  if (onWrongChain) {
    return (
      <button
        type="button"
        disabled={isSwitching}
        onClick={() => switchChain({ chainId: polygon.id })}
        className="rounded border border-amber-700 bg-amber-950/40 px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-amber-200 hover:bg-amber-950 disabled:opacity-50"
      >
        {isSwitching ? "switching…" : "switch to polygon"}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => disconnect()}
      className="rounded border border-zinc-700 bg-zinc-900 px-3 py-1.5 font-mono text-xs text-zinc-100 hover:border-rose-600 hover:text-rose-300"
      title={`${address} · click to disconnect`}
    >
      {shortAddr(address)}
    </button>
  );
}
