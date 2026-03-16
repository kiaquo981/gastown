/**
 * ATLAS COUNTRY INJECTION -- CG-023 (Stage 05 Wave 6)
 *
 * Inject country-specific intelligence from the ATLAS system.
 *
 * ATLAS = country expansion intelligence covering multiple regions:
 *   AR (Argentina), BR (Brazil), MX (Mexico), CO (Colombia),
 *   CL (Chile), PE (Peru), EC (Ecuador), EU (Spain/Portugal)
 *
 * Injects per country:
 *   - Tax rates & import duties
 *   - Shipping providers & logistics constraints
 *   - Payment gateways & COD rules
 *   - Currency info & exchange rates
 *   - Cultural norms (naming, colors, holidays)
 *   - Platform preferences (MercadoLibre, Shopify, etc.)
 *
 * Multi-country convoy awareness: comparison data for convoy formulas
 * targeting multiple markets simultaneously.
 *
 * Refresh intervals:
 *   - Volatile (exchange rates): daily
 *   - Stable (tax, logistics): weekly
 *
 * Fallback: hardcoded baseline data for each country when DB unavailable.
 */

import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../../db/client';
import { broadcast } from '../../sse';
import { createLogger } from '../../lib/logger';
import type { Bead } from '../types';

const log = createLogger('atlas-country-injection');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CountryCode = 'AR' | 'BR' | 'MX' | 'CO' | 'CL' | 'PE' | 'EC' | 'EU';

export interface CountryIntelligence {
  countryCode: CountryCode;
  countryName: string;
  currency: string;
  currencySymbol: string;
  exchangeRateToUSD: number;
  taxRate: number;                    // VAT / IVA percentage
  importDutyRate: number;             // average import duty %
  codAvailable: boolean;
  codFeePercent: number;
  paymentGateways: string[];
  shippingProviders: string[];
  avgDeliveryDays: number;
  platformPreferences: string[];
  culturalNotes: string[];
  restrictions: string[];            // product/category restrictions
  peakSeasons: string[];             // e.g. "Nov-Dec", "Buen Fin", "Hot Sale"
  lastRefreshed: Date;
  metadata?: Record<string, unknown>;
}

export interface CountryComparison {
  countries: CountryCode[];
  matrix: Record<string, Record<CountryCode, string | number | boolean>>;
  bestFor: Record<string, CountryCode>;
  recommendation: string;
}

export interface AtlasInjection {
  id: string;
  countries: CountryCode[];
  intelligence: CountryIntelligence[];
  comparison?: CountryComparison;
  composedText: string;
  injectedAt: Date;
  beadId?: string;
}

export interface AtlasStats {
  totalInjections: number;
  countryDistribution: Record<string, number>;
  avgCountriesPerInjection: number;
  staleDataCount: number;
  lastGlobalRefresh: Date | null;
}

// ---------------------------------------------------------------------------
// Baseline data — fallback when DB is unavailable
// ---------------------------------------------------------------------------

