import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

async function proxy(request: NextRequest, method: "GET" | "POST") {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return NextResponse.json({reason:"authentication_required"},{status:401});
  // Fixed operator-configured destination, never an arbitrary browser URL.
  const base = process.env.CELLULAR_SUPERVISOR_URL ?? "http://127.0.0.1:4198";
  try {
    const response = await fetch(base + (method === "GET" ? "/state" : "/control"), {
      method, headers: {authorization, "content-type":"application/json"}, cache:"no-store",
      ...(method === "POST" ? {body:await request.text()} : {}), signal:AbortSignal.timeout(25000), redirect:"error",
    });
    return new NextResponse(await response.text(), {status:response.status, headers:{"content-type":"application/json","cache-control":"no-store"}});
  } catch {
    return NextResponse.json({reason:"cellular_supervisor_unavailable"},{status:503});
  }
}
export const GET = (request: NextRequest) => proxy(request,"GET");
export const POST = (request: NextRequest) => proxy(request,"POST");
