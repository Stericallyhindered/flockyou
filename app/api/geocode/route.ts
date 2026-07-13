import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("q")?.trim();
  if (!query) return NextResponse.json({ error: "Missing search query" }, { status: 400 });
  const lat = Number(request.nextUrl.searchParams.get("lat"));
  const lon = Number(request.nextUrl.searchParams.get("lon"));
  const hasProximity = Number.isFinite(lat) && Number.isFinite(lon);
  const orsKey = request.headers.get("x-ors-key")?.trim();

  const providers = [
    ...(orsKey ? [`https://api.openrouteservice.org/geocode/search?api_key=${encodeURIComponent(orsKey)}&size=8&boundary.country=US&text=${encodeURIComponent(query)}${hasProximity ? `&focus.point.lat=${lat}&focus.point.lon=${lon}` : ""}`] : []),
    `https://api.deflock.org/geocode/multi?q=${encodeURIComponent(query)}`,
    `https://nominatim.openstreetmap.org/search?format=json&limit=8&countrycodes=us&q=${encodeURIComponent(query)}${hasProximity ? `&viewbox=${lon - 0.6},${lat + 0.6},${lon + 0.6},${lat - 0.6}` : ""}`,
    `https://photon.komoot.io/api/?limit=8&q=${encodeURIComponent(query)}${hasProximity ? `&lat=${lat}&lon=${lon}` : ""}`
  ];

  let providerResponded = false;
  for (const url of providers) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "FLOCKYOU/1.0 (navigation app)", Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) continue;
      providerResponded = true;
      const data = await response.json();
      const rows = Array.isArray(data) ? data : data.results ?? data.features ?? [];
      const normalized = rows.map((row: any) => {
        const coordinates = row.geometry?.coordinates;
        const properties = row.properties ?? {};
        return {
          label: row.display_name ?? row.label ?? row.name ?? properties.label ??
            [properties.name, properties.city, properties.state].filter(Boolean).join(", ") ?? query,
          lon: Number(row.lon ?? row.lng ?? row.longitude ?? coordinates?.[0]),
          lat: Number(row.lat ?? row.latitude ?? coordinates?.[1])
        };
      }).filter((row: any) => Number.isFinite(row.lon) && Number.isFinite(row.lat));
      if (normalized.length) return NextResponse.json(normalized);
    } catch {
      // Try the next provider.
    }
  }

  return NextResponse.json(
    { error: `Could not find "${query}"` },
    { status: providerResponded ? 404 : 502 }
  );
}
