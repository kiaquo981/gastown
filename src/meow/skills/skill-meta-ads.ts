/**
 * Skill: Meta Ads Management — LP-013 (Stage 04 Wave 3)
 *
 * Real Meta Marketing API integration for campaign management.
 * Actions: create_campaign, pause_campaign, scale_budget, get_insights
 *
 * Env: META_ACCESS_TOKEN, META_AD_ACCOUNT_ID
 * API: https://graph.facebook.com/v21.0/
 */

import { registerBuiltin } from '../skill-runtime';
import { registerSkillFromTOML } from '../skill-registry';
import { createLogger } from '../../lib/logger';

const log = createLogger('skill-meta-ads');

const META_API_BASE = 'https://graph.facebook.com/v21.0';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getMetaConfig(): { token: string; accountId: string } | null {
  const token = process.env.META_ACCESS_TOKEN;
  const accountId = process.env.META_AD_ACCOUNT_ID;
  if (!token || !accountId) {
    log.warn('META_ACCESS_TOKEN or META_AD_ACCOUNT_ID not set — Meta Ads skill disabled');
    return null;
  }
  return { token, accountId };
}

async function metaApi(
  path: string,
  method: 'GET' | 'POST' | 'DELETE' = 'GET',
  body?: Record<string, unknown>,
  token?: string,
): Promise<{ ok: boolean; data: Record<string, unknown>; status: number }> {
  const url = `${META_API_BASE}${path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // Always use Authorization header — never pass token in URL or POST body
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const init: RequestInit = { method, headers };
  if (body && method === 'POST') {
    // Meta Marketing API uses form-style params
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) {
      // Skip access_token in body — it's in the Authorization header
      if (k === 'access_token') continue;
      params.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    init.body = params.toString();
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }

  try {
    const resp = await fetch(url, init);
    const data = await resp.json() as Record<string, unknown>;
    return { ok: resp.ok, data, status: resp.status };
  } catch (err) {
    return { ok: false, data: { error: String(err) }, status: 0 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────

async function createCampaign(
  config: { token: string; accountId: string },
  inputs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const name = String(inputs.campaign_name || 'MEOW Campaign');
  const objective = String(inputs.objective || 'OUTCOME_TRAFFIC');
  const dailyBudget = Number(inputs.daily_budget || 5000); // cents
  const status = String(inputs.status || 'PAUSED');
  const targeting = inputs.targeting as Record<string, unknown> | undefined;
  const creativeUrl = String(inputs.creative_url || '');
  const pageId = String(inputs.page_id || '');

  // Step 1: Create campaign
  const campResp = await metaApi(`/act_${config.accountId}/campaigns`, 'POST', {
    name,
    objective,
    status,
    special_ad_categories: '[]',
    access_token: config.token,
  }, config.token);

  if (!campResp.ok) {
    return { success: false, error: 'Failed to create campaign', details: campResp.data };
  }

  const campaignId = String(campResp.data.id || '');

  // Step 2: Create ad set
  const adSetBody: Record<string, unknown> = {
    name: `${name} - AdSet`,
    campaign_id: campaignId,
    daily_budget: dailyBudget,
    billing_event: 'IMPRESSIONS',
    optimization_goal: 'LINK_CLICKS',
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    status,
    access_token: config.token,
  };

  if (targeting) {
    adSetBody.targeting = targeting;
  } else {
    adSetBody.targeting = { geo_locations: { countries: ['BR'] }, age_min: 18, age_max: 65 };
  }

  const adSetResp = await metaApi(`/act_${config.accountId}/adsets`, 'POST', adSetBody, config.token);
  const adSetId = adSetResp.ok ? String(adSetResp.data.id || '') : '';

  // Step 3: Create ad creative + ad (if creative_url and page_id provided)
  let adId = '';
  if (creativeUrl && pageId && adSetId) {
    const creativeResp = await metaApi(`/act_${config.accountId}/adcreatives`, 'POST', {
      name: `${name} - Creative`,
      object_story_spec: JSON.stringify({
        page_id: pageId,
        link_data: {
          link: creativeUrl,
          message: String(inputs.ad_text || 'Check this out!'),
        },
      }),
      access_token: config.token,
    }, config.token);

    const creativeId = creativeResp.ok ? String(creativeResp.data.id || '') : '';

    if (creativeId) {
      const adResp = await metaApi(`/act_${config.accountId}/ads`, 'POST', {
        name: `${name} - Ad`,
        adset_id: adSetId,
        creative: JSON.stringify({ creative_id: creativeId }),
        status,
        access_token: config.token,
      }, config.token);
      adId = adResp.ok ? String(adResp.data.id || '') : '';
    }
  }

  return {
    success: true,
    campaign_id: campaignId,
    adset_id: adSetId,
    ad_id: adId,
    status,
  };
}

async function pauseCampaign(
  config: { token: string; accountId: string },
  inputs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const campaignId = String(inputs.campaign_id || '');
  const newStatus = String(inputs.status || 'PAUSED');
  if (!campaignId) return { success: false, error: 'campaign_id is required' };

  const resp = await metaApi(`/${campaignId}`, 'POST', {
    status: newStatus,
    access_token: config.token,
  }, config.token);

  return { success: resp.ok, campaign_id: campaignId, status: newStatus, details: resp.data };
}

async function scaleBudget(
  config: { token: string; accountId: string },
  inputs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const adsetId = String(inputs.adset_id || '');
  const dailyBudget = inputs.daily_budget ? Number(inputs.daily_budget) : undefined;
  const lifetimeBudget = inputs.lifetime_budget ? Number(inputs.lifetime_budget) : undefined;
  if (!adsetId) return { success: false, error: 'adset_id is required' };

  const body: Record<string, unknown> = { access_token: config.token };
  if (dailyBudget) body.daily_budget = dailyBudget;
  if (lifetimeBudget) body.lifetime_budget = lifetimeBudget;

  const resp = await metaApi(`/${adsetId}`, 'POST', body, config.token);
  return {
    success: resp.ok,
    adset_id: adsetId,
    daily_budget: dailyBudget,
    lifetime_budget: lifetimeBudget,
    details: resp.data,
  };
}

async function getInsights(
  config: { token: string; accountId: string },
  inputs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const objectId = String(inputs.object_id || `act_${config.accountId}`);
  const datePreset = String(inputs.date_preset || 'last_7d');
  const level = String(inputs.level || 'campaign');
  const fields = String(
    inputs.fields ||
    'campaign_name,impressions,clicks,spend,cpc,cpm,ctr,actions,cost_per_action_type',
  );

  const params = `?fields=${encodeURIComponent(fields)}&date_preset=${encodeURIComponent(datePreset)}&level=${encodeURIComponent(level)}`;
  const resp = await metaApi(`/${objectId}/insights${params}`, 'GET', undefined, config.token);

  if (!resp.ok) {
    return { success: false, error: 'Failed to fetch insights', details: resp.data };
  }

  return {
    success: true,
    object_id: objectId,
    date_preset: datePreset,
    level,
    insights: resp.data.data || resp.data,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerMetaAdsSkill(): void {
  // Register TOML manifest
  registerSkillFromTOML(`
[skill]
name = "meta-ads-manage"
version = "1.0.0"
description = "Manage Meta (Facebook/Instagram) ad campaigns via Marketing API"
author = "meow"
runtime = "builtin"

[inputs.action]
type = "string"
required = true
description = "Action: create_campaign, pause_campaign, scale_budget, get_insights"

[inputs.campaign_name]
type = "string"
required = false
description = "Campaign name (for create)"

[inputs.campaign_id]
type = "string"
required = false
description = "Campaign ID (for pause/insights)"

[inputs.adset_id]
type = "string"
required = false
description = "Ad set ID (for scale_budget)"

[inputs.objective]
type = "string"
required = false
description = "Campaign objective: OUTCOME_TRAFFIC, OUTCOME_SALES, etc."

[inputs.daily_budget]
type = "number"
required = false
description = "Daily budget in cents"

[inputs.targeting]
type = "object"
required = false
description = "Targeting spec object"

[outputs.success]
type = "boolean"
description = "Whether the operation succeeded"

[outputs.campaign_id]
type = "string"
description = "Campaign ID"

[outputs.insights]
type = "object"
description = "Campaign insights data"

[requirements]
capabilities = ["MetaAdsManage", "NetConnect"]
minTier = "A"
`);

  // Register builtin handler
  registerBuiltin('meta-ads-manage', async (ctx) => {
    const config = getMetaConfig();
    if (!config) {
      return { success: false, error: 'Meta Ads credentials not configured (META_ACCESS_TOKEN, META_AD_ACCOUNT_ID)' };
    }

    const action = String(ctx.inputs.action || 'get_insights');
    log.info({ action, moleculeId: ctx.moleculeId }, 'Meta Ads skill executing');

    switch (action) {
      case 'create_campaign':
        return createCampaign(config, ctx.inputs);
      case 'pause_campaign':
        return pauseCampaign(config, ctx.inputs);
      case 'scale_budget':
        return scaleBudget(config, ctx.inputs);
      case 'get_insights':
        return getInsights(config, ctx.inputs);
      default:
        return { success: false, error: `Unknown action: ${action}. Valid: create_campaign, pause_campaign, scale_budget, get_insights` };
    }
  });

  log.info('Meta Ads skill registered');
}
