import { gunzipSync } from "node:zlib";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const source = request.nextUrl.searchParams.get("url");
  if (!source) return NextResponse.json({ error: "Missing camera URL" }, { status: 400 });

  let url: URL;
  try {
    url = new URL(source);
    if (url.protocol !== "https:") throw new Error("HTTPS required");
  } catch {
    return NextResponse.json({ error: "Invalid camera URL" }, { status: 400 });
  }

  try {
    const response = await fetch(url, {
      headers: { Accept: "application/geo+json, application/json, application/gzip" },
      next: { revalidate: 900 }
    });
    if (!response.ok) {
      return NextResponse.json({ error: `Camera source returned ${response.status}` }, { status: 502 });
    }

    const raw = Buffer.from(await response.arrayBuffer());
    const bytes = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
    const data = JSON.parse(bytes.toString("utf8"));
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, s-maxage=900, stale-while-revalidate=3600" }
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Camera feed failed" },
      { status: 502 }
    );
  }
}
