# Contact enrichment: emails, owners, Instagram, Google reviews

A research result now says, for each business, **how to reach it and who runs
it**, and every item says where it came from.

| What | Where it comes from | Needs | Cost |
|---|---|---|---|
| Emails, phones, social links | The business's own website (home page + one contact page, robots.txt obeyed) and its OpenStreetMap listing | nothing | free |
| Owners (UK) | Companies House public register: company + active directors | `COMPANIES_HOUSE_API_KEY` | free (600 requests / 5 min) |
| Instagram activity | Meta Instagram Business Discovery API: followers, posts, last post date | `ZTECH_IG_ACCESS_TOKEN`, `ZTECH_IG_USER_ID` | free (Meta rate limits) |
| Google rating & reviews | Google Places API (New), live, on button press | `GOOGLE_PLACES_API_KEY` (API server) | first 1,000 a month free, then about $40 per 1,000 presses |

Without a key the feature is simply off; nothing else changes.

## Emails, phones and social links

- Read from `mailto:` and `tel:` links, emails written in the page text, and
  links to Instagram, Facebook, LinkedIn company pages, TikTok, X and YouTube.
- Post, reel, share and "intent" links are skipped; image names such as
  `logo@2x.png` and placeholder domains (`example.com`, etc.) are not emails.
- Each email is labelled **role** (`info@`, `reception@`, `hello@`...) or
  **person** (`sarah.khan@`), and whether it is on the website's own domain.
- **UK PECR:** a person's address may belong to a sole trader or partnership,
  who must have agreed before marketing email. The UI says so next to any
  person address. Role addresses of limited companies are the safer target.
- The website inspection still makes at most 5 requests per site.

## Owners (Companies House)

- Only searched when the listing has a UK postcode.
- A company is used **only** when the name overlaps and the postcode is the
  same (or the name is close and the postcode area is the same). Dissolved
  companies are ignored. A weak match is reported as "no match", never guessed.
- Owners = active directors, LLP members and partners (max 5). Resigned
  officers and corporate secretaries are left out.
- The UI links the company's public Companies House page and says how it was
  matched. Sole traders and most partnerships are not on the register.

Get a key: <https://developer.company-information.service.gov.uk/> → register
→ create an application → "REST" API key.

## Instagram

- Only for the handle the business itself links to (website or listing).
- Works for business/creator accounts; a personal account returns "not a
  business account" and nothing more.
- No post for 90 days becomes the finding **Instagram not updated for months**
  (service: Social media management), with the profile link and the last post
  date as evidence.

Set up: a Meta app at <https://developers.facebook.com/apps/>, an Instagram
professional account linked to a Facebook Page, then a long-lived token with
`instagram_basic` + `pages_read_engagement`. `ZTECH_IG_USER_ID` is that
Instagram account's id.

## Google rating & reviews

- Google allows Places content to be shown, **not stored**. So it is fetched
  live when someone presses **Google rating & reviews** on a business card,
  shown with "Source: Google Maps", each reviewer's name linked to their
  profile and a link to the place on Google Maps, and **never written to the
  database**.
- POST with CSRF (it costs money, so a link on another site cannot trigger it)
  and limited to 60 presses per workspace per hour.
- If Google's closest listing has a different name, it is reported as not
  found rather than shown as this business.

Get a key: <https://console.cloud.google.com/> → enable **Places API (New)** →
Credentials → API key; restrict it to Places API (New).

## Environment

Worker:

```
COMPANIES_HOUSE_API_KEY=...
ZTECH_IG_ACCESS_TOKEN=...
ZTECH_IG_USER_ID=...
```

API server:

```
GOOGLE_PLACES_API_KEY=...
```

Keys travel in request headers only and never appear in results or logs.

## Tests

`tests/lead-intelligence/contact-enrichment.test.js`, the Google part of
`tests/api/phase2-research-api.test.js` and the research-jobs browser E2E.
Companies House and Instagram are played by the local fixture server
(`ch.ztech-fixture.com`, `graph.ztech-fixture.com`) and Google by an injected
fake: no test reaches the internet or a paid API.
