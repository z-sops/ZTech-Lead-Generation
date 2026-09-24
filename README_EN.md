# phone Global Leads

English | [简体中文](README.md)

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

`phone Global Leads` is a desktop tool focused on global lead generation. It helps sales, export, cross-border, local service, and B2B teams collect business leads by keyword, location, language, and filters. The tool can collect landline numbers, mobile numbers, addresses, websites, emails, and other business information, then save the results into a local lead database for filtering, management, and CSV export.

## Core Features

- Global keyword-based lead discovery: search potential customers by industry keywords and target regions.
- Multi-language search: supports English, Chinese, Spanish, French, German, Arabic, Portuguese, Japanese, Korean, and more.
- Business information collection: collect company names, landline numbers, mobile numbers, addresses, websites, and emails.
- Precise filtering: filter by title matching, rating, website availability, and mobile-number-only results.
- Social and detail enrichment: optionally collect Facebook, Instagram, YouTube, TikTok, LinkedIn, web search data, business details, and reviews.
- Landline and mobile lead database: save collected results into a local number database for search, filtering, import, deletion, and CSV export.
- Collection history: review previous collection tasks, check status, and revisit collected results.

## Screenshots

### Keyword Collection

| Keyword Collection |
| --- |
| <img src="img/92374d351f17b3b282208e237b3aa7d9.png" alt="Keyword Collection" width="760"> |

### Collection Results

| Collection Results |
| --- |
| <img src="img/e7b23172b27c3e0bcb4488327ac3078a.png" alt="Collection Results" width="760"> |

## Use Cases

- Export customer development
- Cross-border merchant discovery
- Local service business lead collection
- B2B phone and email lead organization
- Regional market research
- Industry contact list building

## Highlights

- Search target customers by country, city, or region.
- Discover potential merchants in batches by industry keyword.
- Collect both landline numbers and mobile numbers.
- Keep mobile-number-only results for more precise outreach.
- Collect websites and emails for multi-channel follow-up.
- Collect social profiles to help evaluate customer activity.
- Save leads into a local database for unified management.
- Export CSV files for sales teams, support teams, or CRM workflows.

## Deployment and Running

### Requirements

- Node.js 18+
- npm
- Windows desktop environment

### Install Dependencies

```bash
npm install
```

### Run in Development

```bash
npm run dev
```

This starts the local Vite service and opens the Electron desktop window.

### Build the Windows Desktop App

```bash
npm run build
```

The packaged output is generated in the `dist/` directory by default.

If Windows fails to extract the signing tool because of symbolic link permissions, use the directory build command first:

```bash
npx electron-builder --dir --config.win.signAndEditExecutable=false
```

This creates a testable unpacked app under `dist/win-unpacked/`.

## Commercial Authorization and Compliance

- Commercial use, commercial integration, repackaging, SaaS integration, deployment for clients, or customer-facing delivery requires explicit authorization from the author.
- When collecting data with this tool, please comply with the target websites' robots.txt, terms of service, API rules, and rate limits.
- Please follow all applicable laws and regulations in each country or region regarding web crawling, data collection, privacy protection, personal information protection, anti-spam rules, and commercial outreach.
- Users are responsible for confirming the legality of collecting, storing, exporting, and using lead data. Do not use this tool for spam, harassment, fraud, or any illegal activity.

## Contact

Scan the QR code to add WeChat for customization and usage support.

<img src="img/wx.jpg" alt="WeChat Contact" width="280">

## License

This project is licensed under the [Apache License 2.0](LICENSE).
