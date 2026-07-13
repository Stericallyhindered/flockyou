import { NextRequest, NextResponse } from "next/server";

const ORS_DIRECTIONS_URL = "https://api.openrouteservice.org/v2/directions/driving-car/geojson";

export async function POST(request: NextRequest) {
  const apiKey = request.headers.get("x-ors-key")?.trim() || process.env.OPENROUTESERVICE_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json({ ok: false, status: 401, error: "OpenRouteService API key is missing." });
  }

  try {
    const body = await request.json();
    const response = await fetch(ORS_DIRECTIONS_URL, {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(20000)
    });

    const text = await response.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (!response.ok) {
      const providerMessage = typeof data === "object" && data !== null && "error" in data
        ? JSON.stringify((data as { error: unknown }).error)
        : text;
      return NextResponse.json({
        ok: false,
        status: response.status,
        error: providerMessage || `OpenRouteService returned ${response.status}.`
      });
    }

    return NextResponse.json({ ok: true, status: response.status, data });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      status: 502,
      error: error instanceof Error ? error.message : "Directions request failed."
    });
  }
}
