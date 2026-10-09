/**
 * Visitor counter for the Honeycomb-Surfels project page: a Cloudflare Worker with a D1 database.
 *
 *   POST /hit    counts the caller (at most once per visit) and returns {"counted": bool, ...stats}.
 *   GET  /stats  returns the stats without counting:
 *                {"total_visits": n, "last24h": {"visits": n, "countries": [{"code": "US", "count": n}, ...]}}
 *
 * Definitions (the page footer and stats/README.md use them as they are):
 *   - A visit is one browser on one network on one UTC day: repeat page loads with the same user agent from
 *     the same network on the same UTC day count once, and a person who comes back on another day, or from
 *     another network, counts again. The network is the IPv4 address or the /64 prefix of an IPv6 address.
 *   - A visit is identified by the SHA-256 of VISITOR_SALT, the day, the network and the user agent. That hash
 *     is the only per-visitor value stored, and it is deleted once its UTC day is over (by a daily Cron Trigger
 *     at 00:05 UTC, and by the first hit of each new day). IP addresses and user agents are never stored.
 *   - total_visits counts visits since launch.
 *   - last24h counts the visits whose first page load fell in the current UTC hour or one of the 23 before
 *     it, by the country Cloudflare resolves from the IP address ("XX" when it is unknown).
 *
 * Configuration (wrangler.toml and secrets): the DB binding (D1), ALLOWED_ORIGINS (comma-separated page
 * origins that may count visits and read the stats from a browser), the VISITOR_SALT secret, and the optional
 * HIT_LIMITER rate limiting binding (per-network limit on POST /hit). No npm dependencies.
 */

const HOUR_MS = 3_600_000;
const WINDOW_HOURS = 24;
const HOURLY_RETENTION_HOURS = 48;
const STATS_CACHE_MS = 60_000;
const STATS_MAX_AGE_S = 60;
const SEEN_TTL_MS = 10 * 60_000;
const SEEN_MAX_ENTRIES = 10_000;
const MIN_SALT_LENGTH = 16;
const UNKNOWN_COUNTRY = "XX";
const COUNTRY_CODE = /^[A-Z]{2}$/;

// Crawlers, link previewers, monitors, headless browsers and HTTP libraries. Browsers never match;
// "(?<!cu)" keeps Cubot phones, whose user agent contains "CUBOT", from counting as bots.
const BOT_USER_AGENT = new RegExp(
  [
    "(?<!cu)bot\\b", "crawl", "spider", "slurp", "scrap", "archiver", "preview", "headless", "lighthouse",
    "pagespeed", "gtmetrix", "pingdom", "ptst/", "phantomjs", "puppeteer", "playwright", "selenium",
    "webdriver", "prerender", "facebookexternalhit", "mediapartners-google", "adsbot", "google-inspectiontool",
    "googleother", "feedfetcher", "yandex", "^curl/", "^wget/", "python", "httpclient", "okhttp",
    "go-http-client", "^java/", "libwww", "node-fetch", "axios/", "undici",
  ].join("|"),
  "i",
);

