/**
 * Skill: Web Scraping — LP-018 (Stage 04 Wave 3)
 *
 * Web scraping via Apify actors with Gemini fallback.
 * Actions: scrape_product, search_trending, competitor_monitor, market_intel
 *
 * Env: APIFY_TOKEN (optional), GEMINI_API_KEY (fallback)
 */

import { registerBuiltin } from '../skill-runtime';
import { registerSkillFromTOML } from '../skill-registry';
import { createLogger } from '../../lib/logger';

const log = createLogger('skill-web-scrape');

const APIFY_BASE = 'https://api.apify.com/v2';
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getApifyToken(): string | null {
  return process.env.APIFY_TOKEN || null;
}

async function apifyRunActor(
  token: string,
  actorId: string,
  input: Record<string, unknown>,
  timeoutSecs: number = 60,
): Promise<{ ok: boolean; data: unknown }> {
  const authHeaders = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };

  try {
    // Start actor run — use Authorization header instead of token in URL
    const startResp = await fetch(
      `${APIFY_BASE}/acts/${actorId}/runs?timeout=${timeoutSecs}&waitForFinish=${timeoutSecs}`,
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(input),
      },
    );

    if (!startResp.ok) {
      const errText = await startResp.text();
      return { ok: false, data: { error: `Apify start failed: ${startResp.status}`, details: errText.slice(0, 300) } };
    }

    const runData = await startResp.json() as { data: { id: string; defaultDatasetId: string; status: string } };
    const datasetId = runData.data?.defaultDatasetId;

    if (!datasetId) {
      return { ok: false, data: { error: 'No dataset ID returned', run: runData.data } };
    }

    // Fetch dataset items — use Authorization header instead of token in URL
    const dataResp = await fetch(
      `${APIFY_BASE}/datasets/${datasetId}/items?format=json&limit=100`,
      { headers: { 'Authorization': `Bearer ${token}` } },
    );

    if (!dataResp.ok) {
      return { ok: false, data: { error: `Dataset fetch failed: ${dataResp.status}` } };
    }

    const items = await dataResp.json();
    return { ok: true, data: items };
  } catch (err) {
    return { ok: false, data: { error: `Apify exception: ${err}` } };
  }
}

async function geminiWebAnalysis(prompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return '[No GEMINI_API_KEY — cannot perform web analysis fallback]';

  try {
    const resp = await fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gemini-2.0-flash',
        messages: [
          {
            role: 'system',
            content: 'You are a market research analyst. Analyze the given topic and provide structured data. Output valid JSON.',
          },
          { role: 'user', content: prompt },
        ],
        max_tokens: 4096,
        temperature: 0.3,
      }),
    });

    if (!resp.ok) return `[Gemini error ${resp.status}]`;
    const data = await resp.json() as { choices: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content || '';
  } catch (err) {
    return `[Gemini exception: ${err}]`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────

async function scrapeProduct(inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = String(inputs.url || '');
  if (!url) return { success: false, error: 'url is required' };

  const token = getApifyToken();

  if (token) {
    // Detect platform and use appropriate actor
    let actorId = 'apify/web-scraper'; // generic fallback
    const actorInput: Record<string, unknown> = {
      startUrls: [{ url }],
      maxRequestsPerCrawl: 1,
    };

    if (url.includes('aliexpress')) {
      actorId = 'epctex/aliexpress-scraper';
      actorInput.startUrls = [{ url }];
    } else if (url.includes('amazon')) {
      actorId = 'junglee/amazon-crawler';
      actorInput.productUrls = [{ url }];
    } else if (url.includes('shopee')) {
      actorId = 'equidam/shopee-scraper';
      actorInput.startUrls = [{ url }];
    }

    const result = await apifyRunActor(token, actorId, actorInput, 90);
    if (result.ok) {
      const items = Array.isArray(result.data) ? result.data : [result.data];
      return {
        success: true,
        source: 'apify',
        product_count: items.length,
        products: items.slice(0, 10),
        url,
      };
    }

    log.warn({ error: result.data }, 'Apify scrape failed, falling back to Gemini');
  }

  // Fallback: Gemini analysis
  const analysis = await geminiWebAnalysis(
    `Analyze this product URL and extract: title, price, description, rating, reviews count, seller, shipping info. URL: ${url}\n\nReturn JSON with keys: title, price, currency, description, rating, reviews_count, seller, shipping, images_count, category.`,
  );

  let parsed: Record<string, unknown>;
  try {
    const jsonMatch = analysis.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, analysis];
    parsed = JSON.parse(jsonMatch[1] || analysis) as Record<string, unknown>;
  } catch {
    parsed = { raw_analysis: analysis };
  }

  return { success: true, source: 'gemini_analysis', url, product: parsed };
}

