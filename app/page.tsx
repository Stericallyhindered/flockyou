"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type * as Leaflet from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  avoidanceGeometry,
  cameraZone,
  camerasNearRouteBounds,
  createDetourWindow,
  distanceToRoute,
  findCameraExposures,
  firstExposureCluster,
  routeLengthMeters,
  routeSignature,
  spliceDetour,
  type LngLat,
  type RouteLine,
  type RoutingCamera
} from "./lib/deflock-routing";
import { RouteTracker, type TrackedPosition } from "./lib/navigation-core";

type PlaceResult = { label: string; point: LngLat };
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type DirectionsResponse = {
  ok: boolean;
  status: number;
  data?: any;
  error?: string;
};

type CameraPoint = RoutingCamera & {
  name: string;
  source: string;
  verified?: string;
  confidence: "verified" | "community" | "unknown";
};

type RouteStep = {
  instruction: string;
  distance: number;
  duration: number;
  wayPoint: number;
};

type LineString = RouteLine;

type RouteState = {
  geometry: LineString;
  distance: number;
  duration: number;
  steps: RouteStep[];
  label: string;
  cameraHits: number;
  detours: LineString[];
};

type CameraReport = {
  id: string;
  cameraId: string;
  cameraName: string;
  reason: "missing" | "moved" | "direction" | "other";
  note: string;
  createdAt: number;
  position: LngLat;
};

type RouteHistoryEntry = {
  id: string;
  destination: string;
  startedAt: number;
  endedAt: number;
  distance: number;
  duration: number;
  deflocked: boolean;
  avoidedCameras: number;
};

const defaultCenter: LngLat = [0, 20];

function metersToLabel(meters: number) {
  if (!Number.isFinite(meters)) return "0 ft";
  if (meters < 1609.34) return `${Math.round(meters * 3.28084)} ft`;
  return `${(meters / 1609.34).toFixed(1)} mi`;
}