const BASELINE_DATA: Record<CountryCode, CountryIntelligence> = {
  AR: {
    countryCode: 'AR',
    countryName: 'Argentina',
    currency: 'ARS',
    currencySymbol: '$',
    exchangeRateToUSD: 0.001,
    taxRate: 21,
    importDutyRate: 35,
    codAvailable: true,
    codFeePercent: 3,
    paymentGateways: ['MercadoPago', 'Mobbex', 'TodoPago'],
    shippingProviders: ['Andreani', 'OCA', 'Correo Argentino'],
    avgDeliveryDays: 5,
    platformPreferences: ['MercadoLibre', 'Tiendanube', 'Shopify'],
    culturalNotes: ['Voseo (use "vos" not "tu")', 'Mate culture', 'Football references resonate'],
    restrictions: ['Strict import controls', 'Dollar purchase limits'],
    peakSeasons: ['Nov-Dec (Navidad)', 'May (Dia de la Madre)', 'Hot Sale (May)'],
    lastRefreshed: new Date('2026-01-01'),
  },
  BR: {
    countryCode: 'BR',
    countryName: 'Brazil',
    currency: 'BRL',
    currencySymbol: 'R$',
    exchangeRateToUSD: 0.18,
    taxRate: 17,
    importDutyRate: 60,
    codAvailable: false,
    codFeePercent: 0,
    paymentGateways: ['PIX', 'PagSeguro', 'Stripe BR', 'MercadoPago'],
    shippingProviders: ['Correios', 'Jadlog', 'Total Express'],
    avgDeliveryDays: 7,
    platformPreferences: ['Shopify', 'Nuvemshop', 'MercadoLivre'],
    culturalNotes: ['Portuguese only', 'PIX is king for payments', 'Instagram/TikTok dominant'],
    restrictions: ['High import taxes (60%+)', 'Remessa Conforme program'],
    peakSeasons: ['Nov (Black Friday)', 'Dec (Natal)', 'Jun (Dia dos Namorados)'],
    lastRefreshed: new Date('2026-01-01'),
  },
  MX: {
    countryCode: 'MX',
    countryName: 'Mexico',
    currency: 'MXN',
    currencySymbol: '$',
    exchangeRateToUSD: 0.058,
    taxRate: 16,
    importDutyRate: 20,
    codAvailable: true,
    codFeePercent: 5,
    paymentGateways: ['Conekta', 'MercadoPago', 'OXXO Pay', 'Stripe MX'],
    shippingProviders: ['FedEx MX', 'Estafeta', 'DHL MX', '99minutos'],
    avgDeliveryDays: 4,
    platformPreferences: ['Shopify', 'MercadoLibre', 'Amazon MX'],
    culturalNotes: ['OXXO cash payments popular', 'Dia de Muertos opportunity', 'Family-centric messaging'],
    restrictions: ['NOM certification for some products'],
    peakSeasons: ['Nov (Buen Fin + Black Friday)', 'Dec (Navidad)', 'May (Dia de las Madres)'],
    lastRefreshed: new Date('2026-01-01'),
  },
  CO: {
    countryCode: 'CO',
    countryName: 'Colombia',
    currency: 'COP',
    currencySymbol: '$',
    exchangeRateToUSD: 0.00024,
    taxRate: 19,
    importDutyRate: 15,
    codAvailable: true,
    codFeePercent: 4,
    paymentGateways: ['PayU', 'Wompi', 'MercadoPago', 'Nequi'],
    shippingProviders: ['Servientrega', 'Inter Rapidisimo', 'Coordinadora'],
    avgDeliveryDays: 4,
    platformPreferences: ['MercadoLibre', 'Shopify', 'Linio'],
    culturalNotes: ['COD very popular', 'WhatsApp-first commerce', 'Regional dialects matter'],
    restrictions: ['Some cosmetic regulations'],
    peakSeasons: ['Nov (Black Friday)', 'Dec (Navidad)', 'Jun (Amor y Amistad is Sep)'],
    lastRefreshed: new Date('2026-01-01'),
  },
  CL: {
    countryCode: 'CL',
    countryName: 'Chile',
    currency: 'CLP',
    currencySymbol: '$',
    exchangeRateToUSD: 0.001,
    taxRate: 19,
    importDutyRate: 6,
    codAvailable: false,
    codFeePercent: 0,
    paymentGateways: ['Transbank', 'MercadoPago', 'Flow', 'Kushki'],
    shippingProviders: ['Chilexpress', 'Starken', 'Correos de Chile'],
    avgDeliveryDays: 3,
    platformPreferences: ['MercadoLibre', 'Shopify', 'Falabella'],
    culturalNotes: ['Digital-first consumers', 'Credit card culture', 'Formal Spanish'],
    restrictions: ['Low import duties make it attractive'],
    peakSeasons: ['Nov (CyberMonday CL)', 'Dec (Navidad)', 'May (Dia de la Madre)'],
    lastRefreshed: new Date('2026-01-01'),
  },
  PE: {
    countryCode: 'PE',
    countryName: 'Peru',
    currency: 'PEN',
    currencySymbol: 'S/',
    exchangeRateToUSD: 0.27,
    taxRate: 18,
    importDutyRate: 12,
    codAvailable: true,
    codFeePercent: 5,
    paymentGateways: ['Niubiz', 'MercadoPago', 'Yape', 'Plin'],
    shippingProviders: ['Olva Courier', 'Shalom', 'InDrive Delivery'],
    avgDeliveryDays: 5,
    platformPreferences: ['MercadoLibre', 'Shopify', 'Juntoz'],
    culturalNotes: ['Mobile wallet adoption (Yape/Plin)', 'COD preferred outside Lima', 'Price-sensitive market'],
    restrictions: ['SUNAT customs for imports'],
    peakSeasons: ['Nov (Black Friday)', 'Dec (Navidad)', 'Jul (Fiestas Patrias)'],
    lastRefreshed: new Date('2026-01-01'),
  },
  EC: {
    countryCode: 'EC',
    countryName: 'Ecuador',
    currency: 'USD',
    currencySymbol: '$',
    exchangeRateToUSD: 1.0,
    taxRate: 12,
    importDutyRate: 25,
    codAvailable: true,
    codFeePercent: 5,
    paymentGateways: ['PayPhone', 'DataFast', 'MercadoPago'],
    shippingProviders: ['Servientrega EC', 'Tramaco', 'Laar Courier'],
    avgDeliveryDays: 4,
    platformPreferences: ['MercadoLibre', 'Shopify'],
    culturalNotes: ['USD economy (no FX risk)', 'Facebook commerce popular', 'Small but growing e-commerce'],
    restrictions: ['4x4 import regime (max $400/year exempt)'],
    peakSeasons: ['Nov (Black Friday)', 'Dec (Navidad)'],
    lastRefreshed: new Date('2026-01-01'),
  },
  EU: {
    countryCode: 'EU',
    countryName: 'Europe (ES/PT)',
    currency: 'EUR',
    currencySymbol: '\u20AC',
    exchangeRateToUSD: 1.08,
    taxRate: 21,
    importDutyRate: 12,
    codAvailable: true,
    codFeePercent: 3,
    paymentGateways: ['Stripe', 'PayPal', 'Adyen', 'Klarna'],
    shippingProviders: ['DHL', 'GLS', 'CTT (PT)', 'SEUR (ES)'],
    avgDeliveryDays: 3,
    platformPreferences: ['Shopify', 'Amazon EU', 'WooCommerce'],
    culturalNotes: ['GDPR compliance mandatory', 'Returns expected (14 day policy)', 'Quality over price messaging'],
    restrictions: ['CE marking required', 'GDPR data handling', 'EU consumer protection laws'],
    peakSeasons: ['Nov (Black Friday)', 'Dec (Christmas)', 'Jan (Rebajas/Saldos)'],
    lastRefreshed: new Date('2026-01-01'),
  },
};

