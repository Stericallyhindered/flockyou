import { gunzipSync } from "node:zlib";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type CameraFeature = {
  type: "Feature";
  geometry?: { type?: string; coordinates?: unknown };
  properties?: Record<string, unknown>;
};

type CameraCollection = {
  type: "FeatureCollection";
  features: CameraFeature[];
};

type FeedCache = {
  source: string;
  expiresAt: number;
  data: CameraCollection;
};

let feedCache: FeedCache | null = null;
let pendingFeed: Promise<CameraCollection> | null = null;

function parseBounds(value: string | null) {
  const values = value?.split(",").map(Number) ?? [];
  if (values.length !== 4 || values.some((coordinate) => !Number.isFinite(coordinate))) return null;
  const [west, south, east, north] = values;
  if (west >= east || south >= north) return null;
  return { west, south, east, north };
}

async function loadFeed(source: string) {
  if (feedCache?.source === source && feedCache.expiresAt > Date.now()) return feedCache.data;
  if (pendingFeed) return pendingFeed;

  pendingFeed = (async () => {
    const response = await fetch(source, {
      headers: { Accept: "application/geo+json, application/json, application/gzip" },
      next: { revalidate: 900 }
    });
    if (!response.ok) throw new Error(`Camera source returned ${response.status}`);

    const raw = Buffer.from(await response.arrayBuffer());
    const bytes = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
    const data = JSON.parse(bytes.toString("utf8")) as CameraCollection;
    if (data.type !== "FeatureCollection" || !Array.isArray(data.features)) {
      throw new Error("Camera source is not a GeoJSON FeatureCollection");
    }
    feedCache = { source, expiresAt: Date.now() + 15 * 60 * 1000, data };
    return data;
  })();

  try {
    return await pendingFeed;
  } finally {
    pendingFeed = null;
  }
}

export async function GET(request: NextRequest) {
  const source = request.nextUrl.searchParams.get("url");
  const bounds = parseBounds(request.nextUrl.searchParams.get("bbox"));
  if (!source) return NextResponse.json({ error: "Missing camera URL" }, { status: 400 });
  if (!bounds) {
    return NextResponse.json(
      { type: "FeatureCollection", features: [], total: 0, staleClient: true },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  let url: URL;
  try {
    url = new URL(source);
    if (url.protocol !== "https:") throw new Error("HTTPS required");
  } catch {
    return NextResponse.json({ error: "Invalid camera URL" }, { status: 400 });
  }

  try {
    const data = await loadFeed(url.toString());
    const features = data.features.filter((feature) => {
      if (feature.geometry?.type !== "Point" || !Array.isArray(feature.geometry.coordinates)) return false;
      const [lon, lat] = feature.geometry.coordinates.map(Number);
      return Number.isFinite(lon) && Number.isFinite(lat) &&
        lon >= bounds.west && lon <= bounds.east && lat >= bounds.south && lat <= bounds.north;
    });

    return NextResponse.json({ type: "FeatureCollection", features, total: data.features.length }, {
      headers: { "Cache-Control": "public, s-maxage=900, stale-while-revalidate=3600" }
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Camera feed failed" },
      { status: 502 }
    );
  }
}
