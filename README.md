</p>

<h1 align="center">GEO-Ready Website</h1>

<p align="center">
  <strong>GEO-Ready Website is an AI-driven tool built on top of Scrapeless that enables automated monitoring and auditing of websites for geo-specific indexing and local SEO readiness.</strong><br/>
</p>

  <p align="center">
    <a href="https://www.youtube.com/@Scrapeless" target="_blank">
      <img src="https://img.shields.io/badge/Follow%20on%20YouTuBe-FF0033?style=for-the-badge&logo=youtube&logoColor=white" alt="Follow on YouTuBe" />
    </a>
    <a href="https://discord.com/invite/xBcTfGPjCQ" target="_blank">
      <img src="https://img.shields.io/badge/Join%20our%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Join our Discord" />
    </a>
    <a href="https://x.com/Scrapelessteam" target="_blank">
      <img src="https://img.shields.io/badge/Follow%20us%20on%20X-000000?style=for-the-badge&logo=x&logoColor=white" alt="Follow us on X" />
    </a>
    <a href="https://www.reddit.com/r/Scrapeless" target="_blank">
      <img src="https://img.shields.io/badge/Join%20us%20on%20Reddit-FF4500?style=for-the-badge&logo=reddit&logoColor=white" alt="Join us on Reddit" />
    </a> 
    <a href="https://app.scrapeless.com/passport/register?utm_source=official&utm_term=githubopen" target="_blank">
      <img src="https://img.shields.io/badge/Official%20Website-12A594?style=for-the-badge&logo=google-chrome&logoColor=white" alt="Official Website"/>
    </a>
  </p>

---

## Features

- ✅ **Geo-specific Monitoring**: Check how your website appears in search results from different regions.
- ✅ **Local Indexing Audit**: Detect if your content is properly indexed in target markets.
- ✅ **Automated Reports**: Generate comprehensive SEO and indexing reports.
- ✅ **AI-powered Analysis**: Intelligent insights into GEO readiness and search visibility.
- ✅ **Scrapeless Integration**: Uses Scrapeless cloud browser for accurate rendering and scraping.

---

## Installation

### First, install the SDK

```bash
# Install the official Scrapeless SDK
npm install @scrapeless-ai/sdk
```

### Click [here](https://app.scrapeless.com/passport/register?utm_source=official&utm_term=githubopen) to obtain your API-KEY

```bash
git clone https://github.com/scrapelesshq/GEO-Ready-Website.git
cd GEO-Ready-Website
cp .env.example .env
cd src
npm install
# edit .env and add at least SCRAPELESS_API_KEY=your_api_key_here
```

Important: after configuring ``.env``, you need to edit ``geoaudit.js`` to replace placeholder values:

| Field                 | Description                                                                                     |
|-----------------------|-------------------------------------------------------------------------------------------------|
| `OPENAI_API_KEY`      | Your OpenAI API key. Example: `sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxx`                                 |
| `GENERATE_PDF`        | Whether to generate PDF reports. Set to `1` or `true` to enable, `0` or `false` to disable    |

> **Note:** The `OPENAI_API_KEY` is only required if you want AI-powered analysis or text generation features.

---

## Example Output — GEO Audit Summary

Below is an Example Output exactly matching the plaintext report format your tool produces. After the example I list which parts are AI-dependent and which are base GEO/SEO checks.
At the end there is a placeholder section for the HTML report preview — replace the path with your actual generated HTML file so users can open it in their browser.

---- GEO Audit Summary ----
```
URL: <website_url>
Scanned at: <timestamp>
SEO Score (static): <number>%
GEO Score (calc): <number>%

Top checklist (base checks):
Metadata: Title <✓/✗>, Description <✓/✗>
JSON-LD count: <number>
Robots.txt in page HTML: <Yes/No>
Canonical: <found/not found>
Hreflang count: <number>
Local schema detected: <Yes/No>
Images ALT ratio: <number>%
Reading ease (Flesch): <number> (<Easy/Moderate/Difficult>)

AI Suggestions (requires OPENAI_API_KEY / CHATGPT_KEY):
<AI suggestion 1>
<AI suggestion 2>
<AI suggestion 3>
<AI suggestion 4>

Reports:
JSON: <path_to_json_report>
HTML: <path_to_html_report>

Notes:

Base GEO/SEO checks run without any OpenAI key.
AI Suggestions appear only if OPENAI_API_KEY or CHATGPT_KEY is set.
HTML report preview placeholder: <path_to_html_report>
```

---- Report Preview ----

<img src="https://github.com/user-attachments/assets/6024406a-040d-4d8e-a5de-24723972d53c" 
     alt="geoaudit" 
     style="width:100vw; max-width:100%; height:auto; display:block;" />