// ---------------------------------------------------------------------------
// Gemini helper
// ---------------------------------------------------------------------------

async function callGemini(prompt: string): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  try {
    const resp = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gemini-2.0-flash',
          messages: [
            {
              role: 'system',
              content: 'You are ATLAS, the country intelligence engine for a global operation. Provide concise, actionable country-specific intelligence. Respond with valid JSON only.',
            },
            { role: 'user', content: prompt },
          ],
          max_tokens: 1024,
          temperature: 0.2,
        }),
      },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    log.warn({ err }, 'Gemini call failed in atlas-country-injection');
    return null;
  }
}

// ---------------------------------------------------------------------------
// AtlasCountryInjector
// ---------------------------------------------------------------------------

export class AtlasCountryInjector {
  private countryCache = new Map<CountryCode, CountryIntelligence>();
  private injections: AtlasInjection[] = [];
  private maxInjections = 5_000;

  // Refresh intervals
  private static readonly VOLATILE_REFRESH_MS = 24 * 60 * 60 * 1000;   // 1 day
  private static readonly STABLE_REFRESH_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  constructor() {
    // Seed cache with baseline data
    for (const [code, data] of Object.entries(BASELINE_DATA)) {
      this.countryCache.set(code as CountryCode, { ...data });
    }
  }

  // --- Inject country intelligence for a bead ------------------------------

  async injectForBead(bead: Bead): Promise<AtlasInjection | null> {
    const countries = this.detectCountries(bead);
    if (countries.length === 0) {
      log.info({ beadId: bead.id }, 'No country context detected in bead, skipping ATLAS injection');
      return null;
    }

    return this.injectForCountries(countries, bead.id);
  }

  // --- Inject for specific countries ----------------------------------------

