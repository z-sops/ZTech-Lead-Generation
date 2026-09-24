
# ZTech Lead Generation

**ZTech Lead Generation** is a desktop tool developed and licensed by **ZuniTech** for global business lead discovery and organization. It is designed for foreign trade, cross-border services, local services, B2B sales, market research, and channel development scenarios.

By combining keywords, regions, languages, and filter conditions, users can discover business information worldwide — including landline numbers, mobile numbers, addresses, websites, emails, social profiles, and other publicly available business information — and store results in a lead library for filtering, organizing, and exporting.

## Core Capabilities

* **Global keyword lead generation:** Collect potential customers by industry keywords and target regions.
* **Multi-language region search:** Supports English, Chinese, Español, Français, Deutsch, العربية, Português, 日本語, 한국어, and other language configurations.
* **Business information collection:** Retrieves lead fields such as business name, landline, mobile number, address, website, and email.
* **Precision filtering:** Supports title matching, minimum rating, website filtering, mobile-number-only searches, and other filter conditions.
* **Social & detail expansion:** Optionally collects Facebook, Instagram, YouTube, TikTok, LinkedIn, web search, detailed information, reviews, and other available data.
* **Lead storage:** Results can be saved to a lead library with search, filtering, importing, deleting, and CSV export capabilities.
* **Collection history:** View previous collection tasks, track collection status, and review collected results.

## Product Screenshots

### Keyword Collection

| Keyword Collection                                                                        |
| ----------------------------------------------------------------------------------------- |
| <img src="img/92374d351f17b3b282208e237b3aa7d9.png" alt="Keyword collection" width="760"> |

### Collection Results

| Collection Results                                                                        |
| ----------------------------------------------------------------------------------------- |
| <img src="img/e7b23172b27c3e0bcb4488327ac3078a.png" alt="Collection results" width="760"> |

## Use Cases

* Foreign trade customer development
* Finding businesses for cross-border commerce
* Local service provider lead collection
* B2B phone and email lead organization
* Regional market research
* Industry list building
* Channel partner discovery
* Sales prospecting

## Feature Highlights

* Search target customers by country, city, and region.
* Bulk-discover potential businesses by industry keyword.
* Covers both landline and mobile number leads.
* Option to keep only mobile numbers for more precise lead targeting.
* Collects websites and emails for multi-channel sales workflows.
* Collects social profiles to help assess business presence and activity.
* Saves results to a centralized lead library.
* Export lead data to CSV for sales teams, support teams, or CRM workflows.

## Deployment & Running

### Environment Requirements

* Node.js 18+
* npm
* Windows desktop environment

### Install Dependencies

```bash
npm install
```

### Run in Development

```bash
npm run dev
```

After running, a local Vite service starts automatically and launches the Electron desktop window.

### Build Windows Desktop Version

```bash
npm run build
```

Build output goes to the `dist/` directory by default.

If your Windows environment encounters symlink permission issues while extracting the signing tool, you can verify with a directory-package build first:

```bash
npx electron-builder --dir --config.win.signAndEditExecutable=false
```

This command generates a directly testable `dist/win-unpacked/` directory package.

---

# License

## Proprietary Software — ZuniTech

**Copyright © 2026 ZuniTech. All rights reserved.**

ZTech Lead Generation is proprietary software owned and controlled by **ZuniTech**.

This repository may be made available publicly for development, evaluation, collaboration, or source-code inspection, but **public availability does not mean that the software is open source or that commercial rights are granted**.

Unless ZuniTech provides written authorization, you may **not**:

* Sell, resell, sublicense, rent, lease, or redistribute the software.
* Use the software as a commercial service or paid lead-generation service.
* Repackage or white-label the software for clients or third parties.
* Integrate the software into another commercial product or SaaS platform.
* Distribute modified or derivative versions commercially.
* Remove, alter, or obscure ZuniTech copyright, branding, license, or attribution notices.
* Use ZTech Lead Generation as the underlying engine for a competing commercial product.
* Copy substantial portions of the source code into another commercial product.
* Distribute commercial builds, installers, or modified versions without authorization.

### Commercial Licensing

Commercial use requires a separate license or written authorization from **ZuniTech**.

Commercial use includes, but is not limited to:

* Using the software internally for a revenue-generating business.
* Providing lead-generation services to customers.
* Using the software to create or operate a paid data-generation service.
* Integrating the software into commercial software or SaaS products.
* Rebranding or white-labeling the software.
* Distributing the software to customers, employees, contractors, or third parties as part of a commercial offering.
* Selling collected lead data or providing lead-generation services based on the software.

Commercial licensing terms, permitted usage, number of installations, distribution rights, support, updates, and other conditions are determined by a separate agreement with ZuniTech.

### Development and Evaluation

Subject to the terms above, the repository may be accessed and used for development, testing, evaluation, and other non-commercial purposes.

Any use beyond those permissions requires prior written authorization from ZuniTech.

### Third-Party Components

ZTech Lead Generation may use third-party libraries, frameworks, APIs, services, and other components that are governed by their respective licenses and terms.

Those third-party licenses remain applicable to their respective components and are not replaced by this proprietary license.

### Data Collection & Compliance

When collecting data with ZTech Lead Generation, users are responsible for complying with:

* Applicable laws and regulations.
* Website terms of service.
* API terms and usage policies.
* Robots.txt directives where applicable.
* Rate limits and technical restrictions.
* Privacy and data-protection requirements.
* Personal-information and consumer-protection laws.
* Anti-spam and electronic-communications regulations.

Users are solely responsible for determining whether their intended collection, storage, processing, export, and use of lead information is lawful.

The software must not be used for fraud, harassment, unlawful surveillance, spam, abuse, or other illegal activities.

### No Warranty

ZTech Lead Generation is provided subject to the terms of the applicable license agreement. ZuniTech makes no guarantee that data collected through third-party websites, APIs, search engines, or other external services will be complete, accurate, current, or continuously available.

Users are responsible for validating collected information before relying on it for business, legal, financial, or other consequential purposes.

---

## Ownership

**Product:** ZTech Lead Generation
**Owner / Licensor:** ZuniTech
**License:** Proprietary / Commercial License
**Copyright:** © 2026 ZuniTech. All rights reserved.

For commercial licensing, redistribution, white-label arrangements, integrations, or other commercial use, contact **ZuniTech** for authorization.

---

## Disclaimer

ZTech Lead Generation is a software tool for business lead discovery and organization. ZuniTech does not authorize or encourage users to violate third-party terms of service, privacy laws, data-protection regulations, or applicable telecommunications and marketing laws.

Users are solely responsible for how they configure, operate, and use the software and for the data they collect and process.
