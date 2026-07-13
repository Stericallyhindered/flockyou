const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "..", "app", "lib", "navigation-core.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
const moduleContainer = { exports: {} };
const sandbox = { module: moduleContainer, exports: moduleContainer.exports, console };
vm.runInNewContext(compiled, sandbox, { filename: "navigation-core.js" });

const { RouteTracker } = moduleContainer.exports;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const tracker = new RouteTracker();
const route = {
  type: "LineString",
  coordinates: [
    [-119.01, 35.37],
    [-119.005, 35.37],
    [-119.0, 35.37]
  ]
};
tracker.setRoute(route, [
  { instruction: "Continue east", distance: 450, duration: 35, wayPoint: 1 },
  { instruction: "Arrive", distance: 450, duration: 35, wayPoint: 2 }
]);

function sample(longitude, latitude, timestamp, heading = 90, speed = 12, accuracy = 7) {
  return tracker.update({
    position: [longitude, latitude],
    accuracy,
    heading,
    speed,
    timestamp
  }, true);
}

const first = sample(-119.009, 35.37006, 1000);
assert(first.snapped, "A plausible GPS fix should snap to the route.");
assert(Math.abs(first.displayPosition[1] - 35.37) < 0.00001, "The displayed fix should lie on the route.");

const forward = sample(-119.003, 35.36996, 2000);
assert(forward.routeProgress > first.routeProgress, "Route progress should advance with the vehicle.");
assert(forward.routeIndex >= 1, "The tracker should advance to the next route segment.");

const backwardNoise = sample(-119.004, 35.37004, 3000);
assert(backwardNoise.routeProgress >= forward.routeProgress, "GPS noise must not move route progress backward.");

const offRoute = sample(-119.003, 35.372, 4000, 90, 12, 6);
assert(offRoute.offRoute, "A sustained distant fix should be classified off route.");
assert(!offRoute.snapped, "An off-route fix must not be forced onto the route.");

console.log("navigation-core: synthetic drive passed");
