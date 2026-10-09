# Visitor counter (Cloudflare Worker + D1)

The page footer can show a small line like this:

> 1,234 visits since launch · 37 in the last 24 hours
> 🇺🇸 9 🇩🇪 6 🇮🇳 5 🇨🇳 4 🇬🇧 3 🇫🇷 2 🇦🇺 1 🇧🇷 1 +3 more

The numbers come from the Worker in this folder, which runs on your own Cloudflare account and stores
its counts in a D1 database. The page calls it from `static/js/visitors.js`. While `STATS_ENDPOINT` in
`static/js/config.js` is `null`, the page makes no request and shows nothing. It also shows nothing
whenever the Worker is unreachable or answers with an error.

Files: `wrangler.toml` (Worker configuration, no secrets), `src/index.js` (the Worker, no npm
dependencies), `migrations/0001_init.sql` (D1 schema).

## What is counted

- **A visit** is one browser on one network on one UTC day. Repeat page loads with the same user agent
  from the same network (the IPv4 address, or the /64 prefix of an IPv6 address) on the same UTC day count
  once, so a visitor who stays on one browser and network is counted at most once per UTC day. Someone who
  comes back on another day, or from another network (home, then mobile), counts again. A visit that spans UTC midnight counts twice.
  People who share a network and an identical browser version (an office, conference Wi-Fi) count once
  together. The footer therefore says "visits", not "unique visitors", and its tooltip states the rule.
- **Visits since launch** is the running total of visits.
- **Last 24 hours** counts the visits whose first page load fell in the current UTC hour or in one of the
  23 before it (a window of 23 to 24 hours), by the country Cloudflare derives from the IP address.
  Visits with an unknown location (for example Tor) are in the number but get no flag. The list shows the
  8 largest countries and "+N more" (hover for the rest).
- **Not counted:** crawlers, link previewers, monitors, headless browsers and HTTP libraries (matched on
  the user agent), browsers that report automation (`navigator.webdriver`; they still see the numbers),
  requests from any page other than the allowed origins, and bursts above 60 page loads per minute from one
  network at one Cloudflare location (those visitors still see the numbers).

## What is stored, and what is never stored

Stored in D1:

- `visits`: one row per visit with the UTC day, a hex SHA-256 hash of (secret salt, day, network, user
  agent), the two-letter country code and the time of the first page load. These rows are deleted once
  their UTC day is over: a daily Cron Trigger at 00:05 UTC deletes earlier days, and so does the first
  page load of each new day.
- `hourly_visits`: visit counts per UTC hour and country (aggregates only), kept for 48 hours.
- `counters`: the running total.

Never stored: IP addresses, user agents, cookies or any other identifier in the browser, referrers, page
URLs, or anything that links a visitor across days. The hash changes every day because the day is part of
its input, and the salt is a Worker secret that is in neither this repository nor the database. The
browser sends the hit as a POST without body, cookies or referrer.

D1 keeps a restorable history of every database (Time Travel, always on): deleted `visits` rows can be
restored by the account owner for 7 days on the Workers Free plan and 30 days on Workers Paid. They are
still only salted daily hashes.

Request logs: Workers Logs is on by default for new Workers and would keep every request's headers (which
carry the IP address) for 3 to 7 days, so `wrangler.toml` turns it off. `npx wrangler tail` shows live
requests without storing them. Cloudflare itself, like GitHub Pages, necessarily handles each visitor's IP
address to answer the request.

## Why not a hosted counter

Hosted counters and analytics beacons are blocked by the default lists of common ad blockers, so their
numbers miss a large part of a technical audience and their widgets disappear. On 2026-10-02 the network
filters of EasyList, EasyPrivacy, the uBlock Origin lists (filters, badware, privacy, quick fixes,
unbreak), AdGuard Base, AdGuard Tracking Protection, Peter Lowe's list and Fanboy's Annoyance list blocked
StatCounter (`||statcounter.com^$third-party`), ClustrMaps, GoatCounter, Flag Counter, RevolverMaps,
Plausible, counter.dev and Cloudflare Web Analytics (`||cloudflareinsights.com^$third-party`,
`/beacon.min.js`). MapMyVisitors' script and image were not matched by these lists on that date.

The requests of this counter, `POST /hit` and `GET /stats` from `honeycomb-surfels.github.io` to
`honeycomb-surfels-visitors.<subdomain>.workers.dev` as `fetch()` calls, matched no network filter in those
lists, and none of their 41,468 generic element-hiding rules matched the rendered footer line. Scope of
that check: a filter matcher written for the test, not the extensions themselves; it does not cover DNS
blocklists (Pi-hole, NextDNS), Brave's own lists or later list updates. Two choices keep it that way:
`navigator.sendBeacon` is not used, because EasyPrivacy blocks every third-party beacon
(`*$ping,third-party`), and the Worker name and paths avoid analytics words (EasyPrivacy blocks, for
example, `||workers.dev/api/event`). Keep the name and the `/hit` and `/stats` paths when you deploy.

## Deploy (once)

You need a Cloudflare account (the free plan is enough) and Node.js 22 or later. Run the commands from
this `stats/` folder of the page repository; `npx wrangler` downloads Wrangler on first use (or install it
with `npm i -g wrangler` and drop the `npx`).