async function searchTrending(inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
  const niche = String(inputs.niche || inputs.category || 'ecommerce');
  const country = String(inputs.country || 'BR');
  const limit = Number(inputs.limit || 20);

  const token = getApifyToken();

  if (token) {
    // Use a product search actor
    const result = await apifyRunActor(token, 'apify/google-search-scraper', {
      queries: `trending products ${niche} ${country} 2026`,
      maxPagesPerQuery: 2,
      resultsPerPage: limit,
    }, 60);

    if (result.ok) {
      const items = Array.isArray(result.data) ? result.data : [];
      return {
        success: true,
        source: 'apify',
        niche,
        country,
        results: items.slice(0, limit),
        result_count: Math.min(items.length, limit),
      };
    }
  }

  // Fallback: Gemini analysis
  const analysis = await geminiWebAnalysis(
    `What are the top ${limit} trending products in the "${niche}" niche for ${country} market right now? For each product provide: name, estimated_demand (high/medium/low), price_range, potential_margin, competition_level, source_platform. Return as JSON array.`,
  );

  let parsed: unknown;
  try {
    const jsonMatch = analysis.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, analysis];
    parsed = JSON.parse(jsonMatch[1] || analysis);
  } catch {
    parsed = { raw: analysis };
  }

  return { success: true, source: 'gemini_analysis', niche, country, products: parsed };
}

async function competitorMonitor(inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
  const urls = (inputs.urls || []) as string[];
  const singleUrl = inputs.url ? String(inputs.url) : '';
  const allUrls = singleUrl ? [singleUrl, ...urls] : urls;

  if (allUrls.length === 0) return { success: false, error: 'At least one url is required' };

  const token = getApifyToken();
  const results: Array<Record<string, unknown>> = [];

  for (const url of allUrls.slice(0, 5)) { // max 5 URLs per call
    if (token) {
      const result = await apifyRunActor(token, 'apify/web-scraper', {
        startUrls: [{ url }],
        maxRequestsPerCrawl: 5,
        pageFunction: `async function pageFunction(context) {
          const { $, request } = context;
          return {
            url: request.url,
            title: $('title').text(),
            h1: $('h1').first().text(),
            prices: $('[class*="price"]').map((i, el) => $(el).text()).get().slice(0, 10),
            productCount: $('[class*="product"]').length,
            lastChecked: new Date().toISOString(),
          };
        }`,
      }, 30);

      if (result.ok) {
        results.push({ url, source: 'apify', data: result.data });
        continue;
      }
    }

    // Fallback
    const analysis = await geminiWebAnalysis(
      `Analyze this competitor website and extract: main products, price range, unique selling points, target audience, estimated traffic level. URL: ${url}\nReturn JSON.`,
    );

    let parsed: Record<string, unknown>;
    try {
      const jsonMatch = analysis.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, analysis];
      parsed = JSON.parse(jsonMatch[1] || analysis) as Record<string, unknown>;
    } catch {
      parsed = { raw: analysis };
    }

    results.push({ url, source: 'gemini_analysis', data: parsed });
  }

  return { success: true, monitored_urls: allUrls.length, results };
}

async function marketIntel(inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
  const category = String(inputs.category || inputs.niche || '');
  const country = String(inputs.country || 'BR');
  const metrics = (inputs.metrics || ['market_size', 'growth_rate', 'top_players', 'trends']) as string[];

  if (!category) return { success: false, error: 'category is required' };

  const prompt = `Provide comprehensive market intelligence for the "${category}" category in ${country}. Include the following metrics: ${metrics.join(', ')}.

For each metric provide:
- market_size: estimated TAM/SAM in USD
- growth_rate: YoY growth percentage
- top_players: top 5 companies with estimated market share
- trends: top 5 current trends
- entry_barriers: high/medium/low with explanation
- avg_cpa: average cost per acquisition in USD
- avg_roas: typical ROAS for paid advertising
- seasonality: peak months

Return as structured JSON.`;

  const analysis = await geminiWebAnalysis(prompt);

  let parsed: Record<string, unknown>;
  try {
    const jsonMatch = analysis.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, analysis];
    parsed = JSON.parse(jsonMatch[1] || analysis) as Record<string, unknown>;
  } catch {
    parsed = { raw_analysis: analysis };
  }

  return { success: true, category, country, source: 'gemini_analysis', intel: parsed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerWebScrapeSkill(): void {
  registerSkillFromTOML(`
[skill]
name = "web-scrape"
version = "1.0.0"
description = "Web scraping via Apify with Gemini fallback for product research and competitive intel"
author = "meow"
runtime = "builtin"

[inputs.action]
type = "string"
required = true
description = "Action: scrape_product, search_trending, competitor_monitor, market_intel"

[inputs.url]
type = "string"
required = false
description = "URL to scrape"

[inputs.niche]
type = "string"
required = false
description = "Product niche or category"

[inputs.country]
type = "string"
required = false
description = "Target country code (e.g. BR, US, AR)"

[inputs.urls]
type = "array"
required = false
description = "Multiple URLs for competitor monitoring"

[outputs.success]
type = "boolean"
description = "Whether the operation succeeded"

[outputs.products]
type = "array"
description = "Scraped products"

[outputs.intel]
type = "object"
description = "Market intelligence data"

[requirements]
capabilities = ["NetConnect"]
minTier = "B"
`);

  registerBuiltin('web-scrape', async (ctx) => {
    const action = String(ctx.inputs.action || 'scrape_product');
    log.info({ action, moleculeId: ctx.moleculeId }, 'Web scrape skill executing');

    switch (action) {
      case 'scrape_product':
        return scrapeProduct(ctx.inputs);
      case 'search_trending':
        return searchTrending(ctx.inputs);
      case 'competitor_monitor':
        return competitorMonitor(ctx.inputs);
      case 'market_intel':
        return marketIntel(ctx.inputs);
      default:
        return { success: false, error: `Unknown action: ${action}. Valid: scrape_product, search_trending, competitor_monitor, market_intel` };
    }
  });

  log.info('Web scrape skill registered');
}
