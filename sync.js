/**
 * WhereMyBus Singapore - Automated LTA Transit Data Sync
 * Runs via GitHub Actions (Node.js 18+)
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

async function main() {
  const ltaKey = process.env.LTA_API_KEY?.trim();
  if (!ltaKey) {
    console.error("Missing LTA_API_KEY environment secret.");
    process.exit(1);
  }

  console.log("1/4: Fetching bus stops from LTA DataMall...");
  const rawStops = await fetchAllPaginated("https://datamall2.mytransport.sg/ltaodataservice/BusStops", ltaKey);
  console.log(`Fetched ${rawStops.length} raw bus stops.`);

  console.log("2/4: Fetching bus routes from LTA DataMall...");
  const rawRoutes = await fetchAllPaginated("https://datamall2.mytransport.sg/ltaodataservice/BusRoutes", ltaKey);
  console.log(`Fetched ${rawRoutes.length} raw bus route sequences.`);

  console.log("3/4: Processing and compiling transit dataset...");
  const { minifiedStops, minifiedRoutes } = processTransitData(rawStops, rawRoutes);

  const stopsJson = JSON.stringify(minifiedStops);
  const routesJson = JSON.stringify(minifiedRoutes);

  const newHash = crypto.createHash("sha256").update(stopsJson + routesJson).digest("hex");
  console.log(`Dataset SHA-256: ${newHash}`);

  // Check existing version.json
  const versionPath = path.join(__dirname, "version.json");
  let currentHash = "";
  if (fs.existsSync(versionPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(versionPath, "utf8"));
      currentHash = existing.dataHash || "";
    } catch (_) {}
  }

  if (currentHash === newHash) {
    console.log("No changes detected in LTA dataset. Skipping update.");
    return;
  }

  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const newVersion = parseInt(`${year}${month}${day}`, 10);

  const repo = process.env.GITHUB_REPOSITORY; // e.g. "username/wmb-assets"
  const versionPayload = {
    version: newVersion,
    lastUpdated: `${year}-${month}-${day}`,
    dataHash: newHash,
    busStopsUrl: `https://cdn.jsdelivr.net/gh/${repo}@main/bus_stops.min.json`,
    busRoutesUrl: `https://cdn.jsdelivr.net/gh/${repo}@main/bus_routes.min.json`
  };

  // Write minified output files
  fs.writeFileSync(path.join(__dirname, "bus_stops.min.json"), stopsJson, "utf8");
  fs.writeFileSync(path.join(__dirname, "bus_routes.min.json"), routesJson, "utf8");
  fs.writeFileSync(versionPath, JSON.stringify(versionPayload, null, 2), "utf8");

  console.log(`Successfully compiled version ${newVersion} (${minifiedStops.length} stops, ${minifiedRoutes.length} routes).`);
}

async function fetchAllPaginated(baseUrl, apiKey) {
  const records = [];
  let skip = 0;
  const batchSize = 5;

  while (true) {
    const promises = [];
    for (let i = 0; i < batchSize; i++) {
      const currentSkip = skip + i * 500;
      promises.push(
        fetch(`${baseUrl}?$skip=${currentSkip}`, {
          headers: { AccountKey: apiKey, accept: "application/json" }
        }).then(async res => {
          if (!res.ok) throw new Error(`LTA error ${res.status}`);
          return res.json();
        })
      );
    }

    const results = await Promise.all(promises);
    let reachedEnd = false;

    for (const data of results) {
      if (data && data.value && data.value.length > 0) {
        records.push(...data.value);
        if (data.value.length < 500) {
          reachedEnd = true;
          break;
        }
      } else {
        reachedEnd = true;
        break;
      }
    }

    if (reachedEnd) break;
    skip += batchSize * 500;
  }

  return records;
}

function processTransitData(rawStops, rawRoutes) {
  const stopServicesMap = new Map();
  const routesMap = new Map();

  for (const r of rawRoutes) {
    const svc = String(r.ServiceNo).trim();
    const stopCode = String(r.BusStopCode).trim().padStart(5, "0");
    const dir = r.Direction;
    const seq = r.StopSequence;
    const dist = r.Distance ?? 0.0;

    if (!stopServicesMap.has(stopCode)) stopServicesMap.set(stopCode, new Set());
    stopServicesMap.get(stopCode).add(svc);

    if (!routesMap.has(svc)) {
      routesMap.set(svc, {
        s: svc,
        op: r.Operator || "SBST",
        origin: "",
        destination: "",
        wf: r.WD_FirstBus || "05:30",
        wl: r.WD_LastBus || "23:30",
        wef: r.SAT_FirstBus || "05:30",
        wel: r.SAT_LastBus || "23:30",
        pk: "10-15",
        opk: "10-20",
        dir1Name: "",
        dir1Stops: [],
        dir2Name: "",
        dir2Stops: []
      });
    }

    const routeObj = routesMap.get(svc);
    const stopEntry = { seq, c: stopCode, d: dist };
    if (dir === 1) routeObj.dir1Stops.push(stopEntry);
    else routeObj.dir2Stops.push(stopEntry);
  }

  const stopNameMap = new Map(rawStops.map(s => [String(s.BusStopCode).trim().padStart(5, "0"), s.Description]));

  const minifiedRoutes = Array.from(routesMap.values()).map(r => {
    r.dir1Stops.sort((a, b) => a.seq - b.seq);
    r.dir2Stops.sort((a, b) => a.seq - b.seq);
    const firstStop1 = r.dir1Stops[0]?.c;
    const lastStop1 = r.dir1Stops[r.dir1Stops.length - 1]?.c;
    r.origin = stopNameMap.get(firstStop1) || "Interchange";
    r.destination = stopNameMap.get(lastStop1) || "Interchange";
    r.dir1Name = `Towards ${r.destination}`;

    if (r.dir2Stops.length > 0) {
      const lastStop2 = r.dir2Stops[r.dir2Stops.length - 1]?.c;
      r.dir2Name = `Towards ${stopNameMap.get(lastStop2) || r.origin}`;
    } else {
      delete r.dir2Name;
      delete r.dir2Stops;
    }
    return r;
  }).sort((a, b) => a.s.localeCompare(b.s, undefined, { numeric: true }));

  const minifiedStops = rawStops.map(s => {
    const code = String(s.BusStopCode).trim().padStart(5, "0");
    const services = Array.from(stopServicesMap.get(code) || []).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true })
    );

    return {
      c: code,
      n: s.Description || "",
      r: s.RoadName || "",
      lat: s.Latitude,
      lng: s.Longitude,
      s: services
    };
  }).sort((a, b) => a.c.localeCompare(b.c));

  return { minifiedStops, minifiedRoutes };
}

main().catch(err => {
  console.error("Sync failed:", err);
  process.exit(1);
});