```bash
cd stats

# 1. Log in (opens a browser). npx wrangler whoami shows whether you already are.
npx wrangler login

# 2. Create the database. It prints a snippet with database_id = "...": paste that value into
#    wrangler.toml in place of REPLACE_WITH_DATABASE_ID_FROM_WRANGLER_D1_CREATE.
npx wrangler d1 create honeycomb_surfels_visitors

# 3. Create the tables in the remote database (answer y to the prompt).
npx wrangler d1 migrations apply honeycomb_surfels_visitors --remote

# 4. Deploy. The output ends with the Worker URL, https://honeycomb-surfels-visitors.<subdomain>.workers.dev
npx wrangler deploy

# 5. Set the hash salt, a random secret that never leaves Cloudflare (this redeploys the Worker).
openssl rand -hex 32 | npx wrangler secret put VISITOR_SALT

# 6. Check: the first call returns zeros, the second counts one visit (your own test visit).
curl -s https://honeycomb-surfels-visitors.<subdomain>.workers.dev/stats
curl -s -X POST -H "Origin: https://honeycomb-surfels.github.io" -A "Mozilla/5.0 (deploy check)" \
  https://honeycomb-surfels-visitors.<subdomain>.workers.dev/hit
```

Then switch the footer on: in `static/js/config.js` set

```js
STATS_ENDPOINT: "https://honeycomb-surfels-visitors.<subdomain>.workers.dev",
```

(no trailing slash), commit and push the page. GitHub Pages redeploys it within a minute or two.

Notes:

- `ALLOWED_ORIGINS` in `wrangler.toml` lists the page origins that may count visits and read the numbers
  from a browser: the public site plus `http://localhost:8000` and `http://127.0.0.1:8000` for local
  previews (`python -m http.server 8000`). Local previews therefore count like any other visit; delete the
  two localhost entries and run `npx wrangler deploy` again if they should not. If the page moves to a
  custom domain, add that origin.
- The Workers Free plan allows 5 Cron Triggers per account. If `wrangler deploy` reports that the limit is
  reached, delete the `[triggers]` block: the Worker then deletes earlier days' hashes on the first page load
  of each day only, so after a day without visitors they stay until the next visit.
- The `[[ratelimits]]` block needs Wrangler 4.36.0 or later. Its `namespace_id` must not be used by
  another rate limiter in your account; change it if it is.
- To test locally first: put `VISITOR_SALT="<any 32+ characters>"` into `stats/.dev.vars` (ignored by
  git), run `npx wrangler d1 migrations apply honeycomb_surfels_visitors --local` and `npx wrangler dev`,
  and set `STATS_ENDPOINT` to `http://localhost:8787` while previewing the page on port 8000.

## API

- `POST /hit` counts the page load (at most once per visit) and answers
  `{"counted": true|false, "total_visits": n, "last24h": {"visits": n, "countries": [{"code": "US", "count": n}, ...]}}`.
  It answers 403 for a missing or foreign `Origin`, 429 when rate limited, 500 on a server error (for
  example a missing `VISITOR_SALT`).
- `GET /stats` answers the same numbers without `counted` and without counting. Browsers may cache it for
  60 seconds, and each Worker instance reads the numbers from D1 at most once a minute (a counted visit is
  added to that copy, so visitors always see their own visit).

## View, reset, remove

```bash
# Totals and the last 48 hours of hourly counts
npx wrangler d1 execute honeycomb_surfels_visitors --remote --command \
  "SELECT * FROM counters; SELECT datetime(hour_ms / 1000, 'unixepoch') AS hour_utc, country, visits FROM hourly_visits ORDER BY hour_ms DESC, visits DESC;"

# Reset everything to zero
npx wrangler d1 execute honeycomb_surfels_visitors --remote --command \
  "UPDATE counters SET value = 0; DELETE FROM hourly_visits; DELETE FROM visits;"

# Watch requests and errors live (nothing is stored)
npx wrangler tail
```

To turn the counter off, set `STATS_ENDPOINT` back to `null` and push the page. To remove it completely,
also run `npx wrangler delete` and `npx wrangler d1 delete honeycomb_surfels_visitors`.

## Free plan limits

Workers Free allows 100,000 requests a day (each page view makes one) and 10 ms of CPU time per request;
this Worker needs about 0.1 ms. D1 on the free plan allows 5 million rows read and 100,000 rows written a
day for the whole account, and 500 MB per database. Measured on a local D1:

| Operation | Rows read | Rows written |
| --- | --- | --- |
| New visit | 3 to 4 | 4 to 5 |
| Repeat page load (when it reaches D1) | 4 | 0 |
| Refreshing the numbers (at most once a minute per Worker instance) | 1 + one per (hour, country) pair in the last 24 hours | 0 |
| Daily cleanup | about 1 per deleted row (2 when nothing is deleted) | 1 per deleted row |

With the later deletion of its row, a visit costs about 6 rows written, so writes cap the free plan at
roughly 15,000 visits a day, far above what a research project page sees; the stored data stays tiny
because visit rows are deleted daily. The daily limits are shared by every D1 database in the account: if
they are ever reached, D1 refuses queries until 00:00 UTC for all of them, the footer line disappears until
then, and visits are not counted in the meantime. Workers Paid includes far higher limits.
