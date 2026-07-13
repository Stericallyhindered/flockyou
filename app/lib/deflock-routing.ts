import {
  along,
  bearing,
  bbox,
  booleanIntersects,
  buffer,
  length,
  lineSliceAlong,
  lineString,
  multiPolygon,
  nearestPointOnLine,
  point,
  sector
} from "@turf/turf";

export type LngLat = [number, number];

export type RouteLine = {
  type: "LineString";
  coordinates: LngLat[];
};

export type RoutingCamera = {
  id: string;
  position: LngLat;
  bearing: number;
  directionKnown: boolean;
};

export type CameraExposure<T extends RoutingCamera = RoutingCamera> = {
  camera: T;
  routeLocation: number;
};

export type DetourWindow = {
  start: LngLat;
  end: LngLat;
  startIndex: number;
  endIndex: number;
  startLocation: number;
  endLocation: number;
  startBearing: number;
  endBearing: number;
  originalSegment: RouteLine;
};

const CLEARANCE_FEET = 120;
const HALF_FOV_DEGREES = 65;

function asLine(line: RouteLine) {
  return lineString(line.coordinates);
}

export function cameraZone(camera: RoutingCamera) {
  const center = point(camera.position);
  if (!camera.directionKnown) {
    return buffer(center, CLEARANCE_FEET, { units: "feet", steps: 16 });
  }
  return sector(
    center,
    CLEARANCE_FEET,
    camera.bearing - HALF_FOV_DEGREES,
    camera.bearing + HALF_FOV_DEGREES,
    { units: "feet", steps: 16 }
  );
}

export function camerasNearRouteBounds<T extends RoutingCamera>(cameras: T[], line: RouteLine): T[] {
  const [west, south, east, north] = bbox(asLine(line));
  const padding = 0.002;
  return cameras.filter(({ position: [lon, lat] }) =>
    lon >= west - padding && lon <= east + padding &&
    lat >= south - padding && lat <= north + padding
  );
}

export function findCameraExposures<T extends RoutingCamera>(cameras: T[], route: RouteLine): CameraExposure<T>[] {
  const turfRoute = asLine(route);
  return camerasNearRouteBounds(cameras, route)
    .flatMap((camera) => {
      const zone = cameraZone(camera);
      if (!zone || !booleanIntersects(turfRoute, zone)) return [];
      const snapped = nearestPointOnLine(turfRoute, point(camera.position), { units: "meters" });
      return [{ camera, routeLocation: Number(snapped.properties.location ?? 0) }];
    })
    .sort((a, b) => a.routeLocation - b.routeLocation);
}

export function firstExposureCluster<T extends RoutingCamera>(exposures: CameraExposure<T>[], maxRouteSpanMeters = 1800) {
  if (!exposures.length) return [];
  const firstLocation = exposures[0].routeLocation;
  return exposures.filter((exposure) => exposure.routeLocation - firstLocation <= maxRouteSpanMeters);
}

export function createDetourWindow<T extends RoutingCamera>(route: RouteLine, cluster: CameraExposure<T>[], searchDistanceMeters: number): DetourWindow {
  const turfRoute = asLine(route);
  const routeLength = length(turfRoute, { units: "meters" });
  const firstLocation = Math.min(...cluster.map((exposure) => exposure.routeLocation));
  const lastLocation = Math.max(...cluster.map((exposure) => exposure.routeLocation));
  const startLocation = Math.max(0, firstLocation - searchDistanceMeters);
  const endLocation = Math.min(routeLength, lastLocation + searchDistanceMeters);
  const startFeature = along(turfRoute, startLocation, { units: "meters" });
  const endFeature = along(turfRoute, endLocation, { units: "meters" });
  const start = startFeature.geometry.coordinates as LngLat;
  const end = endFeature.geometry.coordinates as LngLat;
  const startAhead = along(turfRoute, Math.min(endLocation, startLocation + 40), { units: "meters" });
  const endBefore = along(turfRoute, Math.max(startLocation, endLocation - 40), { units: "meters" });
  const normalizeBearing = (value: number) => (value + 360) % 360;
  const startSnap = nearestPointOnLine(turfRoute, startFeature, { units: "meters" });
  const endSnap = nearestPointOnLine(turfRoute, endFeature, { units: "meters" });
  const originalSegment = lineSliceAlong(turfRoute, startLocation, endLocation, { units: "meters" });
  return {
    start,
    end,
    startIndex: Number(startSnap.properties.index ?? 0),
    endIndex: Number(endSnap.properties.index ?? route.coordinates.length - 1) + 1,
    startLocation,
    endLocation,
    startBearing: normalizeBearing(bearing(startFeature, startAhead)),
    endBearing: normalizeBearing(bearing(endBefore, endFeature)),
    originalSegment: originalSegment.geometry as RouteLine
  };
}

export function avoidanceGeometry(cameras: RoutingCamera[]) {
  const polygons = cameras
    .map(cameraZone)
    .filter(Boolean)
    .flatMap((zone) => zone!.geometry.type === "Polygon" ? [zone!.geometry.coordinates] : zone!.geometry.coordinates);
  return multiPolygon(polygons).geometry;
}

export function spliceDetour(route: RouteLine, detour: RouteLine, window: DetourWindow): RouteLine {
  const turfRoute = asLine(route);
  const routeLength = length(turfRoute, { units: "meters" });
  const prefix = lineSliceAlong(turfRoute, 0, window.startLocation, { units: "meters" }).geometry.coordinates as LngLat[];
  const suffix = lineSliceAlong(turfRoute, window.endLocation, routeLength, { units: "meters" }).geometry.coordinates as LngLat[];
  const coordinates = [...prefix, ...detour.coordinates.slice(1), ...suffix.slice(1)];
  return { type: "LineString", coordinates };
}

export function routeLengthMeters(route: RouteLine) {
  return length(asLine(route), { units: "meters" });
}

export function distanceToRoute(pointCoordinates: LngLat, route?: RouteLine) {
  if (!route?.coordinates.length) return Number.POSITIVE_INFINITY;
  const snapped = nearestPointOnLine(asLine(route), point(pointCoordinates), { units: "meters" });
  return Number(snapped.properties.dist ?? Number.POSITIVE_INFINITY);
}

export function routeSignature(route: RouteLine) {
  const stride = Math.max(1, Math.floor(route.coordinates.length / 80));
  return route.coordinates
    .filter((_, index) => index % stride === 0 || index === route.coordinates.length - 1)
    .map(([lon, lat]) => `${lon.toFixed(5)},${lat.toFixed(5)}`)
    .join("|");
}