  async injectForCountries(
    countries: CountryCode[],
    beadId?: string,
  ): Promise<AtlasInjection> {
    log.info({ countries, beadId }, 'Injecting ATLAS country intelligence');

    // Fetch intelligence for each country
    const intelligence: CountryIntelligence[] = [];
    for (const code of countries) {
      const data = await this.getCountryIntelligence(code);
      if (data) intelligence.push(data);
    }

    // Build comparison if multi-country
    let comparison: CountryComparison | undefined;
    if (countries.length > 1) {
      comparison = this.buildComparison(intelligence);
    }

    // Compose text
    const composedText = this.composeInjectionText(intelligence, comparison);

    const injection: AtlasInjection = {
      id: uuidv4(),
      countries,
      intelligence,
      comparison,
      composedText,
      injectedAt: new Date(),
      beadId,
    };

    this.injections.push(injection);
    if (this.injections.length > this.maxInjections) {
      this.injections = this.injections.slice(-this.maxInjections);
    }

    await this.persistInjection(injection);

    broadcast('meow:cognitive', {
      type: 'atlas_country_injected',
      countries,
      beadId,
      injectionId: injection.id,
      countryCount: intelligence.length,
      hasComparison: !!comparison,
    });

    return injection;
  }

  // --- Get intelligence for a single country --------------------------------

  async getCountryIntelligence(code: CountryCode): Promise<CountryIntelligence | null> {
    // Check cache freshness
    const cached = this.countryCache.get(code);
    if (cached && !this.isStale(cached)) {
      return cached;
    }

    // Try DB
    const fromDB = await this.fetchFromDB(code);
    if (fromDB) {
      this.countryCache.set(code, fromDB);
      return fromDB;
    }

    // Fallback to baseline
    const baseline = BASELINE_DATA[code];
    if (baseline) {
      this.countryCache.set(code, { ...baseline, lastRefreshed: new Date() });
      return this.countryCache.get(code)!;
    }

    log.warn({ code }, 'No intelligence available for country');
    return null;
  }

  // --- Refresh country data (volatile = exchange rates, etc.) ---------------

  async refreshVolatileData(): Promise<number> {
    let refreshed = 0;
    const pool = getPool();

    for (const code of Object.keys(BASELINE_DATA) as CountryCode[]) {
      const cached = this.countryCache.get(code);
      if (!cached) continue;

      const age = Date.now() - cached.lastRefreshed.getTime();
      if (age < AtlasCountryInjector.VOLATILE_REFRESH_MS) continue;

      // Try to refresh exchange rate from AI
      const updated = await this.refreshExchangeRate(code);
      if (updated !== null) {
        cached.exchangeRateToUSD = updated;
        cached.lastRefreshed = new Date();
        refreshed++;

        // Persist to DB
        if (pool) {
          await this.persistCountryData(cached).catch(err =>
            log.warn({ err, code }, 'Failed to persist refreshed country data'),
          );
        }
      }
    }

    if (refreshed > 0) {
      broadcast('meow:cognitive', {
        type: 'atlas_volatile_refreshed',
        refreshedCount: refreshed,
      });
    }

    log.info({ refreshed }, 'Volatile data refresh complete');
    return refreshed;
  }

  // --- Get stats ------------------------------------------------------------

  getStats(): AtlasStats {
    const total = this.injections.length;
    const dist: Record<string, number> = {};
    let totalCountries = 0;

    for (const inj of this.injections) {
      for (const c of inj.countries) {
        dist[c] = (dist[c] ?? 0) + 1;
      }
      totalCountries += inj.countries.length;
    }

    let staleCount = 0;
    for (const data of this.countryCache.values()) {
      if (this.isStale(data)) staleCount++;
    }

    const lastRefreshDates = Array.from(this.countryCache.values()).map(d => d.lastRefreshed.getTime());
    const lastGlobalRefresh = lastRefreshDates.length > 0
      ? new Date(Math.min(...lastRefreshDates))
      : null;

    return {
      totalInjections: total,
      countryDistribution: dist,
      avgCountriesPerInjection: total > 0 ? Math.round((totalCountries / total) * 10) / 10 : 0,
      staleDataCount: staleCount,
      lastGlobalRefresh,
    };
  }

  // --- Get all cached intelligence ------------------------------------------

  getAllCachedIntelligence(): CountryIntelligence[] {
    return Array.from(this.countryCache.values());
  }

  // --- Private helpers ------------------------------------------------------