function secondsToLabel(seconds: number) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours} hr ${rest} min`;
}

function looksLikeApiCredential(value: string) {
  const text = value.trim();
  return /^eyJ[A-Za-z0-9_-]{30,}={0,2}$/.test(text) ||
    (text.length >= 60 && !/\s/.test(text) && /^[A-Za-z0-9_+/=-]+$/.test(text));
}

function directionsError(result: DirectionsResponse) {
  if (result.status === 401 || result.status === 403) return "OpenRouteService rejected the API key. Check it in System.";
  if (result.status === 404) return "OpenRouteService could not connect those points with a drivable route.";
  if (result.status === 429) return "OpenRouteService rate limit reached. Wait a moment or check the key quota.";
  return result.error || `OpenRouteService request failed (${result.status}).`;
}

function sampledRouteCoordinates(route: LineString, maximum = 300) {
  const coordinates = route.coordinates;
  const stride = Math.max(1, Math.ceil(coordinates.length / maximum));
  const sampled = coordinates.filter((_, index) => index % stride === 0);
  const last = coordinates[coordinates.length - 1];
  if (last && sampled[sampled.length - 1] !== last) sampled.push(last);
  return sampled;
}

function arrivalTimeLabel(seconds: number) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
    .format(new Date(Date.now() + Math.max(0, seconds) * 1000));
}

function maneuverSymbol(instruction?: string) {
  const text = instruction?.toLowerCase() ?? "";
  if (text.includes("u-turn") || text.includes("uturn")) return "↶";
  if (text.includes("left")) return "↰";
  if (text.includes("right")) return "↱";
  if (text.includes("arrive") || text.includes("destination")) return "◆";
  return "↑";
}

function pointAhead(position: LngLat, heading: number, meters: number): LngLat {
  const radians = heading * Math.PI / 180;
  const latitudeScale = 111320;
  const longitudeScale = Math.max(1, latitudeScale * Math.cos(position[1] * Math.PI / 180));
  return [
    position[0] + Math.sin(radians) * meters / longitudeScale,
    position[1] + Math.cos(radians) * meters / latitudeScale
  ];
}

function safeManeuverSymbol(instruction?: string) {
  const text = instruction?.toLowerCase() ?? "";
  if (text.includes("u-turn") || text.includes("uturn")) return "\u21B6";
  if (text.includes("left")) return "\u21B0";
  if (text.includes("right")) return "\u21B1";
  if (text.includes("arrive") || text.includes("destination")) return "\u25C6";
  return "\u2191";
}

function cameraFreshness(camera: CameraPoint) {
  if (!camera.verified) return { label: "UNVERIFIED", stale: true };
  const timestamp = Date.parse(camera.verified);
  if (!Number.isFinite(timestamp)) return { label: camera.confidence.toUpperCase(), stale: camera.confidence !== "verified" };
  const days = Math.max(0, Math.floor((Date.now() - timestamp) / 86400000));
  if (days < 45) return { label: `${days}D FRESH`, stale: false };
  if (days < 180) return { label: `${days}D OLD`, stale: false };
  return { label: `${days}D STALE`, stale: true };
}

function haversineMeters(a: LngLat, b: LngLat) {
  const radius = 6371000;
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(h));
}

function bearingBetween(a: LngLat, b: LngLat) {
  const toRad = (value: number) => value * Math.PI / 180;
  const toDeg = (value: number) => value * 180 / Math.PI;
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const deltaLon = toRad(b[0] - a[0]);
  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function closestRouteDistance(camera: LngLat, line?: LineString) {
  return distanceToRoute(camera, line);
}

function readBearing(props: Record<string, unknown>) {
  const raw =
    props.bearing ??
    props.direction ??
    props.directions ??
    props.directionCardinal ??
    props.camera_direction ??
    props["camera:direction"] ??
    props["surveillance:direction"];
  if (raw === undefined || raw === null || raw === "") return { bearing: 0, known: false };
  const bearing = Number(raw);
  if (Number.isFinite(bearing)) return { bearing, known: true };
  const text = String(raw).toUpperCase();
  const cardinals: Record<string, number> = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };
  return text in cardinals ? { bearing: cardinals[text], known: true } : { bearing: 0, known: false };
}

function normalizeCameraFeature(feature: any, index: number): CameraPoint | null {
  const coords = feature?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const props = feature.properties ?? {};
  const lon = Number(coords[0]);
  const lat = Number(coords[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;

  const direction = readBearing(props);
  return {
    id: String(props.id ?? props.osmId ?? props.osm_id ?? props["@id"] ?? `camera-${index}`),
    name: String(props.name ?? props.operator ?? props.brand ?? "Public camera"),
    position: [lon, lat],
    bearing: direction.bearing,
    directionKnown: direction.known,
    source: String(props.operator ?? props.brand ?? props.source ?? "DeFlock / OSM"),
    verified: props.osmTimestamp ?? props.timestamp ?? props.updated_at ?? props.check_date,
    confidence: props.osmTimestamp || props.check_date || props.updated_at ? "verified" : "community"
  };
}

export default function Home() {
  const mapNode = useRef<HTMLDivElement | null>(null);
  const leafletRef = useRef<typeof import("leaflet") | null>(null);
  const mapRef = useRef<Leaflet.Map | null>(null);
  const userMarkerRef = useRef<Leaflet.CircleMarker | null>(null);
  const destinationMarkerRef = useRef<Leaflet.CircleMarker | null>(null);
  const searchMarkerRef = useRef<Leaflet.CircleMarker | null>(null);
  const cameraLayerRef = useRef<Leaflet.LayerGroup | null>(null);
  const cameraConeLayerRef = useRef<Leaflet.LayerGroup | null>(null);
  const tileLayerRef = useRef<Leaflet.TileLayer | null>(null);
  const cameraLoadStartedRef = useRef(false);
  const cameraViewportTimerRef = useRef<number | null>(null);
  const lastCameraBoundsRef = useRef("");
  const spokenStepRef = useRef(-1);
  const spokenEventsRef = useRef(new Set<string>());
  const navigationSessionRef = useRef<{ startedAt: number; destination: string } | null>(null);
  const lastRerouteRef = useRef(0);
  const nextSafetyCheckRef = useRef(0);
  const offRouteReadingsRef = useRef(0);
  const lastSafetyCameraRef = useRef("");
  const routingInFlightRef = useRef(false);
  const navigationActiveRef = useRef(false);
  const routeTrackerRef = useRef(new RouteTracker());
  const routeLayerRef = useRef<Leaflet.Polyline | null>(null);
  const detourLayerRef = useRef<Leaflet.LayerGroup | null>(null);
  const camerasRef = useRef<CameraPoint[]>([]);
  const routeRef = useRef<RouteState | null>(null);
  const cameraScopeRef = useRef<"route" | "visible">("visible");
  const lowDataModeRef = useRef(false);
  const persistenceReadyRef = useRef(false);

  const [gpsStatus, setGpsStatus] = useState("Waiting for permission");
  const [mapStatus, setMapStatus] = useState("Loading map");
  const [position, setPosition] = useState<LngLat | null>(null);
  const [rawPosition, setRawPosition] = useState<LngLat | null>(null);
  const [trackedPosition, setTrackedPosition] = useState<TrackedPosition | null>(null);
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [followGps, setFollowGps] = useState(true);
  const [fromMode, setFromMode] = useState<"gps" | "address">("gps");
  const [origin, setOrigin] = useState("");
  const [destination, setDestination] = useState("");
  const [mapSearch, setMapSearch] = useState("");
  const [selectedPlace, setSelectedPlace] = useState<{ label: string; point: LngLat } | null>(null);
  const [searchResults, setSearchResults] = useState<PlaceResult[]>([]);
  const [destinationResults, setDestinationResults] = useState<PlaceResult[]>([]);
  const [searchStatus, setSearchStatus] = useState("");
  const [route, setRoute] = useState<RouteState | null>(null);
  const [alternates, setAlternates] = useState<RouteState[]>([]);
  const [routeStatus, setRouteStatus] = useState("Enter a To address, then plan a route.");
  const [cameras, setCameras] = useState<CameraPoint[]>([]);
  const [cameraLoadState, setCameraLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [cameraDatasetTotal, setCameraDatasetTotal] = useState(0);
  const [orsKey, setOrsKey] = useState(process.env.NEXT_PUBLIC_OPENROUTESERVICE_API_KEY ?? "");
  const [panel, setPanel] = useState<"route" | "cameras" | "settings">("route");
  const [panelExpanded, setPanelExpanded] = useState(false);
  const [mapTheme, setMapTheme] = useState<"night" | "day">("day");
  const [cameraScope, setCameraScope] = useState<"route" | "visible">("visible");
  const [navigationActive, setNavigationActive] = useState(false);
  const [activeStepIndex, setActiveStepIndex] = useState(0);
  const [distanceToTurn, setDistanceToTurn] = useState<number | null>(null);
  const [deflockActive, setDeflockActive] = useState(false);
  const [heading, setHeading] = useState(0);
  const [perspective, setPerspective] = useState<"north" | "overview">("north");
  const [voiceMode, setVoiceMode] = useState<"full" | "alerts" | "muted">("full");
  const [hudMode, setHudMode] = useState<"full" | "compact" | "hidden">("full");
  const [lowDataMode, setLowDataMode] = useState(false);
  const [cameraReports, setCameraReports] = useState<CameraReport[]>([]);
  const [reportCamera, setReportCamera] = useState<CameraPoint | null>(null);
  const [reportReason, setReportReason] = useState<CameraReport["reason"]>("moved");
  const [reportNote, setReportNote] = useState("");
  const [routeHistory, setRouteHistory] = useState<RouteHistoryEntry[]>([]);
  const [avoidedCameraCount, setAvoidedCameraCount] = useState(0);
  const [fallbackRoute, setFallbackRoute] = useState<RouteState | null>(null);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [appInstalled, setAppInstalled] = useState(false);

  const routeExposures = useMemo(
    () => route ? findCameraExposures(cameras, route.geometry) : [],
    [cameras, route]
  );

  const nextCameraThreat = useMemo(() => {
    const progress = trackedPosition?.routeProgress ?? 0;
    return routeExposures.find((exposure) => exposure.routeLocation >= progress - 10) ?? null;
  }, [routeExposures, trackedPosition?.routeProgress]);

  const nearbyCameras = useMemo(() => {
    const candidates = route
      ? camerasNearRouteBounds(cameras, route.geometry)
      : position
        ? cameras.filter(({ position: [lon, lat] }) => Math.abs(lon - position[0]) < 0.12 && Math.abs(lat - position[1]) < 0.12)
        : cameras.slice(0, 250);
    return candidates
      .map((camera) => ({
        ...camera,
        routeDistance: closestRouteDistance(camera.position, route?.geometry),
        userDistance: position ? haversineMeters(position, camera.position) : Number.POSITIVE_INFINITY
      }))
      .sort((a, b) => Math.min(a.routeDistance, a.userDistance) - Math.min(b.routeDistance, b.userDistance))
      .slice(0, 10);
  }, [cameras, position, route]);

  function setCameraSourceData() {
    const L = leafletRef.current;
    const map = mapRef.current;
    const layer = cameraLayerRef.current;
    const coneLayer = cameraConeLayerRef.current;
    if (!L || !map || !layer || !coneLayer) return;
    const bounds = map.getBounds();
    const center = map.getCenter();
    const centerPoint: LngLat = [center.lng, center.lat];
    const activeRoute = routeRef.current;
    const scopedCameras = cameraScopeRef.current === "route"
      ? activeRoute ? camerasNearRouteBounds(camerasRef.current, activeRoute.geometry) : []
      : camerasRef.current;
    const visible = scopedCameras
      .filter((camera) => bounds.contains([camera.position[1], camera.position[0]]))
      .sort((a, b) => haversineMeters(a.position, centerPoint) - haversineMeters(b.position, centerPoint))
      .slice(0, lowDataModeRef.current ? 250 : 1200);

    layer.clearLayers();
    coneLayer.clearLayers();
    visible.forEach((camera) => {
      const icon = L.divIcon({
        className: "camera-marker-wrap",
        html: `<span class="camera-marker" style="--bearing:${camera.bearing}deg"><i></i></span>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14]
      });
      L.marker([camera.position[1], camera.position[0]], { icon, pane: "cameraPane" })
        .bindPopup(`<strong>${camera.name}</strong><br>Facing ${Math.round(camera.bearing)} deg<br>${camera.source}<br>${camera.verified ?? "Freshness unknown"}`)
        .addTo(layer);
    });
    if (!lowDataModeRef.current) {
      visible.slice(0, 180).forEach((camera) => {
        const zone = cameraZone(camera);
        if (!zone || zone.geometry.type !== "Polygon") return;
        const ring = zone.geometry.coordinates[0].map(([lon, lat]) => [lat, lon] as Leaflet.LatLngTuple);
        L.polygon(ring, {
          className: "camera-cone",
          color: camera.directionKnown ? "#38d5ee" : "#ffbf47",
          fillColor: camera.directionKnown ? "#38d5ee" : "#ffbf47",
          fillOpacity: 0.1,
          opacity: 0.45,
          weight: 1,
          interactive: false,
          pane: "cameraConePane"
        }).addTo(coneLayer);
      });
    }
  }

  useEffect(() => {
    if (!mapNode.current || mapRef.current) return;

    let disposed = false;
    let mapContainer: HTMLElement | null = null;
    const suspendFollow = () => setFollowGps(false);
    void import("leaflet").then((module) => {
    if (disposed || !mapNode.current) return;
    const L = module.default;
    leafletRef.current = L;
    const map = L.map(mapNode.current, {
      zoomControl: false,
      zoomAnimation: true,
      fadeAnimation: true,
      markerZoomAnimation: true,
      zoomSnap: 0.25,
      wheelPxPerZoomLevel: 90,
      inertia: true,
      inertiaDeceleration: 2600,
      easeLinearity: 0.2,
      minZoom: 2,
      maxZoom: 20,
      maxBounds: [[-85, -180], [85, 180]],
      maxBoundsViscosity: 0.85,
      worldCopyJump: true,
      bounceAtZoomLimits: true
    }).setView([defaultCenter[1], defaultCenter[0]], 2);
    mapContainer = map.getContainer();
    mapContainer.addEventListener("pointerdown", suspendFollow, { passive: true });
    mapContainer.addEventListener("wheel", suspendFollow, { passive: true });
    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.control.scale({ position: "bottomleft", imperial: true, metric: false }).addTo(map);
    map.createPane("cameraPane");
    map.createPane("cameraConePane");
    const cameraPane = map.getPane("cameraPane");
    if (cameraPane) cameraPane.style.zIndex = "650";
    const cameraConePane = map.getPane("cameraConePane");
    if (cameraConePane) cameraConePane.style.zIndex = "640";
    const tiles = L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
      maxZoom: 19,
      crossOrigin: true,
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO"
    });
    tiles.on("load", () => setMapStatus("Map ready"));
    tiles.on("tileerror", () => setMapStatus("Street tiles failed to load"));
    tiles.addTo(map);
    tileLayerRef.current = tiles;
    cameraLayerRef.current = L.layerGroup().addTo(map);
    cameraConeLayerRef.current = L.layerGroup().addTo(map);
    const handleMapSettled = () => {
      setCameraSourceData();
      scheduleVisibleCameraLoad();
    };
    map.whenReady(handleMapSettled);
    map.on("moveend zoomend", handleMapSettled);
    mapRef.current = map;
    });
    return () => {
      disposed = true;
      mapContainer?.removeEventListener("pointerdown", suspendFollow);
      mapContainer?.removeEventListener("wheel", suspendFollow);
      if (cameraViewportTimerRef.current !== null) window.clearTimeout(cameraViewportTimerRef.current);
      mapRef.current?.stop();
      mapRef.current?.off();
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const standalone = window.matchMedia("(display-mode: standalone)").matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
    setAppInstalled(standalone);
    const capturePrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const markInstalled = () => {
      setAppInstalled(true);
      setInstallPrompt(null);
    };
    window.addEventListener("beforeinstallprompt", capturePrompt);
    window.addEventListener("appinstalled", markInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", capturePrompt);
      window.removeEventListener("appinstalled", markInstalled);
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const L = leafletRef.current;
    if (!map || !L) return;
    tileLayerRef.current?.remove();
    const night = mapTheme === "night";
    const tiles = L.tileLayer(
      night
        ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        : "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
      {
        maxZoom: 20,
        crossOrigin: true,
        attribution: "&copy; OpenStreetMap contributors &copy; CARTO"
      }
    );
    tiles.on("load", () => setMapStatus(`${night ? "Night" : "Day"} map ready`));
    tiles.on("tileerror", () => setMapStatus("Street tiles failed to load"));
    tiles.addTo(map);
    tiles.bringToBack();
    tileLayerRef.current = tiles;
  }, [mapTheme, mapStatus === "Map ready"]);

  useEffect(() => {
    camerasRef.current = cameras;
    setCameraSourceData();
  }, [cameras]);

  useEffect(() => {
    routeRef.current = route;
    routeTrackerRef.current.setRoute(route?.geometry ?? null, route?.steps ?? []);
    setCameraSourceData();
  }, [route]);

  useEffect(() => {
    cameraScopeRef.current = cameraScope;
    setCameraSourceData();
  }, [cameraScope]);

  useEffect(() => {
    navigationActiveRef.current = navigationActive;
  }, [navigationActive]);

  useEffect(() => {
    try {
      setRouteHistory(JSON.parse(localStorage.getItem("flockyou-route-history") ?? "[]"));
      setCameraReports(JSON.parse(localStorage.getItem("flockyou-camera-reports") ?? "[]"));
      setVoiceMode((localStorage.getItem("flockyou-voice-mode") as "full" | "alerts" | "muted") ?? "full");
      setLowDataMode(localStorage.getItem("flockyou-low-data") === "true");
    } catch {
      setRouteStatus("Local history could not be restored.");
    }
    const readyTimer = window.setTimeout(() => { persistenceReadyRef.current = true; }, 0);
    if ("serviceWorker" in navigator) {
      if (process.env.NODE_ENV === "production") {
        void navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" })
          .then((registration) => registration.update());
      } else {
        void navigator.serviceWorker.getRegistrations().then((registrations) => {
          registrations.forEach((registration) => void registration.unregister());
        });
      }
    }
    return () => window.clearTimeout(readyTimer);
  }, []);

  useEffect(() => {
    lowDataModeRef.current = lowDataMode;
    setCameraSourceData();
    if (persistenceReadyRef.current) localStorage.setItem("flockyou-low-data", String(lowDataMode));
  }, [lowDataMode]);

  useEffect(() => {
    if (persistenceReadyRef.current) localStorage.setItem("flockyou-voice-mode", voiceMode);
  }, [voiceMode]);

  useEffect(() => {
    if (persistenceReadyRef.current) localStorage.setItem("flockyou-camera-reports", JSON.stringify(cameraReports));
  }, [cameraReports]);

  useEffect(() => {
    if (persistenceReadyRef.current) localStorage.setItem("flockyou-route-history", JSON.stringify(routeHistory.slice(0, 50)));
  }, [routeHistory]);

  useEffect(() => {
    if (!navigator.geolocation) {
      setGpsStatus("Geolocation is not available in this browser.");
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (reading) => {
        const tracked = routeTrackerRef.current.update({
          position: [reading.coords.longitude, reading.coords.latitude],
          accuracy: reading.coords.accuracy,
          heading: reading.coords.heading,
          speed: reading.coords.speed,
          timestamp: reading.timestamp
        }, navigationActiveRef.current);
        setRawPosition(tracked.rawPosition);
        setTrackedPosition(tracked);
        setPosition(tracked.displayPosition);
        setHeading(tracked.heading);
        setAccuracy(reading.coords.accuracy);
        setGpsStatus(tracked.snapped ? "Locked to route" : "Live GPS active");
      },
      (error) => setGpsStatus(error.message),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const L = leafletRef.current;
    if (!L || !map || !position) return;

    if (!userMarkerRef.current) {
      const node = document.createElement("div");
      node.className = "user-marker";
      userMarkerRef.current = L.circleMarker([position[1], position[0]], { radius: 9, color: "#fff", weight: 3, fillColor: "#2f80ed", fillOpacity: 1 }).addTo(map);
    } else {
      userMarkerRef.current.setLatLng([position[1], position[0]]);
    }

    if (followGps && perspective !== "overview") {
      const speed = trackedPosition?.speed ?? 0;
      const targetZoom = !navigationActive ? 15
        : speed > 25 ? 15.75
          : speed > 14 ? 16.25
            : speed > 6 ? 16.75
              : 17.25;
      const lookAheadMeters = navigationActive ? Math.max(30, Math.min(130, speed * 5)) : 0;
      const center = lookAheadMeters > 0 ? pointAhead(position, heading, lookAheadMeters) : position;
      const target = L.latLng(center[1], center[0]);
      const centerDistance = map.distance(map.getCenter(), target);
      const zoomDifference = Math.abs(map.getZoom() - targetZoom);
      if (zoomDifference > 0.45) {
        map.flyTo(target, targetZoom, { duration: 0.65, easeLinearity: 0.2 });
      } else if (centerDistance > (navigationActive ? 3 : 12)) {
        map.panTo(target, { animate: true, duration: 0.55, easeLinearity: 0.2 });
      }
    }
  }, [position, trackedPosition, heading, followGps, route, navigationActive, perspective]);

  useEffect(() => {
    if (mapRef.current) {
      const map = mapRef.current;
      map.stop();
      window.requestAnimationFrame(() => map.invalidateSize({ animate: false, pan: false }));
    }
    if (perspective === "overview" && route && leafletRef.current) {
      const bounds = leafletRef.current.latLngBounds(route.geometry.coordinates.map(([lon, lat]) => [lat, lon] as Leaflet.LatLngTuple));
      mapRef.current?.fitBounds(bounds, { padding: [110, 110] });
    }
  }, [perspective, route]);

  useEffect(() => {
    if (!navigationActive || !trackedPosition || !route?.geometry.coordinates.length) return;
    const nearestIndex = trackedPosition.routeIndex;
    const stepIndex = trackedPosition.activeStepIndex;
    setActiveStepIndex(stepIndex);
    setDistanceToTurn(trackedPosition.distanceToManeuver);

    const instruction = route.steps[stepIndex]?.instruction;
    const turnDistance = trackedPosition.distanceToManeuver;
    if (instruction && turnDistance !== null && voiceMode === "full") {
      const fast = trackedPosition.speed > 18;
      const prepareDistance = fast ? 900 : 450;
      const approachDistance = fast ? 320 : 160;
      const nowDistance = fast ? 90 : 45;
      const stage = turnDistance <= nowDistance ? "now" : turnDistance <= approachDistance ? "approach" : turnDistance <= prepareDistance ? "prepare" : null;
      if (stage) {
        const prefix = stage === "now" ? "Now, " : stage === "approach" ? "In a short distance, " : "Ahead, ";
        speakOnce(`turn:${routeSignature(route.geometry)}:${stepIndex}:${stage}`, `${prefix}${instruction}`, "turn");
      }
    }

    offRouteReadingsRef.current = trackedPosition.offRoute ? offRouteReadingsRef.current + 1 : 0;
    if (offRouteReadingsRef.current >= 3 && Date.now() - lastRerouteRef.current > 30000) {
      lastRerouteRef.current = Date.now();
      offRouteReadingsRef.current = 0;
      setRouteStatus("Off route. Finding a new route...");
      void planRoute(undefined, deflockActive, rawPosition ?? trackedPosition.rawPosition);
      return;
    }

    if (deflockActive && Date.now() > nextSafetyCheckRef.current) {
      nextSafetyCheckRef.current = Date.now() + 8000;
      const roadAhead: LineString = { type: "LineString", coordinates: route.geometry.coordinates.slice(nearestIndex) };
      const upcomingCamera = findCameraExposures(camerasRef.current, roadAhead)
        .find((exposure) => haversineMeters(trackedPosition.displayPosition, exposure.camera.position) < 5000)?.camera;
      const safetyKey = upcomingCamera ? `${upcomingCamera.id}:${routeSignature(route.geometry)}` : "";
      if (upcomingCamera && safetyKey !== lastSafetyCameraRef.current && Date.now() - lastRerouteRef.current > 60000) {
        lastRerouteRef.current = Date.now();
        lastSafetyCameraRef.current = safetyKey;
        setRouteStatus("Camera ahead. Finding an earlier exit...");
        void planRoute(undefined, true, rawPosition ?? trackedPosition.rawPosition);
      }
    }
  }, [trackedPosition, rawPosition, navigationActive, route, deflockActive, voiceMode]);

  useEffect(() => {
    if (!navigationActive || !nextCameraThreat || voiceMode === "muted") return;
    const distance = nextCameraThreat.routeLocation - (trackedPosition?.routeProgress ?? 0);
    const warningDistance = (trackedPosition?.speed ?? 0) > 18 ? 1000 : 500;
    if (distance >= 0 && distance <= warningDistance) {
      speakOnce(`camera:${nextCameraThreat.camera.id}`, `Camera exposure ahead in ${metersToLabel(distance)}.`, "alert");
    }
  }, [navigationActive, nextCameraThreat, trackedPosition?.routeProgress, trackedPosition?.speed, voiceMode]);

  useEffect(() => {
    const map = mapRef.current;
    const L = leafletRef.current;
    if (!L || !map) return;
    routeLayerRef.current?.remove();
    detourLayerRef.current?.remove();
    routeLayerRef.current = route
      ? L.polyline(route.geometry.coordinates.map(([lon, lat]) => [lat, lon]), { color: "#1a73e8", weight: 7, opacity: 0.92 }).addTo(map)
      : null;
    detourLayerRef.current = route?.detours.length ? L.layerGroup(
      route.detours.map((detour) => L.polyline(
        detour.coordinates.map(([lon, lat]) => [lat, lon]),
        { color: "#8b5cf6", weight: 9, opacity: 0.96 }
      ))
    ).addTo(map) : null;
  }, [route]);

  async function geocodeResults(text: string): Promise<PlaceResult[]> {
    if (looksLikeApiCredential(text)) {
      throw new Error("That looks like an API key, not an address. Add it under System, then search for a destination.");
    }
    const proximity = position ? `&lat=${position[1]}&lon=${position[0]}` : "";
    const response = await fetch(`/api/geocode?q=${encodeURIComponent(text)}${proximity}`, {
      headers: orsKey.trim() ? { "x-ors-key": orsKey.trim() } : undefined
    });
    if (!response.ok) throw new Error("Geocoding failed");
    const results = await response.json();
    if (!results?.[0]) throw new Error(`Could not find "${text}"`);
    return results.map((result: any) => ({
      label: String(result.label || text),
      point: [Number(result.lon), Number(result.lat)] as LngLat
    }));
  }

  async function geocode(text: string): Promise<LngLat> {
    return (await geocodeResults(text))[0].point;
  }

  useEffect(() => {
    const text = destination.trim();
    const alreadySelected = selectedPlace && text.toLocaleLowerCase() === selectedPlace.label.trim().toLocaleLowerCase();
    if (text.length < 3 || alreadySelected) {
      setDestinationResults([]);
      return;
    }
    const timer = window.setTimeout(() => {
      void geocodeResults(text).then(setDestinationResults).catch(() => setDestinationResults([]));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [destination, selectedPlace]);

  async function searchMap(event: FormEvent) {
    event.preventDefault();
    if (!mapSearch.trim()) return;
    try {
      setSearchStatus("Searching...");
      const results = await geocodeResults(mapSearch.trim());
      setSearchResults(results);
      setSearchStatus("");
    } catch (error) {
      setSearchResults([]);
      setSearchStatus(error instanceof Error ? error.message : "Place search failed.");
    }
  }

  function selectSearchResult(place: PlaceResult) {
    const L = leafletRef.current;
    if (!L) return;
    setSelectedPlace(place);
    setDestination(place.label);
    setMapSearch(place.label);
    setSearchResults([]);
    setSearchStatus("");
    setPanel("route");
    setPanelExpanded(true);
    setRouteStatus(`Choose where to start, then route to ${place.label}.`);
    if (!searchMarkerRef.current && mapRef.current) {
      searchMarkerRef.current = L.circleMarker([place.point[1], place.point[0]], { radius: 9, color: "#fff", weight: 3, fillColor: "#111827", fillOpacity: 1 }).addTo(mapRef.current);
    } else {
      searchMarkerRef.current?.setLatLng([place.point[1], place.point[0]]);
    }
    mapRef.current?.flyTo([place.point[1], place.point[0]], 16, { duration: 0.9 });
  }

  function selectDestinationResult(place: PlaceResult) {
    setSelectedPlace(place);
    setDestination(place.label);
    setMapSearch(place.label);
    setDestinationResults([]);
    selectSearchResult(place);
  }

  function routeToSelectedPlace() {
    if (!selectedPlace) return;
    setDestination(selectedPlace.label);
    setPanel("route");
    setPanelExpanded(true);
    setRouteStatus(`Ready to route to ${selectedPlace.label}.`);
  }

  function countCameraHits(geometry: LineString) {
    return findCameraExposures(camerasRef.current, geometry).length;
  }

  function routeFromFeature(feature: any, index = 0): RouteState {
    const summary = feature?.properties?.summary;
    const segments = feature?.properties?.segments ?? [];
    const steps = segments.flatMap((segment: any) => segment.steps ?? []);
    return {
      label: index === 0 ? "Recommended" : `Alternate ${index}`,
      geometry: feature.geometry,
      distance: summary?.distance ?? 0,
      duration: summary?.duration ?? 0,
      cameraHits: countCameraHits(feature.geometry),
      detours: feature.properties?.deflockDetours ?? [],
      steps: steps.map((step: any) => ({
        instruction: step.instruction,
        distance: step.distance,
        duration: step.duration,
        wayPoint: Number(step.way_points?.[1] ?? step.way_points?.[0] ?? 0)
      }))
    };
  }

  async function getOriginPoint() {
    if (fromMode === "gps") {
      if (!position) throw new Error("Allow location permission, or switch From to an address.");
      return position;
    }
    if (!origin.trim()) throw new Error("Enter a From address.");
    return geocode(origin);
  }

  async function planRoute(event?: FormEvent, useAlternates = false, startOverride?: LngLat) {
    event?.preventDefault();
    if (routingInFlightRef.current) {
      setRouteStatus("A route update is already in progress.");
      return;
    }
    if (!destination.trim()) {
      setRouteStatus("Enter a To address.");
      return;
    }
    routingInFlightRef.current = true;
    try {
      setRouteStatus("Finding From and To...");
      const start = startOverride ?? await getOriginPoint();
      const selectedDestinationMatches = selectedPlace &&
        destination.trim().toLocaleLowerCase() === selectedPlace.label.trim().toLocaleLowerCase();
      let end: LngLat;
      if (selectedDestinationMatches) {
        end = selectedPlace.point;
      } else {
        const matches = await geocodeResults(destination);
        if (matches.length > 1) {
          setDestinationResults(matches);
          setRouteStatus("Choose the correct destination from the address results.");
          return;
        }
        selectDestinationResult(matches[0]);
        end = matches[0].point;
      }
      const L = leafletRef.current;
      if (!L) throw new Error("Map is still loading.");

      if (!destinationMarkerRef.current && mapRef.current) {
        destinationMarkerRef.current = L.circleMarker([end[1], end[0]], { radius: 9, color: "#fff", weight: 3, fillColor: "#101828", fillOpacity: 1 }).addTo(mapRef.current);
      } else {
        destinationMarkerRef.current?.setLatLng([end[1], end[0]]);
      }

      if (!orsKey.trim()) {
        setRoute(null);
        setAlternates([]);
        setRouteStatus("Destination found. Add an OpenRouteService API key for driving directions.");
        mapRef.current?.fitBounds([[start[1], start[0]], [end[1], end[0]]], { padding: [100, 100] });
        return;
      }

      setRouteStatus(useAlternates ? "Checking cameras along your route..." : "Requesting driving route...");
      const routeRequest = async (body: Record<string, unknown>): Promise<DirectionsResponse> => {
        const response = await fetch("/api/directions", {
        method: "POST",
        headers: {
          "x-ors-key": orsKey.trim(),
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
        });
        if (!response.ok) throw new Error("The local directions service is unavailable.");
        return response.json();
      };
      const baseBody: Record<string, unknown> = {
          coordinates: [start, end],
          instructions: true,
          preference: "recommended",
          units: "m"
      };
      let response = await routeRequest(baseBody);
      if (!response.ok) throw new Error(directionsError(response));
      let data = response.data;
      let deflockSucceeded = false;
      if (useAlternates && data.features?.[0]?.geometry) {
        setRouteStatus("Indexing every camera near the complete route...");
        await loadCamerasForRoute(data.features[0].geometry, true);
      }
      const requestedStandardRoute = data.features?.[0] ? routeFromFeature(data.features[0]) : null;

      if (useAlternates) {
        let workingFeature = data.features?.[0];
        const originalFeature = workingFeature;
        const detours: LineString[] = [];
        let failureReason = "";
        const seenFullRoutes = new Set<string>(workingFeature ? [routeSignature(workingFeature.geometry)] : []);

        for (let clusterNumber = 0; clusterNumber < 12 && workingFeature; clusterNumber += 1) {
          const currentRoute = workingFeature.geometry as LineString;
          const currentLength = routeLengthMeters(currentRoute);
          const exposures = findCameraExposures(camerasRef.current, currentRoute)
            .filter((exposure) => exposure.routeLocation > 100 && exposure.routeLocation < currentLength - 100);
          if (!exposures.length) {
            deflockSucceeded = true;
            break;
          }

          const cluster = firstExposureCluster(exposures);
          let selectedWindow: ReturnType<typeof createDetourWindow> | null = null;
          let selectedFeature: any = null;
          const attemptedCandidates = new Set<string>();

          for (const searchDistance of [800, 1600, 3200, 6400]) {
            const window = createDetourWindow(currentRoute, cluster, searchDistance);
            let avoidCameras = cluster.map((exposure) => exposure.camera as CameraPoint);
            setRouteStatus(`Finding the nearest clean streets around camera group ${clusterNumber + 1}...`);

            for (let attempt = 0; attempt < 4; attempt += 1) {
              response = await routeRequest({
                ...baseBody,
                preference: "shortest",
                coordinates: [window.start, window.end],
                bearings: [[window.startBearing, 35], [window.endBearing, 35]],
                continue_straight: true,
                options: { avoid_polygons: avoidanceGeometry(avoidCameras) }
              });
              if (!response.ok) break;
              const candidateData = response.data;
              const candidateFeature = candidateData.features?.[0];
              const candidateRoute = candidateFeature?.geometry as LineString | undefined;
              if (!candidateRoute?.coordinates?.length) break;
              const candidateSteps = (candidateFeature.properties?.segments ?? []).flatMap((segment: any) => segment.steps ?? []);
              if (candidateSteps.some((step: any) => Number(step.type) === 9)) break;
              const candidateSignature = routeSignature(candidateRoute);
              if (attemptedCandidates.has(candidateSignature)) break;
              attemptedCandidates.add(candidateSignature);
              const originalSegmentDistance = routeLengthMeters(window.originalSegment);
              const candidateDistance = routeLengthMeters(candidateRoute);
              const maximumDetourDistance = Math.max(originalSegmentDistance * 3, originalSegmentDistance + searchDistance * 2);
              if (candidateDistance > maximumDetourDistance) break;
              const candidateExposures = findCameraExposures(camerasRef.current, candidateRoute);
              if (!candidateExposures.length) {
                selectedWindow = window;
                selectedFeature = candidateFeature;
                break;
              }
              const knownIds = new Set(avoidCameras.map((camera) => camera.id));
              const newlyFound = candidateExposures
                .map((exposure) => exposure.camera as CameraPoint)
                .filter((camera) => !knownIds.has(camera.id));
              if (!newlyFound.length) break;
              avoidCameras = [...avoidCameras, ...newlyFound].slice(0, 50);
            }
            if (selectedFeature) break;
          }

          if (!selectedFeature || !selectedWindow) {
            failureReason = `No connected camera-free bypass exists around camera group ${clusterNumber + 1}.`;
            break;
          }

          const detourRoute = selectedFeature.geometry as LineString;
          const mergedRoute = spliceDetour(currentRoute, detourRoute, selectedWindow);
          const mergedSignature = routeSignature(mergedRoute);
          if (seenFullRoutes.has(mergedSignature)) {
            failureReason = "A repeated route was detected, so DeFlock stopped before entering a loop.";
            break;
          }
          seenFullRoutes.add(mergedSignature);
          const currentSteps = (workingFeature.properties?.segments ?? []).flatMap((segment: any) => segment.steps ?? []);
          const detourSteps = (selectedFeature.properties?.segments ?? []).flatMap((segment: any) => segment.steps ?? []);
          const indexDelta = mergedRoute.coordinates.length - currentRoute.coordinates.length;
          const mergedSteps = [
            ...currentSteps.filter((step: any) => Number(step.way_points?.[1]) <= selectedWindow!.startIndex),
            ...detourSteps.map((step: any) => ({
              ...step,
              way_points: (step.way_points ?? [0, 0]).map((index: number) => index + selectedWindow!.startIndex)
            })),
            ...currentSteps.filter((step: any) => Number(step.way_points?.[0]) >= selectedWindow!.endIndex).map((step: any) => ({
              ...step,
              way_points: (step.way_points ?? [0, 0]).map((index: number) => index + indexDelta)
            }))
          ];
          const currentSummary = workingFeature.properties?.summary ?? {};
          const detourSummary = selectedFeature.properties?.summary ?? {};
          const currentDistance = Number(currentSummary.distance ?? routeLengthMeters(currentRoute));
          const removedDistance = routeLengthMeters(selectedWindow.originalSegment);
          const currentDuration = Number(currentSummary.duration ?? 0);
          const removedDuration = currentDistance > 0 ? currentDuration * removedDistance / currentDistance : 0;
          detours.push(detourRoute);
          workingFeature = {
            ...workingFeature,
            geometry: mergedRoute,
            properties: {
              ...workingFeature.properties,
              summary: {
                distance: Math.max(0, currentDistance - removedDistance + Number(detourSummary.distance ?? 0)),
                duration: Math.max(0, currentDuration - removedDuration + Number(detourSummary.duration ?? 0))
              },
              segments: [{ steps: mergedSteps }],
              deflockDetours: [...detours]
            }
          };
        }

        if (deflockSucceeded && workingFeature) {
          data = { ...data, features: [workingFeature] };
        } else {
          data = { ...data, features: originalFeature ? [originalFeature] : [] };
          setRouteStatus(failureReason || "The route still contains unresolved camera exposure.");
        }
      }
      const routes: RouteState[] = (data.features ?? []).map((feature: any, index: number) => routeFromFeature(feature, index));
      if (!routes[0]) throw new Error("No route returned.");
      setRoute(routes[0]);
      setAlternates(routes.slice(1));
      setDeflockActive(useAlternates && deflockSucceeded);
      setFallbackRoute(useAlternates && deflockSucceeded ? requestedStandardRoute : null);
      setAvoidedCameraCount(useAlternates && deflockSucceeded && requestedStandardRoute
        ? Math.max(0, requestedStandardRoute.cameraHits - routes[0].cameraHits)
        : 0);
      setRouteStatus(useAlternates
        ? deflockSucceeded ? "DeFlocked route ready." : "No legal camera-free bypass was found. Showing the standard route."
        : "Route ready.");
      setPanelExpanded(false);

      const bounds = L.latLngBounds(routes[0].geometry.coordinates.map(([lon, lat]) => [lat, lon] as Leaflet.LatLngTuple));
      mapRef.current?.fitBounds(bounds, { padding: [110, 110] });
    } catch (error) {
      if (useAlternates) setCameraLoadState("error");
      setRouteStatus(error instanceof Error ? error.message : "Route failed.");
    } finally {
      routingInFlightRef.current = false;
    }
  }

  function chooseRoute(nextRoute: RouteState) {
    setRoute(nextRoute);
    setRouteStatus(`${nextRoute.label} selected.`);
  }

  function speakOnce(key: string, message: string, kind: "turn" | "alert") {
    if (voiceMode === "muted" || (kind === "turn" && voiceMode !== "full") || spokenEventsRef.current.has(key)) return;
    spokenEventsRef.current.add(key);
    const utterance = new SpeechSynthesisUtterance(message);
    utterance.rate = trackedPosition?.speed && trackedPosition.speed > 20 ? 1.08 : 1;
    window.speechSynthesis?.speak(utterance);
  }

  function finishNavigationSession() {
    const session = navigationSessionRef.current;
    if (!session || !route) return;
    const entry: RouteHistoryEntry = {
      id: `${session.startedAt}-${Date.now()}`,
      destination: session.destination,
      startedAt: session.startedAt,
      endedAt: Date.now(),
      distance: route.distance,
      duration: route.duration,
      deflocked: deflockActive,
      avoidedCameras: avoidedCameraCount
    };
    setRouteHistory((current) => [entry, ...current].slice(0, 50));
    navigationSessionRef.current = null;
  }

  function submitCameraReport(event: FormEvent) {
    event.preventDefault();
    if (!reportCamera) return;
    const report: CameraReport = {
      id: `${reportCamera.id}-${Date.now()}`,
      cameraId: reportCamera.id,
      cameraName: reportCamera.name,
      reason: reportReason,
      note: reportNote.trim(),
      createdAt: Date.now(),
      position: reportCamera.position
    };
    setCameraReports((current) => [report, ...current]);
    setReportCamera(null);
    setReportNote("");
    setRouteStatus("Camera correction queued on this device.");
  }

  function exportCameraReports() {
    const blob = new Blob([JSON.stringify(cameraReports, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `flockyou-camera-reports-${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function useFallbackRoute() {
    if (!fallbackRoute) return;
    setRoute(fallbackRoute);
    setFallbackRoute(null);
    setDeflockActive(false);
    setAvoidedCameraCount(0);
    setRouteStatus("Original route restored.");
  }

  function toggleNavigation() {
    if (!route) return;
    const next = !navigationActive;
    if (next) {
      routeTrackerRef.current.resetPosition();
      setTrackedPosition(null);
      spokenEventsRef.current.clear();
      navigationSessionRef.current = { startedAt: Date.now(), destination };
    } else {
      finishNavigationSession();
    }
    setNavigationActive(next);
    if (next) setPanelExpanded(false);
    setFollowGps(next || followGps);
    spokenStepRef.current = -1;
    if (!next) window.speechSynthesis?.cancel();
  }

  function cyclePerspective() {
    const next = perspective === "north" ? "overview" : "north";
    setPerspective(next);
  }

  function locateUser() {
    setFollowGps(true);
    if (perspective === "overview") setPerspective("north");
    if (!position || !mapRef.current) return;
    const zoom = navigationActive ? 17.25 : Math.max(15.5, mapRef.current.getZoom());
    mapRef.current.flyTo([position[1], position[0]], zoom, { duration: 0.7, easeLinearity: 0.2 });
  }

  async function installApp() {
    if (appInstalled) {
      setRouteStatus("FLOCKYOU is already installed.");
      return;
    }
    if (installPrompt) {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      setInstallPrompt(null);
      setRouteStatus(choice.outcome === "accepted" ? "Installing FLOCKYOU..." : "Installation dismissed.");
      return;
    }
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    setRouteStatus(ios
      ? "Open the Share menu and choose Add to Home Screen."
      : "Open the browser menu and choose Install app or Add to Home screen.");
  }

  function applyCameraData(data: any, merge: boolean) {
    const features = data.type === "FeatureCollection" ? data.features : [];
    const normalized = features
      .map((feature: any, index: number) => normalizeCameraFeature(feature, index))
      .filter(Boolean) as CameraPoint[];
    const existing = merge ? camerasRef.current : [];
    const byId = new Map(existing.map((camera) => [camera.id, camera]));
    normalized.forEach((camera) => byId.set(camera.id, camera));
    const next = [...byId.values()];
    camerasRef.current = next;
    setCameras(next);
    setCameraDatasetTotal(Number(data.total) || next.length);
    setCameraLoadState("ready");
    return next;
  }

  async function loadCamerasForBounds(bounds: [number, number, number, number], merge = false) {
    setCameraLoadState("loading");
    const bbox = bounds.map((coordinate) => coordinate.toFixed(6)).join(",");
    const response = await fetch(`/api/cameras?bbox=${bbox}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Could not load DeFlock data: ${response.status}`);
    return applyCameraData(data, merge);
  }

  async function loadCamerasForRoute(route: LineString, merge = true) {
    setCameraLoadState("loading");
    const response = await fetch("/api/cameras", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ route: sampledRouteCoordinates(route), corridorMeters: 4_000 })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Could not load route cameras: ${response.status}`);
    return applyCameraData(data, merge);
  }

  function scheduleVisibleCameraLoad() {
    if (cameraViewportTimerRef.current !== null) window.clearTimeout(cameraViewportTimerRef.current);
    cameraViewportTimerRef.current = window.setTimeout(() => {
      const map = mapRef.current;
      if (!map || map.getZoom() < 9) return;
      const visible = map.getBounds();
      const bounds: [number, number, number, number] = [visible.getWest(), visible.getSouth(), visible.getEast(), visible.getNorth()];
      const signature = bounds.map((coordinate) => coordinate.toFixed(2)).join(",");
      if (signature === lastCameraBoundsRef.current) return;
      lastCameraBoundsRef.current = signature;
      void loadCamerasForBounds(bounds, true).catch((error) => {
        setCameraLoadState("error");
        setRouteStatus(error instanceof Error ? error.message : "Camera data failed to load.");
      });
    }, 350);
  }

  async function loadInitialCameras() {
    try {
      if (!mapRef.current || mapRef.current.getZoom() < 9) {
        setCameraLoadState("ready");
        setRouteStatus("Allow GPS or move the map to load nearby cameras.");
        return;
      }
      setRouteStatus("Indexing cameras near the current map...");
      const mapBounds = mapRef.current?.getBounds();
      if (!mapBounds) return;
      const bounds: [number, number, number, number] = [mapBounds.getWest(), mapBounds.getSouth(), mapBounds.getEast(), mapBounds.getNorth()];
      const loaded = await loadCamerasForBounds(bounds);
      setRouteStatus(`Camera index ready: ${loaded.length.toLocaleString()} nearby points.`);
    } catch (error) {
      setCameraLoadState("error");
      setRouteStatus(error instanceof Error ? error.message : "Camera data failed to load. Tap retry.");
    }
  }

  useEffect(() => {
    if (!mapRef.current || cameraLoadStartedRef.current) return;
    cameraLoadStartedRef.current = true;
    void loadInitialCameras();
  }, [mapStatus]);

  return (
    <main className={`app-shell ${panelExpanded ? "panel-open" : "panel-closed"}`}>
      <div ref={mapNode} className="map" aria-label="Interactive navigation map" />

      <section className={`topbar ${navigationActive ? "navigation-mode" : ""}`} aria-label="Map search">
        <div className="brand">
          <h1>FLOCKYOU</h1>
          <p className="eyebrow">An open source to freedom</p>
        </div>
        <form className="map-search" onSubmit={searchMap}>
          <input
            aria-label="Search the map"
            value={mapSearch}
            onChange={(event) => setMapSearch(event.target.value)}
            placeholder="Where to? Search an address or place"
          />
          <button type="submit">Find</button>
        </form>
        {selectedPlace && (
          <button className="directions-button" onClick={routeToSelectedPlace}>Route</button>
        )}
        <button className="theme-button" onClick={() => setMapTheme((theme) => theme === "night" ? "day" : "night")}>
          {mapTheme === "night" ? "Day" : "Night"}
        </button>
        <button
          className={`perspective-button perspective-${perspective}`}
          onClick={cyclePerspective}
          title={perspective === "north" ? "North up" : "Route overview"}
          aria-label={`${perspective === "north" ? "North up" : "Route overview"}. Change map perspective.`}
        >
          <span className="perspective-glyph" aria-hidden="true" />
        </button>
        <button className={followGps ? "icon-button locate-button active" : "icon-button locate-button"} onClick={locateUser} title="Locate me" aria-label="Locate me and follow GPS">
          <span className="locate-glyph" aria-hidden="true" />
        </button>
        {!appInstalled && (
          <button className="icon-button install-toolbar" onClick={installApp} title="Install FLOCKYOU" aria-label="Install FLOCKYOU">
            <span className="install-glyph" aria-hidden="true" />
          </button>
        )}
        {navigationActive && (
          <button className="overlay-toggle" onClick={() => setHudMode((mode) => mode === "hidden" ? "full" : "hidden")}>
            HUD
          </button>
        )}
      </section>

      {searchResults.length > 0 && (
        <div className="search-results" role="listbox" aria-label="Address search results">
          {searchResults.map((result, index) => (
            <button key={`${result.point.join(",")}-${index}`} onClick={() => selectSearchResult(result)} role="option">
              <strong>{result.label}</strong>
            </button>
          ))}
        </div>
      )}

      {searchStatus && searchResults.length === 0 && <div className="search-result">{searchStatus}</div>}

      {navigationActive && route && hudMode !== "hidden" && (
        <section className={`navigation-banner ${hudMode}`} aria-live="polite">
          <div className="maneuver-symbol" aria-hidden="true">
            {safeManeuverSymbol(route.steps[activeStepIndex]?.instruction)}
          </div>
          <div className="maneuver-copy">
            <span>{distanceToTurn === null ? "Following route" : metersToLabel(distanceToTurn)}</span>
            <strong>{route.steps[activeStepIndex]?.instruction ?? "Continue to destination"}</strong>
            <small>Then: {route.steps[activeStepIndex + 1]?.instruction ?? "Arrive at destination"}</small>
            <span className={nextCameraThreat ? "hud-camera threat" : "hud-camera clear"}>
              {nextCameraThreat
                ? `CAMERA ${metersToLabel(Math.max(0, nextCameraThreat.routeLocation - (trackedPosition?.routeProgress ?? 0)))}`
                : "CAMERA CLEAR"}
            </span>
          </div>
          <div className="navigation-metrics">
            <div><span>ETA</span><strong>{arrivalTimeLabel(route.duration * ((trackedPosition?.remainingDistance ?? route.distance) / Math.max(1, route.distance)))}</strong></div>
            <div><span>LEFT</span><strong>{metersToLabel(trackedPosition?.remainingDistance ?? route.distance)}</strong></div>
            <div><span>SPEED</span><strong>{Math.round((trackedPosition?.speed ?? 0) * 2.23694)} mph</strong></div>
            <div><span>GPS</span><strong>{trackedPosition?.snapped ? "LOCKED" : "RAW"}</strong></div>
          </div>
          <div className="nav-actions">
            <button className="hud-size" onClick={() => setHudMode((mode) => mode === "compact" ? "full" : "compact")} title={hudMode === "compact" ? "Expand navigation HUD" : "Compact navigation HUD"}>
              {hudMode === "compact" ? "+" : "-"}
            </button>
            <button className="hud-hide" onClick={() => setHudMode("hidden")} title="Hide navigation HUD">x</button>
            <button className="end-navigation" onClick={toggleNavigation}>End</button>
          </div>
        </section>
      )}

      <aside className={`panel ${panelExpanded ? "expanded" : "collapsed"}`}>
        <button className="panel-toggle" onClick={() => setPanelExpanded((expanded) => !expanded)} aria-expanded={panelExpanded}>
          <i aria-hidden="true" />
          <strong>{panelExpanded ? "Hide controls" : route ? `${metersToLabel(route.distance)} / ${secondsToLabel(route.duration)}` : "Route controls"}</strong>
          <span>{panelExpanded ? "v" : "^"}</span>
        </button>
        <nav className="tabs" aria-label="Navigation panels">
          <button className={panel === "route" ? "active" : ""} onClick={() => { setPanel("route"); setPanelExpanded(true); }}>Route</button>
          <button className={panel === "cameras" ? "active" : ""} onClick={() => { setPanel("cameras"); setPanelExpanded(true); }}>Cameras</button>
          <button className={panel === "settings" ? "active" : ""} onClick={() => { setPanel("settings"); setPanelExpanded(true); }}>System</button>
        </nav>

        {panel === "route" && (
          <div className="panel-body">
            <form onSubmit={planRoute} className="route-form">
              <label>
                Destination
                <input value={destination} onChange={(event) => {
                  setDestination(event.target.value);
                  if (event.target.value !== selectedPlace?.label) setSelectedPlace(null);
                }} placeholder="Search destination address or place" autoComplete="off" />
              </label>
              {destinationResults.length > 0 && (
                <div className="destination-results" role="listbox" aria-label="Destination address results">
                  {destinationResults.map((result, index) => (
                    <button type="button" key={`${result.point.join(",")}-${index}`} onClick={() => selectDestinationResult(result)}>
                      {result.label}
                    </button>
                  ))}
                </div>
              )}
              <span className="form-section-label">Start from</span>
              <div className="mode-row">
                <button type="button" className={fromMode === "gps" ? "active" : ""} onClick={() => setFromMode("gps")}>My location</button>
                <button type="button" className={fromMode === "address" ? "active" : ""} onClick={() => setFromMode("address")}>From address</button>
              </div>
              {fromMode === "address" && (
                <label>
                  From
                  <input value={origin} onChange={(event) => setOrigin(event.target.value)} placeholder="Starting address or place" />
                </label>
              )}
              <button type="submit">Plan route</button>
            </form>
            <button className="deflock-check" onClick={(event) => planRoute(event as any, true)}>
              {cameraLoadState === "error" ? "Retry and DeFlock my route" : "DeFlock my route"}
            </button>
            <p className="route-status" aria-live="polite">{routeStatus}</p>

            <div className="status-grid">
              <div>
                <span>GPS</span>
                <strong>{gpsStatus}</strong>
                <small>{accuracy ? metersToLabel(accuracy) : "Unknown accuracy"}</small>
              </div>
              <div>
                <span>Map</span>
                <strong>{mapStatus}</strong>
                <small>{cameras.length.toLocaleString()} nearby / {cameraDatasetTotal.toLocaleString()} indexed</small>
              </div>
            </div>

            {route ? (
              <>
                <div className="route-summary">
                  <strong>{metersToLabel(route.distance)}</strong>
                  <strong>{secondsToLabel(route.duration)}</strong>
                  <span>{deflockActive ? `${avoidedCameraCount} camera${avoidedCameraCount === 1 ? "" : "s"} avoided` : `${route.cameraHits} camera views intersect route`}</span>
                </div>
                <div className="route-legend">
                  <span><i className="route-swatch blue" />Route</span>
                  {route.detours.length > 0 && <span><i className="route-swatch purple" />DeFlock bypass</span>}
                </div>
                <button className="start-navigation" onClick={toggleNavigation}>{navigationActive ? "End navigation" : "Start navigation"}</button>
                {fallbackRoute && <button className="fallback-route" onClick={useFallbackRoute}>Restore original route</button>}
                {alternates.length > 0 && (
                  <div className="alternates">
                    {alternates.map((alternate) => (
                      <button key={`${alternate.label}-${alternate.distance}`} onClick={() => chooseRoute(alternate)}>
                        <strong>{alternate.label}</strong>
                        <span>{metersToLabel(alternate.distance)} / {secondsToLabel(alternate.duration)} / {alternate.cameraHits} camera points</span>
                      </button>
                    ))}
                  </div>
                )}
                {routeHistory.length > 0 && (
                  <section className="history-block">
                    <header><strong>Route history</strong><span>{routeHistory.reduce((total, item) => total + item.avoidedCameras, 0)} avoided total</span></header>
                    <ul>
                      {routeHistory.slice(0, 5).map((item) => (
                        <li key={item.id}>
                          <strong>{item.destination}</strong>
                          <span>{new Date(item.startedAt).toLocaleDateString()} / {metersToLabel(item.distance)} / {item.avoidedCameras} avoided</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </>
            ) : (
              <p className="empty-state">{routeStatus}</p>
            )}
          </div>
        )}

        {panel === "cameras" && (
          <div className="panel-body">
            <div className="mode-row camera-scope" aria-label="Camera display scope">
              <button type="button" className={cameraScope === "route" ? "active" : ""} onClick={() => setCameraScope("route")}>Near route</button>
              <button type="button" className={cameraScope === "visible" ? "active" : ""} onClick={() => setCameraScope("visible")}>All visible</button>
            </div>
            <div className="camera-count">
              <strong>{cameras.length.toLocaleString()}</strong>
              <span>{cameraScope === "route" ? "dataset loaded / showing route corridor" : "dataset loaded / showing current map"}</span>
            </div>
            <ul className="camera-list">
              {nearbyCameras.map((camera) => (
                <li key={camera.id}>
                  <strong>{camera.name}</strong>
                  <span>{camera.source}</span>
                  <small>
                    Facing {Math.round(camera.bearing)} deg / {route ? `${metersToLabel(camera.routeDistance)} from route` : `${metersToLabel(camera.userDistance)} away`}
                  </small>
                  <div className="camera-actions">
                    <span className={cameraFreshness(camera).stale ? "stale" : "fresh"}>{cameraFreshness(camera).label}</span>
                    <button type="button" onClick={() => setReportCamera(camera)}>Report</button>
                  </div>
                </li>
              ))}
            </ul>
            {reportCamera && (
              <form className="report-form" onSubmit={submitCameraReport}>
                <strong>Report {reportCamera.name}</strong>
                <label>
                  Correction
                  <select value={reportReason} onChange={(event) => setReportReason(event.target.value as CameraReport["reason"])}>
                    <option value="moved">Camera moved</option>
                    <option value="missing">Camera missing</option>
                    <option value="direction">Direction incorrect</option>
                    <option value="other">Other correction</option>
                  </select>
                </label>
                <label>
                  Note
                  <input value={reportNote} onChange={(event) => setReportNote(event.target.value)} placeholder="Optional detail" />
                </label>
                <div className="report-buttons"><button type="submit">Queue report</button><button type="button" onClick={() => setReportCamera(null)}>Cancel</button></div>
              </form>
            )}
          </div>
        )}

        {panel === "settings" && (
          <div className="panel-body settings">
            <button type="button" className="install-app" onClick={installApp} disabled={appInstalled}>
              {appInstalled ? "FLOCKYOU installed" : "Install FLOCKYOU"}
            </button>
            <label>
              OpenRouteService API key
              <input type="password" autoComplete="off" spellCheck={false} value={orsKey} onChange={(event) => setOrsKey(event.target.value)} placeholder="Paste key for driving directions" />
            </label>
            <span className="form-section-label">Voice guidance</span>
            <div className="mode-row">
              <button type="button" className={voiceMode === "full" ? "active" : ""} onClick={() => setVoiceMode("full")}>Full</button>
              <button type="button" className={voiceMode === "alerts" ? "active" : ""} onClick={() => setVoiceMode("alerts")}>Alerts</button>
              <button type="button" className={voiceMode === "muted" ? "active" : ""} onClick={() => setVoiceMode("muted")}>Muted</button>
            </div>
            <label className="toggle-setting">
              <input type="checkbox" checked={lowDataMode} onChange={(event) => setLowDataMode(event.target.checked)} />
              <span>Low-data camera rendering</span>
            </label>
            <div className="report-queue"><span>{cameraReports.length} correction reports queued</span><button type="button" disabled={!cameraReports.length} onClick={exportCameraReports}>Export</button></div>
            <p>Camera dots are drawn only for the visible map area so the full DeFlock dataset does not blank or freeze the basemap.</p>
          </div>
        )}
      </aside>
    </main>
  );
}
