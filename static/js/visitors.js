/**
 * Footer visitor counter for the Honeycomb-Surfels project page.
 *
 * window.HEXELS_CONFIG.STATS_ENDPOINT is the URL of the counter Worker in stats/ (see stats/README.md),
 * for example "https://honeycomb-surfels-visitors.<subdomain>.workers.dev". While it is null, empty or
 * missing, nothing is requested or rendered; the same holds whenever the Worker cannot be reached or
 * answers with anything unexpected.
 *
 * Otherwise the page load sends one POST /hit, and the totals the Worker returns are rendered into
 * #visitors-root: visits since launch and the visits of the last 24 hours by country. A visit is one browser
 * on one network on one UTC day, so a visitor counts at most once per day (see stats/README.md). The hit is a
 * fetch() with keepalive and without body, cookies or referrer, so it is a simple CORS request.
 * navigator.sendBeacon is not used: EasyPrivacy, which uBlock Origin and Brave enable by default, blocks every
 * third-party beacon ("*$ping,third-party"). Automated browsers (navigator.webdriver) are not counted and a
 * prerendered page waits until it is shown; automated browsers and rejected hits (for example the Worker's
 * rate limit) read GET /stats instead.
 */

const ROOT_ID = "visitors-root";
const MAX_COUNTRIES = 8;
const REQUEST_TIMEOUT_MS = 8000;
const UNKNOWN_COUNTRY = "XX";
const COUNTRY_CODE = /^[A-Z]{2}$/;
// Keep in sync with .hx-visitors-flag in static/css/visitors.css. Twemoji Mozilla (bundled with Firefox)
// precedes Segoe UI Emoji, which draws flags as letters, so that Firefox on Windows shows flags.
const EMOJI_FONTS = '"Apple Color Emoji", "Noto Color Emoji", "Twemoji Mozilla", "Segoe UI Emoji", sans-serif';
const NOTE =
  "Each visitor is counted at most once per UTC day (per browser and network). " +
  "The counter sets no cookies and stores no IP addresses.";

const numbers = new Intl.NumberFormat("en-US");
const regionNames = typeof Intl.DisplayNames === "function" ? new Intl.DisplayNames(["en"], { type: "region" }) : null;
let flagSupport = null;

function statsEndpoint() {
  const value = window.HEXELS_CONFIG?.STATS_ENDPOINT;
  if (typeof value !== "string" || !value.trim()) return null;
  const endpoint = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]/i.test(endpoint)) {
    console.warn(`Visitor counter: STATS_ENDPOINT must be an http(s) URL, got "${value}"`);
    return null;
  }
  return endpoint;
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Validate a Worker response; returns null unless it has the expected shape. */
function parseStats(data) {
  const last24h = data?.last24h;
  if (!isCount(data?.total_visits) || !isCount(last24h?.visits) || !Array.isArray(last24h?.countries)) return null;
  const countries = [];
  for (const row of last24h.countries) {
    if (typeof row?.code !== "string" || !COUNTRY_CODE.test(row.code) || !isCount(row.count) || row.count === 0) return null;
    countries.push({ code: row.code, count: row.count });
  }
  countries.sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : 1));
  return { total: data.total_visits, visits: last24h.visits, countries };
}

