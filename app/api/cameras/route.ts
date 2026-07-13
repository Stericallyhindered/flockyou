import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const DEFLOCK_INDEX_URL = "https://cdn.deflock.me/regions/index.json";

type Bounds = { west: number; south: number; east: number; north: number };
type CameraRecord = {
  id: string | number;
  lat: number;
  lon: number;
  tags?: Record<string, unknown>;
};
type TileIndex = {
  expiration_utc: number;
  regions: string[];
  tile_url: string;
  tile_size_degrees: number;
};

let indexCache: TileIndex | null = null;
const tileCache = new Map<string, { expiresAt: number; records: CameraRecord[] }>();

function parseBounds(value: string | null): Bounds | null {
  const values = value?.split(",").map(Number) ?? [];
  if (values.length !== 4 || values.some((coordinate) => !Number.isFinite(coordinate))) return null;
  const [west, south, east, north] = values;
  if (west >= east || south >= north) return null;
  return { west, south, east, north };
}

async function loadIndex() {
  if (indexCache && indexCache.expiration_utc * 1000 > Date.now()) return indexCache;
  const response = await fetch(DEFLOCK_INDEX_URL, { next: { revalidate: 300 } });
  if (!response.ok) throw new Error(`DeFlock tile index returned ${response.status}`);
  const data = await response.json() as TileIndex;
  if (!Array.isArray(data.regions) || !data.tile_url || !Number.isFinite(data.tile_size_degrees)) {
    throw new Error("DeFlock tile index is invalid");
  }
  indexCache = data;
  return data;
}

function tileKeys(bounds: Bounds, tileSize: number, available: Set<string>) {
  const keys: string[] = [];
  const startLat = Math.floor(bounds.south / tileSize) * tileSize;
  const endLat = Math.floor(bounds.north / tileSize) * tileSize;
  const startLon = Math.floor(bounds.west / tileSize) * tileSize;
  const endLon = Math.floor(bounds.east / tileSize) * tileSize;
  for (let lat = startLat; lat <= endLat; lat += tileSize) {
    for (let lon = startLon; lon <= endLon; lon += tileSize) {
      const key = `${lat}/${lon}`;
      if (available.has(key)) keys.push(key);
    }
  }
  return keys;
}

async function loadTile(index: TileIndex, key: string) {
  const url = index.tile_url.replace("{lat}/{lon}", key);
  const cached = tileCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.records;
  const response = await fetch(url, { next: { revalidate: 300 } });
  if (!response.ok) throw new Error(`DeFlock camera tile returned ${response.status}`);
  const records = await response.json() as CameraRecord[];
  if (!Array.isArray(records)) throw new Error("DeFlock camera tile is invalid");
  tileCache.set(url, { expiresAt: Math.min(index.expiration_utc * 1000, Date.now() + 5 * 60 * 1000), records });
  return records;
}

export async function GET(request: NextRequest) {
  const bounds = parseBounds(request.nextUrl.searchParams.get("bbox"));
  if (!bounds) {
    return NextResponse.json(
      { type: "FeatureCollection", features: [], total: 0, staleClient: true },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    const index = await loadIndex();
    const keys = tileKeys(bounds, index.tile_size_degrees, new Set(index.regions));
    const tiles = await Promise.all(keys.map((key) => loadTile(index, key)));
    const records = tiles.flat();
    const visible = records.filter(({ lon, lat }) =>
      Number.isFinite(lon) && Number.isFinite(lat) &&
      lon >= bounds.west && lon <= bounds.east && lat >= bounds.south && lat <= bounds.north
    );
    const features = visible.map((record) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [record.lon, record.lat] },
      properties: { ...record.tags, id: record.id }
    }));

    return NextResponse.json({ type: "FeatureCollection", features, total: records.length }, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=900" }
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Camera feed failed" },
      { status: 502 }
    );
  }
}
