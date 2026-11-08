# Phase 2 — Real Business Opportunity Intelligence

Phase 2 replaces the synthetic research of the M5 slice with real research:
**real businesses → their websites inspected → evidence → needs → score →
ranked opportunities → a human-reviewed proposal draft.** It covers P03,
P04, P05, P06, P07, P08 and P15.

Owner approval: given in conversation on 9 Nov 2026 ("Phase 2 ko complete
karo"). The non-negotiable gates still hold: nothing is sent to anyone, no
paid provider is called unless the owner configures one, and no production
system is touched.

## How a research job runs

1. **Criteria** (`packages/lead-intelligence/src/intel/criteria.js`). The
   customer picks an industry from a fixed list (each maps to exact
   OpenStreetMap tags), a location, the services they sell, a website filter
   and 1–25 businesses. The API validates them (400 `invalid_criteria` with
   the field) and stores only the normalised criteria. The worker validates
   them again.
2. **Discovery — P03** (`intel/discovery.js`). One Nominatim request turns
   the location into an area; one Overpass request lists the named
   businesses with the industry's tags in it. Each business is a real OSM
   object with its URL (`source_url`), the time it was retrieved, and the
   ODbL attribution. Unnamed objects are dropped; duplicates (same website,
   or same name and address) are merged; the selection is deterministic.
   Failures are explicit: `location_not_found`, `provider_rate_limited`,
   `provider_unreachable`, `provider_error`.
3. **Inspection — P04** (`intel/inspector.js`, `intel/checks.js`). At most
   five requests per website: robots.txt, the page, one retry over the other
   scheme, the sitemap. **robots.txt is obeyed** (RFC 9309; a 5xx robots.txt
   means "do not inspect"). Checks: HTTPS, HTTP→HTTPS redirect, mixed
   content, response time, noindex, title, meta description, H1, viewport,
   structured data, contact path, online booking (for industries where
   booking matters), image alt text, copyright year, sitemap.
4. **Evidence — P07.** Every finding carries evidence: the page URL, the
   method, a quoted or summarised observation, and the time. A page that
   cannot be read (not HTML, built only by scripts) is *not judged*; a note
   says so. A business with no website gets a `NO_WEBSITE` finding whose
   evidence is the listing itself.
5. **Needs — P05** (`intel/scoring.js`). Findings are grouped by the service
   that fixes them. A need lists the business problem, its findings and
   evidence, its caveats, and whether it is one of the customer's services.
6. **Score — P06**, below.
7. **Proposal — P08** (`intel/proposal.js`), below.
8. **Dashboard — P15** (`src/saas-client`): summary figures, a chart of
   needs by service, filters (minimum score, service, website, name), saved
   filters (kept in the browser), and for each business the score factors,
   the needs, each finding with its confidence and caveat, and each piece of
   evidence linking to the page it came from.

The result is written by the worker into the job (`li.write_job_result`, under
its job-scoped authority) and read by the customer through
`li.get_research_job_result` (migration 022), which returns only jobs of the
workspace in scope and only the result of a **succeeded** job.

## Accuracy: confidence, caveats and the false-positive gate

Each check has a fixed, conservative confidence and, where one observation
can mislead, a caveat that travels with the finding into the proposal:

- 0.95 noindex · 0.9 missing title · 0.85 no working HTTPS, mixed content,
  missing meta description, missing viewport · 0.8 HTTP not redirected,
  images without alt text · 0.7 site error, no H1, no structured data, no
  sitemap · 0.6 no website listed, site did not respond, no contact path ·
  0.55 old copyright year · 0.5 slow response (one sample), no online booking.

**Evaluation dataset.** `tests/fixtures/phase2-sites` holds nine labelled
businesses and their websites (a well-built site, a poor one, a mixed-content
and noindex site, a site that forbids robots, a script-only site, a broken
site, a site that is down, a business with no website, a site without the
HTTPS redirect). `tests/lead-intelligence/intel-phase2.test.js` runs the real
pipeline over them through the real network guard and requires **precision
1.0 and recall 1.0**: any finding not in the labels fails the build. Add a
labelled site whenever a check changes.

**False-positive rules** (in `checks.js`): a check reports only what it
observed; "could not tell" is never reported as "missing"; content checks
need a readable HTML page with at least 80 characters of text.

## Scoring

Score 0–100 = 35% evidence quality (mean confidence of the matching needs) +
30% fit (1 matching service 0.5, 2 → 0.8, 3+ → 1) + 20% urgency (most severe
matching need: high 1, medium 0.6, low 0.3) + 15% listing completeness
(phone, website, address, opening hours). If evidence quality is below 0.6
the score is multiplied by 0.7. No matching need → score 0. Ties: name, then
id. Every factor is returned with the score and shown under "Why this score".

## Proposal drafts

`POST /api/workspaces/:ws/research/jobs/:job/proposals` with
`{ opportunity_id, offer: { sender_name, sender_company, offer_summary,
call_to_action }, use_ai }`.

- The draft uses the (at most) three most important needs. Facts (what was
  observed, with evidence id, page and time) and inferences (what it may
  mean, with caveats) are kept apart.
- `can_send` is always `false`; the status is `draft_requires_human_review`.
  There is no send endpoint. The person copies the draft into their own email.
- No draft is made for a business without an evidenced need that matches the
  customer's services (409 `no_matching_need`).
- **AI drafts (optional):** set `GEMINI_API_KEY` and `ZTECH_LLM_MODEL` (the
  model id exactly as Google lists it). Use a **paid** Google AI project: the
  free tier may use prompts to improve Google's products, and these prompts
  contain your customers' research. The model only rewrites the given facts;
  its draft is rejected (and the template draft shown, with the reason) if it
  cites evidence that does not exist or mentions a web address that is not in
  the evidence. 30 AI drafts per workspace per hour; every draft is audited.

## Network safety (the worker)

`packages/lead-intelligence-worker/src/safeFetch.js`: http/https on ports
80/443 only; the address actually connected to is checked, and private,
loopback, link-local, CGNAT, multicast and reserved addresses are refused
(also after every redirect); at most 5 redirects; a whole-request deadline
(10 s for websites, 40 s for the map APIs); at most 1.5 MiB per page; no
credentials in URLs; an honest User-Agent.

Configuration:

- `ZTECH_RESEARCH_USER_AGENT` (default `ZTechResearchBot/1.0
  (+https://zunitech.ai/bot)`): **publish a short page at that address**
  saying what the bot does and how to contact you, before real use.
- `ZTECH_RESEARCH_CONCURRENCY` 1–5 (default 3).
- `ZTECH_NOMINATIM_URL`, `ZTECH_OVERPASS_URL`: other instances.
- Test-only, refused in production: `ZTECH_INSPECT_ALLOW_PRIVATE=1`,
  `ZTECH_INSPECT_HOST_MAP`.

## Data sources and their rules

- **OpenStreetMap** data is ODbL: show the attribution (the dashboard does).
- **Nominatim** public server: at most 1 request per second, an identifying
  User-Agent, no bulk use. One request per job is well within this; for many
  customers, run your own Nominatim or use a commercial geocoder
  (`ZTECH_NOMINATIM_URL`).
- **Overpass** public server: fair use. For many customers, self-host or use
  a paid instance (`ZTECH_OVERPASS_URL`).
- **Google Places was not used.** It is charged per request and its terms do
  not allow storing the results, which a research history must do.
- OSM coverage of websites and phone numbers varies by city. A business
  without a website in OSM may still have one: that is why `NO_WEBSITE` has
  confidence 0.6 and a caveat.

## What remains for acceptance (owner)

The roadmap gate needs *actual company identities and evidence verified*.
That needs the internet, which the build machine does not have. On your PC,
after Phase 1 runs:

1. Start the API and the worker (`.\scripts\start-dev.ps1`).
2. Research jobs → choose an industry, a city you know, your services, 5
   businesses → Start research.
3. When it finishes, open the results and check 3 businesses by hand: does
   the OSM link show the business, does its website show what the findings
   say?
4. Write down any finding that is wrong. Each one becomes a new labelled site
   in the evaluation dataset and a fix.