/** One request to the Worker; returns the parsed stats, or null (logged) on any failure. */
async function requestStats(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      mode: "cors",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      priority: "low",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const stats = parseStats(await response.json());
    if (!stats) throw new Error("unexpected response");
    return stats;
  } catch (error) {
    // Expected when the Worker is down, blocked or rate limited: the footer then shows no counter.
    console.warn(`Visitor counter: ${init.method} ${url} failed (${error.message})`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function plural(count, singular, pluralForm) {
  return `${numbers.format(count)} ${count === 1 ? singular : pluralForm}`;
}

function countryName(code) {
  return regionNames?.of(code) ?? code;
}

function flagEmoji(code) {
  return String.fromCodePoint(...Array.from(code, (letter) => 0x1f1e6 + letter.charCodeAt(0) - 65));
}

/**
 * True when the browser draws flag emoji in colour. Windows draws them as two letters, so the list then
 * shows ISO codes instead. Black text has no colour, so coloured pixels mean a colour flag glyph.
 */
function supportsFlagEmoji() {
  if (flagSupport !== null) return flagSupport;
  flagSupport = false;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 48;
    canvas.height = 32;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return flagSupport;
    context.font = `28px ${EMOJI_FONTS}`;
    context.textBaseline = "top";
    context.fillStyle = "#000";
    context.fillText(flagEmoji("FR"), 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let colored = 0;
    for (let i = 0; i < data.length; i += 4) {
      const spread = Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]);
      if (data[i + 3] > 128 && spread > 64) colored += 1;
    }
    flagSupport = colored >= 16;
  } catch (error) {
    // Some anti-fingerprinting settings block canvas reads; the ISO codes are readable everywhere.
    console.warn(`Visitor counter: flag emoji check failed (${error.message}); showing country codes`);
  }
  return flagSupport;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function summaryText(stats) {
  let text = `${plural(stats.total, "visit", "visits")} since launch`;
  if (stats.visits > 0) text += ` · ${numbers.format(stats.visits)} in the last 24 hours`;
  return text;
}

function countryItem({ code, count }, showFlags) {
  const name = countryName(code);
  const item = element("li", "hx-visitors-country");
  item.title = `${name}: ${plural(count, "visit", "visits")} in the last 24 hours`;
  const mark = showFlags ? element("span", "hx-visitors-flag", flagEmoji(code)) : element("span", "hx-visitors-code", code);
  mark.setAttribute("aria-hidden", "true");
  item.append(mark, element("span", "hx-visitors-sr", `${name}:`), element("span", "hx-visitors-n", numbers.format(count)));
  return item;
}

function countryList(countries) {
  const showFlags = supportsFlagEmoji();
  const list = element("ul", "hx-visitors-countries");
  list.setAttribute("aria-label", "Visits in the last 24 hours by country");
  list.append(...countries.slice(0, MAX_COUNTRIES).map((country) => countryItem(country, showFlags)));
  const rest = countries.slice(MAX_COUNTRIES);
  if (rest.length > 0) {
    const more = element("li", "hx-visitors-more", `+${rest.length} more`);
    more.title = rest.map(({ code, count }) => `${countryName(code)}: ${numbers.format(count)}`).join("\n");
    list.append(more);
  }
  return list;
}

function render(root, stats) {
  // Visits from unknown locations ("XX") count in the totals but get no entry in the country list.
  const known = stats.countries.filter((country) => country.code !== UNKNOWN_COUNTRY);
  const box = element("div", "hx-visitors");
  box.title = NOTE;
  box.append(element("p", "hx-visitors-summary", summaryText(stats)));
  if (known.length > 0) box.append(countryList(known));
  root.replaceChildren(box);
  root.hidden = false;
}

async function showVisitors() {
  const endpoint = statsEndpoint();
  const root = document.getElementById(ROOT_ID);
  // The mark keeps a second copy of this script (for example under another URL) from counting again.
  if (!endpoint || !root || root.dataset.hxVisitors) return;
  root.dataset.hxVisitors = "started";
  const counted = navigator.webdriver ? null : await requestStats(`${endpoint}/hit`, { method: "POST", keepalive: true });
  const stats = counted ?? (await requestStats(`${endpoint}/stats`, { method: "GET" }));
  if (stats) render(root, stats);
}

/**
 * GoatCounter (https://www.goatcounter.com) counts page views for the authors' own dashboard (countries, pages,
 * referrers over any date range); nothing is shown on the page. window.HEXELS_CONFIG.GOATCOUNTER_URL is the site's
 * count endpoint, for example "https://<code>.goatcounter.com/count"; while it is null nothing loads. Local
 * previews and automated browsers are not counted, and GoatCounter sets no cookies.
 */
function loadGoatCounter() {
  const value = window.HEXELS_CONFIG?.GOATCOUNTER_URL;
  if (typeof value !== "string" || !value.trim()) return;
  const url = value.trim();
  if (!/^https:\/\/[^/]+\/count$/i.test(url)) {
    console.warn(`GoatCounter: GOATCOUNTER_URL must look like https://<code>.goatcounter.com/count, got "${value}"`);
    return;
  }
  const local = ["localhost", "127.0.0.1", ""].includes(location.hostname) || location.protocol === "file:";
  if (local || navigator.webdriver || document.querySelector("script[data-goatcounter]")) return;
  const script = document.createElement("script");
  script.async = true;
  script.dataset.goatcounter = url;
  script.src = "https://gc.zgo.at/count.js";
  document.head.append(script);
}

if (document.prerendering) {
  document.addEventListener(
    "prerenderingchange",
    () => {
      showVisitors();
      loadGoatCounter();
    },
    { once: true },
  );
} else {
  showVisitors();
  loadGoatCounter();
}