  private detectCountries(bead: Bead): CountryCode[] {
    const countries = new Set<CountryCode>();
    const validCodes = new Set(Object.keys(BASELINE_DATA));

    // Check labels
    if (bead.labels) {
      const targetCountry = bead.labels.target_country ?? bead.labels.country;
      if (targetCountry) {
        const upper = targetCountry.toUpperCase();
        if (validCodes.has(upper)) countries.add(upper as CountryCode);
      }
    }

    // Check BU
    if (bead.bu) {
      const buCountryMap: Record<string, CountryCode> = {
        'bu-regional': 'MX',
        'bu-global': 'BR',
        'bu-ar': 'AR',
        'bu-mx': 'MX',
        'bu-co': 'CO',
        'bu-cl': 'CL',
        'bu-pe': 'PE',
        'bu-ec': 'EC',
        'bu-eu': 'EU',
      };
      const mapped = buCountryMap[bead.bu.toLowerCase()];
      if (mapped) countries.add(mapped);
    }

    // Check description for country mentions
    const text = `${bead.title ?? ''} ${bead.description ?? ''}`.toLowerCase();
    const countryKeywords: Record<string, CountryCode> = {
      argentina: 'AR', argentine: 'AR', buenos: 'AR',
      brazil: 'BR', brasil: 'BR', brazilian: 'BR',
      mexico: 'MX', mexican: 'MX', mexicano: 'MX',
      colombia: 'CO', colombian: 'CO', colombiano: 'CO',
      chile: 'CL', chilean: 'CL', chileno: 'CL',
      peru: 'PE', peruvian: 'PE', peruano: 'PE',
      ecuador: 'EC', ecuadorian: 'EC', ecuatoriano: 'EC',
      spain: 'EU', portugal: 'EU', europe: 'EU', europa: 'EU',
    };

    for (const [kw, code] of Object.entries(countryKeywords)) {
      if (text.includes(kw)) countries.add(code);
    }

    return Array.from(countries);
  }

  private isStale(data: CountryIntelligence): boolean {
    const age = Date.now() - data.lastRefreshed.getTime();
    return age > AtlasCountryInjector.STABLE_REFRESH_MS;
  }

  private async fetchFromDB(code: CountryCode): Promise<CountryIntelligence | null> {
    const pool = getPool();
    if (!pool) return null;

    try {
      const { rows } = await pool.query(
        `SELECT country_code, country_name, currency, currency_symbol,
                exchange_rate_to_usd, tax_rate, import_duty_rate,
                cod_available, cod_fee_percent, payment_gateways,
                shipping_providers, avg_delivery_days, platform_preferences,
                cultural_notes, restrictions, peak_seasons,
                last_refreshed, metadata
         FROM meow_country_intelligence
         WHERE country_code = $1
         LIMIT 1`,
        [code],
      );

      if (rows.length === 0) return null;

      const r = rows[0] as Record<string, unknown>;
      return {
        countryCode: (r.country_code as CountryCode) ?? code,
        countryName: (r.country_name as string) ?? '',
        currency: (r.currency as string) ?? '',
        currencySymbol: (r.currency_symbol as string) ?? '',
        exchangeRateToUSD: parseFloat((r.exchange_rate_to_usd as string) ?? '0'),
        taxRate: parseFloat((r.tax_rate as string) ?? '0'),
        importDutyRate: parseFloat((r.import_duty_rate as string) ?? '0'),
        codAvailable: (r.cod_available as boolean) ?? false,
        codFeePercent: parseFloat((r.cod_fee_percent as string) ?? '0'),
        paymentGateways: this.parseJsonArray(r.payment_gateways),
        shippingProviders: this.parseJsonArray(r.shipping_providers),
        avgDeliveryDays: parseInt((r.avg_delivery_days as string) ?? '5', 10),
        platformPreferences: this.parseJsonArray(r.platform_preferences),
        culturalNotes: this.parseJsonArray(r.cultural_notes),
        restrictions: this.parseJsonArray(r.restrictions),
        peakSeasons: this.parseJsonArray(r.peak_seasons),
        lastRefreshed: new Date((r.last_refreshed as string) ?? Date.now()),
        metadata: typeof r.metadata === 'string'
          ? JSON.parse(r.metadata)
          : (r.metadata as Record<string, unknown>) ?? {},
      };
    } catch (err) {
      log.warn({ err, code }, 'Failed to fetch country intelligence from DB');
      return null;
    }
  }

