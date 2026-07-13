import type { LngLat, RouteLine } from "./deflock-routing";

export type NavigationStep = {
  instruction: string;
  distance: number;
  duration: number;
  wayPoint: number;
};

export type GpsSample = {
  position: LngLat;
  accuracy: number;
  heading: number | null;
  speed: number | null;
  timestamp: number;
};

export type TrackedPosition = {
  rawPosition: LngLat;
  filteredPosition: LngLat;
  displayPosition: LngLat;
  snapped: boolean;
  routeDistance: number;
  routeProgress: number;
  routeIndex: number;
  activeStepIndex: number;
  distanceToManeuver: number | null;
  remainingDistance: number;
  heading: number;
  speed: number;
  offRoute: boolean;
};

const EARTH_RADIUS = 6371000;

function toRadians(value: number) {
  return value * Math.PI / 180;
}

function toDegrees(value: number) {
  return value * 180 / Math.PI;
}

export function geoDistance(a: LngLat, b: LngLat) {
  const latitude = toRadians((a[1] + b[1]) / 2);
  const x = toRadians(b[0] - a[0]) * Math.cos(latitude);
  const y = toRadians(b[1] - a[1]);
  return Math.hypot(x, y) * EARTH_RADIUS;
}

export function geoBearing(a: LngLat, b: LngLat) {
  const lat1 = toRadians(a[1]);
  const lat2 = toRadians(b[1]);
  const longitudeDelta = toRadians(b[0] - a[0]);
  const y = Math.sin(longitudeDelta) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(longitudeDelta);
  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

function angleDifference(a: number, b: number) {
  return Math.abs(((a - b + 540) % 360) - 180);
}

function interpolate(a: LngLat, b: LngLat, amount: number): LngLat {
  return [a[0] + (b[0] - a[0]) * amount, a[1] + (b[1] - a[1]) * amount];
}

function projectToSegment(point: LngLat, start: LngLat, end: LngLat) {
  const latitude = toRadians((start[1] + end[1] + point[1]) / 3);
  const scaleX = Math.cos(latitude) * Math.PI / 180 * EARTH_RADIUS;
  const scaleY = Math.PI / 180 * EARTH_RADIUS;
  const bx = (end[0] - start[0]) * scaleX;
  const by = (end[1] - start[1]) * scaleY;
  const px = (point[0] - start[0]) * scaleX;
  const py = (point[1] - start[1]) * scaleY;
  const denominator = bx * bx + by * by;
  const amount = denominator === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / denominator));
  const projected = interpolate(start, end, amount);
  return { projected, amount, distance: geoDistance(point, projected) };
}

function smoothPosition(previous: LngLat | null, sample: GpsSample) {
  if (!previous) return sample.position;
  const movement = geoDistance(previous, sample.position);
  if (movement > Math.max(100, sample.accuracy * 3)) return sample.position;
  const accuracyWeight = Math.max(0.12, Math.min(0.72, 18 / Math.max(18, sample.accuracy)));
  const speedWeight = Math.max(0, Math.min(0.2, (sample.speed ?? 0) / 35));
  return interpolate(previous, sample.position, Math.min(0.85, accuracyWeight + speedWeight));
}

export class RouteTracker {
  private route: RouteLine | null = null;
  private steps: NavigationStep[] = [];
  private cumulative: number[] = [];
  private totalDistance = 0;
  private filteredPosition: LngLat | null = null;
  private previousRawPosition: LngLat | null = null;
  private progress = 0;
  private routeIndex = 0;
  private heading = 0;
  private speed = 0;

  setRoute(route: RouteLine | null, steps: NavigationStep[] = []) {
    this.route = route;
    this.steps = steps;
    this.cumulative = [0];
    const coordinates = route?.coordinates ?? [];
    for (let index = 1; index < coordinates.length; index += 1) {
      this.cumulative.push(this.cumulative[index - 1] + geoDistance(coordinates[index - 1], coordinates[index]));
    }
    this.totalDistance = this.cumulative.at(-1) ?? 0;
    this.progress = 0;
    this.routeIndex = 0;
  }

