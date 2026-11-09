# Competitor Ads — Meta Ads connector + weekly report

Owner request, 9 Nov 2026: a bot that watches which companies run Meta
(Facebook/Instagram) ads, how, and week by week, for agency work.

## The two parts

1. **The connector** — `packages/meta-ads-mcp`, a separate MCP server. It
   reads one advertiser's ads in one country and returns them in one clean
   shape. It stores nothing. It can be used by ZTech, and by Claude or any
   other MCP client.
2. **ZTech** — the "Competitor Ads" page. You add a competitor (Facebook page
   name + country); the worker checks it through the connector every week; the
   page shows what is new, what stopped, what keeps running, the buttons
   (CTA), platforms and formats, and a trend of running ads.

## What can and cannot be known

- Known: the ads, their text and button, platforms, format, when each started
  and stopped, how many versions; spend and reach only where Meta publishes them
  (political ads; EU/UK reach).
- **Not known: whether a competitor's ad brings leads.** Meta does not publish
  that for anyone. The page marks an ad still running after 21 days as
  "likely working" — a signal with a stated rule, not a result.
- Your own clients' real leads and cost per lead come from their own ad
  account (Meta Marketing API, with their permission) — a later step.

## Data sources (in the connector)

- **Meta Ad Library API (official, free):** all ads delivered in the EU/UK, and
  political/issue ads everywhere. Ordinary business ads that ran only in
  Pakistan or the US are not returned. Needs `META_ACCESS_TOKEN`.
- **Apify Ad Library scraper (paid):** every country, as the public Ad Library
  shows it. Default actor `good-apis/facebook-ads-scraper`, listed at $0.75 per
  1,000 ads (Nov 2026). Uses no Facebook login of yours. Needs `APIFY_TOKEN`.
- `auto` picks the official API for EU/UK and the scraper elsewhere.
- Never put your own Facebook login into any scraper: that account can be
  restricted.

## Setting it up (owner)

1. Apify: sign up at https://console.apify.com/sign-up and copy the API token
   from https://console.apify.com/settings/integrations.
2. (Optional, for UK/EU) Meta: create an app at https://developers.facebook.com/apps,
   confirm your identity at https://www.facebook.com/ID, and generate a user
   access token for the Ad Library API.
3. Start the connector (on your PC or the VPS):

   ```powershell
   $env:META_ADS_MCP_TOKEN = "<a long random secret, 24+ characters>"
   $env:APIFY_TOKEN = "<your Apify token>"
   # $env:META_ACCESS_TOKEN = "<optional Meta token>"
   node packages/meta-ads-mcp/src/server.js
   ```

   It listens on http://127.0.0.1:8787/mcp. On the VPS put it behind HTTPS
   (e.g. https://ads.zunitech.ai/mcp) — the worker refuses plain http except
   on localhost.
4. Tell the worker where it is, in the same terminal as `start-dev.ps1`:

   ```powershell
   $env:ZTECH_ADS_MCP_URL = "http://127.0.0.1:8787/mcp"
   $env:ZTECH_ADS_MCP_TOKEN = "<the same secret as META_ADS_MCP_TOKEN>"
   ```

5. In ZTech: **Competitor Ads** → page name + country → Start watching.

## Weekly checks

A check is queued when a watch is created, on "Check now" (one per watch per
hour; 20 manual checks per workspace per hour), and whenever someone with
write access opens the page and the last check is 7+ days old — at most one
per watch per ISO week. (An automatic timer that needs nobody to open the page
is a later step.) Each check fetches up to 200 ads.

## Safety and isolation

- The connector requires a bearer token on every request and stores and logs
  no query, token or ad text. Meta's token travels in a header and is redacted
  from snapshot links.
- Watches live in `li_competitor_watches` (migration 024): RLS enabled and
  forced, in the startup role check; the worker has no access. Check results
  are research-queue job results, read through the workspace-scoped function.

## Tests

- `tests/lead-intelligence/meta-ads-connector.test.js`: normalising, both
  sources' requests and errors, token handling, source choice, the MCP server's
  auth and tools, the week-against-week rules.
- `tests/api/competitor-ads.test.js`: the whole flow through the real MCP
  server, in memory and on PostgreSQL 16 (weekly scheduling, report,
  isolation, archive).