  private parseJsonArray(val: unknown): string[] {
    if (Array.isArray(val)) return val as string[];
    if (typeof val === 'string') {
      try { return JSON.parse(val) as string[]; } catch { return []; }
    }
    return [];
  }

  private buildComparison(intel: CountryIntelligence[]): CountryComparison {
    const countries = intel.map(i => i.countryCode);
    const matrix: Record<string, Record<CountryCode, string | number | boolean>> = {};
    const bestFor: Record<string, CountryCode> = {};

    // Tax rate comparison
    const taxRow: Record<CountryCode, string | number | boolean> = {} as Record<CountryCode, string | number | boolean>;
    let lowestTax: { code: CountryCode; val: number } = { code: intel[0].countryCode, val: intel[0].taxRate };
    for (const i of intel) {
      taxRow[i.countryCode] = `${i.taxRate}%`;
      if (i.taxRate < lowestTax.val) lowestTax = { code: i.countryCode, val: i.taxRate };
    }
    matrix['Tax Rate'] = taxRow;
    bestFor['Lowest Tax'] = lowestTax.code;

    // Import duty comparison
    const dutyRow: Record<CountryCode, string | number | boolean> = {} as Record<CountryCode, string | number | boolean>;
    let lowestDuty: { code: CountryCode; val: number } = { code: intel[0].countryCode, val: intel[0].importDutyRate };
    for (const i of intel) {
      dutyRow[i.countryCode] = `${i.importDutyRate}%`;
      if (i.importDutyRate < lowestDuty.val) lowestDuty = { code: i.countryCode, val: i.importDutyRate };
    }
    matrix['Import Duty'] = dutyRow;
    bestFor['Lowest Duty'] = lowestDuty.code;

    // COD availability
    const codRow: Record<CountryCode, string | number | boolean> = {} as Record<CountryCode, string | number | boolean>;
    for (const i of intel) {
      codRow[i.countryCode] = i.codAvailable;
    }
    matrix['COD Available'] = codRow;

    // Delivery speed
    const deliveryRow: Record<CountryCode, string | number | boolean> = {} as Record<CountryCode, string | number | boolean>;
    let fastestDelivery: { code: CountryCode; val: number } = { code: intel[0].countryCode, val: intel[0].avgDeliveryDays };
    for (const i of intel) {
      deliveryRow[i.countryCode] = `${i.avgDeliveryDays} days`;
      if (i.avgDeliveryDays < fastestDelivery.val) fastestDelivery = { code: i.countryCode, val: i.avgDeliveryDays };
    }
    matrix['Avg Delivery'] = deliveryRow;
    bestFor['Fastest Delivery'] = fastestDelivery.code;

    // FX risk (USD-based = no risk)
    const fxRow: Record<CountryCode, string | number | boolean> = {} as Record<CountryCode, string | number | boolean>;
    for (const i of intel) {
      fxRow[i.countryCode] = i.currency === 'USD' ? 'None' : `${i.currency} (${i.exchangeRateToUSD})`;
    }
    matrix['FX Risk'] = fxRow;

    // Recommendation
    const recParts: string[] = [];
    recParts.push(`Best tax environment: ${bestFor['Lowest Tax']}`);
    recParts.push(`Fastest delivery: ${bestFor['Fastest Delivery']}`);
    recParts.push(`Lowest import duty: ${bestFor['Lowest Duty']}`);
    const codCountries = intel.filter(i => i.codAvailable).map(i => i.countryCode);
    if (codCountries.length > 0) recParts.push(`COD available in: ${codCountries.join(', ')}`);

    return {
      countries,
      matrix,
      bestFor,
      recommendation: recParts.join('. '),
    };
  }

