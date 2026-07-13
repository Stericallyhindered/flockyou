import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "edge";

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
  const response = await fetch(DEFLOCK_INDEX_URL, {
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; FLOCKYOU/1.0; +https://github.com/Stericallyhindered/flockyou)"
    }
  });
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

function routeTileKeys(route: number[][], tileSize: number, available: Set<string>) {
  const keys = new Set<string>();
  for (const [lon, lat] of route) {
    const key = `${Math.floor(lat / tileSize) * tileSize}/${Math.floor(lon / tileSize) * tileSize}`;
    if (available.has(key)) keys.add(key);
  }
  return [...keys];
}

function routeBounds(route: number[][], paddingDegrees: number): Bounds {
  const longitudes = route.map(([lon]) => lon);
  const latitudes = route.map(([, lat]) => lat);
  return {
    west: Math.min(...longitudes) - paddingDegrees,
    south: Math.min(...latitudes) - paddingDegrees,
    east: Math.max(...longitudes) + paddingDegrees,
    north: Math.max(...latitudes) + paddingDegrees
  };
}

function isNearRoute(record: CameraRecord, route: number[][], corridorMeters: number) {
  const metersPerLatitude = 110_540;
  for (let index = 1; index < route.length; index += 1) {
    const [startLon, startLat] = route[index - 1];
    const [endLon, endLat] = route[index];
    const latitude = (record.lat + startLat + endLat) / 3;
    const metersPerLongitude = 111_320 * Math.cos(latitude * Math.PI / 180);
    const ax = (startLon - record.lon) * metersPerLongitude;
    const ay = (startLat - record.lat) * metersPerLatitude;
    const bx = (endLon - record.lon) * metersPerLongitude;
    const by = (endLat - record.lat) * metersPerLatitude;
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    const interpolation = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared));
    const x = ax + interpolation * dx;
    const y = ay + interpolation * dy;
    if (x * x + y * y <= corridorMeters * corridorMeters) return true;
  }
  return false;
}

function toFeature(record: CameraRecord) {
  return {
    type: "Feature" as const,
    geometry: { type: "Point" as const, coordinates: [record.lon, record.lat] },
    properties: { ...record.tags, id: record.id }
  };
}

async function loadTile(index: TileIndex, key: string) {
  const url = index.tile_url.replace("{lat}/{lon}", key);
  const cached = tileCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.records;
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; FLOCKYOU/1.0; +https://github.com/Stericallyhindered/flockyou)"
    }
  });
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
    const features = visible.map(toFeature);

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

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { route?: unknown; corridorMeters?: unknown };
    if (!Array.isArray(body.route)) return NextResponse.json({ error: "A route is required" }, { status: 400 });
    const route = body.route
      .filter((coordinate): coordinate is number[] => Array.isArray(coordinate) && coordinate.length >= 2)
      .map(([lon, lat]) => [Number(lon), Number(lat)])
      .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
    if (route.length < 2 || route.length > 400) {
      return NextResponse.json({ error: "Route must contain between 2 and 400 coordinates" }, { status: 400 });
    }
    const corridorMeters = Math.max(500, Math.min(8_000, Number(body.corridorMeters) || 4_000));
    const index = await loadIndex();
    const keys = routeTileKeys(route, index.tile_size_degrees, new Set(index.regions));
    const records = (await Promise.all(keys.map((key) => loadTile(index, key)))).flat();
    const paddingDegrees = corridorMeters / 90_000;
    const bounds = routeBounds(route, paddingDegrees);
    const corridorRecords = records.filter((record) =>
      record.lon >= bounds.west && record.lon <= bounds.east &&
      record.lat >= bounds.south && record.lat <= bounds.north &&
      isNearRoute(record, route, corridorMeters)
    );
    return NextResponse.json({
      type: "FeatureCollection",
      features: corridorRecords.map(toFeature),
      total: records.length
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Camera corridor failed" },
      { status: 502 }
    );
  }
}