  resetPosition() {
    this.filteredPosition = null;
    this.previousRawPosition = null;
    this.progress = 0;
    this.routeIndex = 0;
  }

  update(sample: GpsSample, snapToRoute: boolean): TrackedPosition {
    this.filteredPosition = smoothPosition(this.filteredPosition, sample);
    const movement = this.previousRawPosition ? geoDistance(this.previousRawPosition, sample.position) : 0;
    const derivedHeading = this.previousRawPosition && movement > 3
      ? geoBearing(this.previousRawPosition, sample.position)
      : this.heading;
    const nextHeading = sample.heading !== null && Number.isFinite(sample.heading) && (sample.speed ?? 0) > 0.8
      ? sample.heading
      : derivedHeading;
    this.heading = nextHeading;
    this.speed = sample.speed !== null && Number.isFinite(sample.speed)
      ? Math.max(0, sample.speed)
      : movement > 0 ? movement / Math.max(1, (sample.timestamp - (this.lastTimestamp || sample.timestamp - 1000)) / 1000) : this.speed;
    this.lastTimestamp = sample.timestamp;
    this.previousRawPosition = sample.position;

    const match = this.matchRoute(this.filteredPosition, nextHeading);
    const snapThreshold = Math.max(22, Math.min(70, sample.accuracy * 1.4));
    const snapped = Boolean(snapToRoute && match && match.distance <= snapThreshold);
    if (match && match.distance <= Math.max(100, sample.accuracy * 2)) {
      this.progress = Math.max(this.progress, match.progress);
      this.routeIndex = Math.max(this.routeIndex, match.index);
    }

    const activeStepIndex = this.findStepIndex(this.routeIndex);
    const maneuverIndex = this.steps[activeStepIndex]?.wayPoint;
    const maneuverProgress = maneuverIndex === undefined ? null : this.cumulative[Math.min(maneuverIndex, this.cumulative.length - 1)];

    return {
      rawPosition: sample.position,
      filteredPosition: this.filteredPosition,
      displayPosition: snapped && match ? match.projected : this.filteredPosition,
      snapped,
      routeDistance: match?.distance ?? Number.POSITIVE_INFINITY,
      routeProgress: this.progress,
      routeIndex: this.routeIndex,
      activeStepIndex,
      distanceToManeuver: maneuverProgress === null ? null : Math.max(0, maneuverProgress - this.progress),
      remainingDistance: Math.max(0, this.totalDistance - this.progress),
      heading: this.heading,
      speed: this.speed,
      offRoute: Boolean(match && match.distance > Math.max(55, Math.min(120, sample.accuracy * 2)))
    };
  }

  private lastTimestamp = 0;

  private findStepIndex(routeIndex: number) {
    const next = this.steps.findIndex((step) => step.wayPoint >= routeIndex);
    return next < 0 ? Math.max(0, this.steps.length - 1) : next;
  }

  private matchRoute(point: LngLat, heading: number) {
    const coordinates = this.route?.coordinates ?? [];
    if (coordinates.length < 2) return null;
    let best: { projected: LngLat; distance: number; progress: number; index: number; score: number } | null = null;
    const hasProgress = this.progress > 0;

    for (let index = 0; index < coordinates.length - 1; index += 1) {
      const segmentStart = this.cumulative[index];
      const segmentEnd = this.cumulative[index + 1];
      if (hasProgress && (segmentEnd < this.progress - 35 || segmentStart > this.progress + 3000)) continue;
      const projection = projectToSegment(point, coordinates[index], coordinates[index + 1]);
      const segmentHeading = geoBearing(coordinates[index], coordinates[index + 1]);
      const headingPenalty = this.speed > 2 && angleDifference(segmentHeading, heading) > 80 ? 35 : 0;
      const candidateProgress = segmentStart + (segmentEnd - segmentStart) * projection.amount;
      const backwardPenalty = candidateProgress + 15 < this.progress ? 100 : 0;
      const score = projection.distance + headingPenalty + backwardPenalty;
      if (!best || score < best.score) {
        best = { ...projection, progress: candidateProgress, index, score };
      }
    }
    return best;
  }
}