// Per-isolate state. Isolates are short-lived and not shared, so all three are optimisations only:
// statsCache saves D1 reads (D1's free daily limits apply to the whole account), seenVisits saves D1 work on
// reloads within a counted visit, and lastCleanupDay limits the request-time cleanup to the first hit of each
// UTC day in each isolate.
let statsCache = null;
const seenVisits = new Map();
let lastCleanupDay = null;

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function hourStart(ms) {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The network an IP address belongs to: the IPv4 address itself (also when embedded in an IPv6 address),
 * or the /64 prefix of an IPv6 address, because devices rotate the last 64 bits for privacy.
 */
function networkOf(ip) {
  if (ip.includes(".")) return ip.slice(ip.lastIndexOf(":") + 1);
  if (!ip.includes(":")) return ip;
  const [head, tail] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const zeros = tail === undefined ? [] : Array(Math.max(0, 8 - left.length - right.length)).fill("0");
  const prefix = [...left, ...zeros, ...right].slice(0, 4).map((group) => (parseInt(group, 16) || 0).toString(16));
  return `${prefix.join(":")}::/64`;
}

function allowedOrigins(env) {
  return new Set(
    String(env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim().replace(/\/+$/, ""))
      .filter(Boolean),
  );
}

function isAllowedOrigin(env, origin) {
  return Boolean(origin) && allowedOrigins(env).has(origin);
}

function corsHeaders(env, request) {
  const origin = request.headers.get("Origin");
  const headers = { Vary: "Origin" };
  if (isAllowedOrigin(env, origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
    headers["Access-Control-Max-Age"] = "86400";
  }
  return headers;
}

function jsonResponse(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function isBot(userAgent) {
  return !userAgent || BOT_USER_AGENT.test(userAgent);
}

function countryCode(request) {
  const code = String(request.cf?.country ?? "").toUpperCase();
  return COUNTRY_CODE.test(code) ? code : UNKNOWN_COUNTRY;
}

function seenRecently(key, now) {
  const until = seenVisits.get(key);
  return until !== undefined && until > now;
}

function rememberVisit(key, now) {
  if (seenVisits.size >= SEEN_MAX_ENTRIES) {
    for (const [seenKey, until] of seenVisits) {
      if (until <= now) seenVisits.delete(seenKey);
    }
    if (seenVisits.size >= SEEN_MAX_ENTRIES) seenVisits.clear();
  }
  seenVisits.set(key, now + SEEN_TTL_MS);
}

function sortCountries(countries) {
  return countries.sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

/**
 * Record one page load. Returns {counted, total}: counted is true when the page load starts a new visit
 * (first page load of this visitor hash today), and total is then the running total including it.
 * The batch runs as one transaction. Both counter updates first check that the visit row does not exist
 * yet, and the visit row is inserted last, so a visit is counted at most once.
 */
async function recordVisit(env, { day, visitorHash, country, now }) {
  const isNewVisit = "NOT EXISTS (SELECT 1 FROM visits WHERE day = ?1 AND visitor_hash = ?2)";
  const [totalResult, , visitResult] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO counters (name, value) SELECT 'total_visits', 1 WHERE ${isNewVisit} ` +
        "ON CONFLICT (name) DO UPDATE SET value = value + 1 RETURNING value",
    ).bind(day, visitorHash),
    env.DB.prepare(
      `INSERT INTO hourly_visits (hour_ms, country, visits) SELECT ?3, ?4, 1 WHERE ${isNewVisit} ` +
        "ON CONFLICT (hour_ms, country) DO UPDATE SET visits = visits + 1",
    ).bind(day, visitorHash, hourStart(now), country),
    env.DB.prepare(
      "INSERT INTO visits (day, visitor_hash, country, first_seen_ms) VALUES (?1, ?2, ?3, ?4) " +
        "ON CONFLICT (day, visitor_hash) DO NOTHING",
    ).bind(day, visitorHash, country, now),
  ]);
  return { counted: (visitResult.meta?.changes ?? 0) > 0, total: Number(totalResult.results?.[0]?.value ?? 0) };
}

async function readStats(env, now) {
  if (statsCache && now - statsCache.at < STATS_CACHE_MS) return statsCache.stats;
  const since = hourStart(now) - (WINDOW_HOURS - 1) * HOUR_MS;
  // Summed here: D1 bills GROUP BY and ORDER BY as extra passes over the rows read.
  const [totalResult, hourlyResult] = await env.DB.batch([
    env.DB.prepare("SELECT value FROM counters WHERE name = 'total_visits'"),
    env.DB.prepare("SELECT country, visits FROM hourly_visits WHERE hour_ms >= ?1").bind(since),
  ]);
  const byCountry = new Map();
  for (const row of hourlyResult.results ?? []) {
    const code = String(row.country);
    byCountry.set(code, (byCountry.get(code) ?? 0) + Number(row.visits));
  }
  const countries = sortCountries([...byCountry].map(([code, count]) => ({ code, count })));
  const stats = {
    total_visits: Number(totalResult.results?.[0]?.value ?? 0),
    last24h: { visits: countries.reduce((sum, row) => sum + row.count, 0), countries },
  };
  statsCache = { at: now, stats };
  return stats;
}

/**
 * Add this request's visit to stats (usually the isolate's cached copy) read before it was recorded. Totals
 * only grow, so a read with a total below the new total predates the visit, and a read that already includes
 * it is left alone. The total becomes exact; visits from other isolates show once the cache expires.
 */
function addOwnVisit(stats, { total, country }) {
  if (stats.total_visits >= total) return;
  stats.total_visits = total;
  stats.last24h.visits += 1;
  const row = stats.last24h.countries.find((entry) => entry.code === country);
  if (row) row.count += 1;
  else stats.last24h.countries.push({ code: country, count: 1 });
  sortCountries(stats.last24h.countries);
}

/** Delete the visitor hashes of earlier UTC days and the hourly counts older than HOURLY_RETENTION_HOURS. */
async function cleanup(env, now) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM visits WHERE day < ?1").bind(utcDay(now)),
    env.DB.prepare("DELETE FROM hourly_visits WHERE hour_ms < ?1").bind(hourStart(now) - HOURLY_RETENTION_HOURS * HOUR_MS),
  ]);
}

async function handleHit(request, env, ctx, cors) {
  const noStore = { ...cors, "Cache-Control": "no-store" };
  if (!isAllowedOrigin(env, request.headers.get("Origin"))) {
    return jsonResponse({ error: "origin_not_allowed" }, 403, noStore);
  }
  const salt = String(env.VISITOR_SALT ?? "");
  if (salt.length < MIN_SALT_LENGTH) {
    throw new Error(`VISITOR_SALT is missing or shorter than ${MIN_SALT_LENGTH} characters; run wrangler secret put VISITOR_SALT`);
  }
  const now = Date.now();
  const userAgent = request.headers.get("User-Agent") ?? "";
  const network = networkOf(request.headers.get("CF-Connecting-IP") ?? "");
  let ownVisit = null;
  if (!isBot(userAgent)) {
    if (env.HIT_LIMITER) {
      const { success } = await env.HIT_LIMITER.limit({ key: await sha256Hex(`${salt}\nrate-limit\n${network}`) });
      if (!success) return jsonResponse({ error: "rate_limited" }, 429, { ...noStore, "Retry-After": "60" });
    }
    const day = utcDay(now);
    const visitorHash = await sha256Hex([salt, day, network, userAgent].join("\n"));
    const seenKey = `${day}:${visitorHash}`;
    if (!seenRecently(seenKey, now)) {
      const country = countryCode(request);
      const { counted, total } = await recordVisit(env, { day, visitorHash, country, now });
      rememberVisit(seenKey, now);
      if (counted) ownVisit = { total, country };
    }
    if (lastCleanupDay !== day) {
      lastCleanupDay = day;
      ctx.waitUntil(cleanup(env, now).catch((error) => console.error("visitor counter cleanup failed:", error)));
    }
  }
  const stats = await readStats(env, now);
  if (ownVisit) addOwnVisit(stats, ownVisit);
  return jsonResponse({ counted: ownVisit !== null, ...stats }, 200, noStore);
}

async function handleStats(request, env, ctx, cors) {
  const stats = await readStats(env, Date.now());
  return jsonResponse(stats, 200, { ...cors, "Cache-Control": `public, max-age=${STATS_MAX_AGE_S}` });
}

const ROUTES = new Map([
  ["/hit", new Map([["POST", handleHit]])],
  ["/stats", new Map([["GET", handleStats]])],
]);

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(env, request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const route = ROUTES.get(new URL(request.url).pathname.replace(/\/+$/, ""));
    if (!route) return jsonResponse({ error: "not_found" }, 404, cors);
    const handler = route.get(request.method);
    if (!handler) return jsonResponse({ error: "method_not_allowed" }, 405, { ...cors, Allow: [...route.keys()].join(", ") });
    try {
      return await handler(request, env, ctx, cors);
    } catch (error) {
      // Answer with JSON and CORS headers instead of Cloudflare's error page, so the page can fall back.
      console.error("visitor counter failed:", error);
      return jsonResponse({ error: "server_error" }, 500, { ...cors, "Cache-Control": "no-store" });
    }
  },

  /** Daily Cron Trigger (wrangler.toml [triggers]); a failure is recorded in the Worker's Cron Events. */
  async scheduled(controller, env) {
    await cleanup(env, controller.scheduledTime);
  },
};