  private composeInjectionText(
    intel: CountryIntelligence[],
    comparison?: CountryComparison,
  ): string {
    const lines: string[] = [];
    lines.push('=== ATLAS COUNTRY INTELLIGENCE ===');
    lines.push('');

    for (const c of intel) {
      lines.push(`--- ${c.countryName} (${c.countryCode}) ---`);
      lines.push(`  Currency: ${c.currency} (${c.currencySymbol}) | USD rate: ${c.exchangeRateToUSD}`);
      lines.push(`  Tax: ${c.taxRate}% | Import Duty: ${c.importDutyRate}%`);
      lines.push(`  COD: ${c.codAvailable ? `Yes (${c.codFeePercent}% fee)` : 'No'}`);
      lines.push(`  Payment: ${c.paymentGateways.join(', ')}`);
      lines.push(`  Shipping: ${c.shippingProviders.join(', ')} (~${c.avgDeliveryDays} days)`);
      lines.push(`  Platforms: ${c.platformPreferences.join(', ')}`);
      if (c.culturalNotes.length > 0) {
        lines.push(`  Culture: ${c.culturalNotes.join('; ')}`);
      }
      if (c.restrictions.length > 0) {
        lines.push(`  Restrictions: ${c.restrictions.join('; ')}`);
      }
      lines.push(`  Peak seasons: ${c.peakSeasons.join(', ')}`);
      lines.push('');
    }

    if (comparison) {
      lines.push('--- MULTI-COUNTRY COMPARISON ---');
      lines.push(`  ${comparison.recommendation}`);
      lines.push('');
    }

    return lines.join('\n');
  }

  private async refreshExchangeRate(code: CountryCode): Promise<number | null> {
    const prompt = `What is the current approximate exchange rate for 1 ${BASELINE_DATA[code].currency} to USD?
Respond with JSON only: {"rate": 0.XX}`;

    const raw = await callGemini(prompt);
    if (!raw) return null;

    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return null;
      const parsed = JSON.parse(match[0]) as { rate: number };
      if (typeof parsed.rate === 'number' && parsed.rate > 0 && parsed.rate < 1000) {
        return parsed.rate;
      }
      return null;
    } catch {
      return null;
    }
  }

  private async persistCountryData(data: CountryIntelligence): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_country_intelligence
          (country_code, country_name, currency, currency_symbol,
           exchange_rate_to_usd, tax_rate, import_duty_rate,
           cod_available, cod_fee_percent, payment_gateways,
           shipping_providers, avg_delivery_days, platform_preferences,
           cultural_notes, restrictions, peak_seasons,
           last_refreshed, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (country_code) DO UPDATE SET
           exchange_rate_to_usd = EXCLUDED.exchange_rate_to_usd,
           tax_rate = EXCLUDED.tax_rate,
           import_duty_rate = EXCLUDED.import_duty_rate,
           cod_available = EXCLUDED.cod_available,
           cod_fee_percent = EXCLUDED.cod_fee_percent,
           payment_gateways = EXCLUDED.payment_gateways,
           shipping_providers = EXCLUDED.shipping_providers,
           avg_delivery_days = EXCLUDED.avg_delivery_days,
           platform_preferences = EXCLUDED.platform_preferences,
           cultural_notes = EXCLUDED.cultural_notes,
           restrictions = EXCLUDED.restrictions,
           peak_seasons = EXCLUDED.peak_seasons,
           last_refreshed = EXCLUDED.last_refreshed,
           metadata = EXCLUDED.metadata`,
        [
          data.countryCode,
          data.countryName,
          data.currency,
          data.currencySymbol,
          data.exchangeRateToUSD,
          data.taxRate,
          data.importDutyRate,
          data.codAvailable,
          data.codFeePercent,
          JSON.stringify(data.paymentGateways),
          JSON.stringify(data.shippingProviders),
          data.avgDeliveryDays,
          JSON.stringify(data.platformPreferences),
          JSON.stringify(data.culturalNotes),
          JSON.stringify(data.restrictions),
          JSON.stringify(data.peakSeasons),
          data.lastRefreshed.toISOString(),
          JSON.stringify(data.metadata ?? {}),
        ],
      );
    } catch (err) {
      log.warn({ err, code: data.countryCode }, 'Failed to persist country data');
    }
  }

  private async persistInjection(injection: AtlasInjection): Promise<void> {
    const pool = getPool();
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO meow_atlas_injections
          (id, countries, composed_text, bead_id, injected_at)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT DO NOTHING`,
        [
          injection.id,
          JSON.stringify(injection.countries),
          injection.composedText.slice(0, 10000),
          injection.beadId ?? null,
          injection.injectedAt.toISOString(),
        ],
      );
    } catch (err) {
      log.warn({ err, injectionId: injection.id }, 'Failed to persist ATLAS injection');
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: AtlasCountryInjector | null = null;

export function getAtlasCountryInjector(): AtlasCountryInjector {
  if (!instance) {
    instance = new AtlasCountryInjector();
    log.info('AtlasCountryInjector singleton created');
  }
  return instance;
}
