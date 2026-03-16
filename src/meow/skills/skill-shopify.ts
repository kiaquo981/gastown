/**
 * Skill: Shopify Management — LP-014 (Stage 04 Wave 3)
 *
 * Real Shopify Admin API integration.
 * Actions: create_product, update_inventory, create_discount, get_orders
 *
 * Env: SHOPIFY_ACCESS_TOKEN, SHOPIFY_STORE_URL
 * API: /admin/api/2024-10/
 */

import { registerBuiltin } from '../skill-runtime';
import { registerSkillFromTOML } from '../skill-registry';
import { createLogger } from '../../lib/logger';

const log = createLogger('skill-shopify');

const SHOPIFY_API_VERSION = '2024-10';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getShopifyConfig(): { token: string; storeUrl: string } | null {
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  const storeUrl = process.env.SHOPIFY_STORE_URL; // e.g. https://mystore.myshopify.com
  if (!token || !storeUrl) {
    log.warn('SHOPIFY_ACCESS_TOKEN or SHOPIFY_STORE_URL not set — Shopify skill disabled');
    return null;
  }
  // Normalize: remove trailing slash
  return { token, storeUrl: storeUrl.replace(/\/$/, '') };
}

async function shopifyApi(
  config: { token: string; storeUrl: string },
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; data: Record<string, unknown>; status: number }> {
  const url = `${config.storeUrl}/admin/api/${SHOPIFY_API_VERSION}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': config.token,
  };

  const init: RequestInit = { method, headers };
  if (body && (method === 'POST' || method === 'PUT')) {
    init.body = JSON.stringify(body);
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

async function createProduct(
  config: { token: string; storeUrl: string },
  inputs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const title = String(inputs.title || 'New Product');
  const bodyHtml = String(inputs.body_html || inputs.description || '');
  const vendor = String(inputs.vendor || '');
  const productType = String(inputs.product_type || '');
  const tags = String(inputs.tags || '');
  const price = String(inputs.price || '0.00');
  const compareAtPrice = inputs.compare_at_price ? String(inputs.compare_at_price) : undefined;
  const sku = String(inputs.sku || '');
  const images = (inputs.images || []) as Array<{ src: string; alt?: string }>;
  const status = String(inputs.status || 'draft');

  const variant: Record<string, unknown> = { price, sku, inventory_management: 'shopify' };
  if (compareAtPrice) variant.compare_at_price = compareAtPrice;

  const product: Record<string, unknown> = {
    title,
    body_html: bodyHtml,
    vendor,
    product_type: productType,
    tags,
    status,
    variants: [variant],
  };

  if (images.length > 0) {
    product.images = images.map(img => ({ src: img.src, alt: img.alt || title }));
  }

  const resp = await shopifyApi(config, '/products.json', 'POST', { product });

  if (!resp.ok) {
    return { success: false, error: 'Failed to create product', details: resp.data };
  }

  const created = resp.data.product as Record<string, unknown> | undefined;
  return {
    success: true,
    product_id: created?.id,
    handle: created?.handle,
    status: created?.status,
    variant_id: (created?.variants as Array<Record<string, unknown>>)?.[0]?.id,
    admin_url: `${config.storeUrl}/admin/products/${created?.id}`,
  };
}

async function updateInventory(
  config: { token: string; storeUrl: string },
  inputs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const inventoryItemId = inputs.inventory_item_id ? String(inputs.inventory_item_id) : '';
  const locationId = inputs.location_id ? String(inputs.location_id) : '';
  const quantity = Number(inputs.quantity || 0);

  // If no inventory_item_id, try to get it from variant_id
  let resolvedItemId = inventoryItemId;
  if (!resolvedItemId && inputs.variant_id) {
    const varResp = await shopifyApi(config, `/variants/${inputs.variant_id}.json`);
    if (varResp.ok) {
      const variant = varResp.data.variant as Record<string, unknown> | undefined;
      resolvedItemId = String(variant?.inventory_item_id || '');
    }
  }
  if (!resolvedItemId) return { success: false, error: 'inventory_item_id or variant_id is required' };

  // If no location_id, fetch the primary location
  let resolvedLocationId = locationId;
  if (!resolvedLocationId) {
    const locResp = await shopifyApi(config, '/locations.json');
    if (locResp.ok) {
      const locations = locResp.data.locations as Array<Record<string, unknown>> | undefined;
      resolvedLocationId = String(locations?.[0]?.id || '');
    }
  }
  if (!resolvedLocationId) return { success: false, error: 'Could not resolve location_id' };

  // Set inventory level
  const resp = await shopifyApi(config, '/inventory_levels/set.json', 'POST', {
    inventory_item_id: Number(resolvedItemId),
    location_id: Number(resolvedLocationId),
    available: quantity,
  });

  return {
    success: resp.ok,
    inventory_item_id: resolvedItemId,
    location_id: resolvedLocationId,
    quantity,
    details: resp.data,
  };
}

async function createDiscount(
  config: { token: string; storeUrl: string },
  inputs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const title = String(inputs.title || 'MEOW Discount');
  const code = String(inputs.code || `MEOW${Date.now().toString(36).toUpperCase()}`);
  const valueType = String(inputs.value_type || 'percentage'); // percentage or fixed_amount
  const value = String(inputs.value || '-10.0');
  const startsAt = String(inputs.starts_at || new Date().toISOString());
  const endsAt = inputs.ends_at ? String(inputs.ends_at) : undefined;
  const usageLimit = inputs.usage_limit ? Number(inputs.usage_limit) : undefined;

  // Step 1: Create price rule
  const priceRuleBody: Record<string, unknown> = {
    title,
    target_type: 'line_item',
    target_selection: 'all',
    allocation_method: 'across',
    value_type: valueType,
    value,
    customer_selection: 'all',
    starts_at: startsAt,
  };
  if (endsAt) priceRuleBody.ends_at = endsAt;
  if (usageLimit) priceRuleBody.usage_limit = usageLimit;

  const ruleResp = await shopifyApi(config, '/price_rules.json', 'POST', { price_rule: priceRuleBody });
  if (!ruleResp.ok) {
    return { success: false, error: 'Failed to create price rule', details: ruleResp.data };
  }

  const priceRule = ruleResp.data.price_rule as Record<string, unknown> | undefined;
  const priceRuleId = String(priceRule?.id || '');

  // Step 2: Create discount code
  const codeResp = await shopifyApi(
    config,
    `/price_rules/${priceRuleId}/discount_codes.json`,
    'POST',
    { discount_code: { code } },
  );

  return {
    success: codeResp.ok,
    price_rule_id: priceRuleId,
    discount_code: code,
    value_type: valueType,
    value,
    details: codeResp.data,
  };
}

async function getOrders(
  config: { token: string; storeUrl: string },
  inputs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const status = String(inputs.order_status || 'any');
  const limit = Number(inputs.limit || 50);
  const sinceId = inputs.since_id ? `&since_id=${encodeURIComponent(String(inputs.since_id))}` : '';
  const createdAtMin = inputs.created_at_min ? `&created_at_min=${encodeURIComponent(String(inputs.created_at_min))}` : '';
  const financialStatus = inputs.financial_status ? `&financial_status=${encodeURIComponent(String(inputs.financial_status))}` : '';
  const fulfillmentStatus = inputs.fulfillment_status ? `&fulfillment_status=${encodeURIComponent(String(inputs.fulfillment_status))}` : '';

  const query = `?status=${encodeURIComponent(status)}&limit=${encodeURIComponent(String(limit))}${sinceId}${createdAtMin}${financialStatus}${fulfillmentStatus}`;
  const resp = await shopifyApi(config, `/orders.json${query}`);

  if (!resp.ok) {
    return { success: false, error: 'Failed to fetch orders', details: resp.data };
  }

  const orders = (resp.data.orders || []) as Array<Record<string, unknown>>;
  const totalRevenue = orders.reduce((sum, o) => sum + Number(o.total_price || 0), 0);

  return {
    success: true,
    count: orders.length,
    total_revenue: totalRevenue.toFixed(2),
    orders: orders.map(o => ({
      id: o.id,
      order_number: o.order_number,
      total_price: o.total_price,
      financial_status: o.financial_status,
      fulfillment_status: o.fulfillment_status,
      created_at: o.created_at,
      customer_email: (o.customer as Record<string, unknown>)?.email,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerShopifySkill(): void {
  registerSkillFromTOML(`
[skill]
name = "shopify-manage"
version = "1.0.0"
description = "Manage Shopify store: products, inventory, discounts, orders"
author = "meow"
runtime = "builtin"

[inputs.action]
type = "string"
required = true
description = "Action: create_product, update_inventory, create_discount, get_orders"

[inputs.title]
type = "string"
required = false
description = "Product title or discount title"

[inputs.price]
type = "string"
required = false
description = "Product price"

[inputs.variant_id]
type = "string"
required = false
description = "Variant ID for inventory updates"

[inputs.quantity]
type = "number"
required = false
description = "Inventory quantity to set"

[inputs.code]
type = "string"
required = false
description = "Discount code"

[outputs.success]
type = "boolean"
description = "Whether the operation succeeded"

[outputs.product_id]
type = "string"
description = "Created product ID"

[outputs.orders]
type = "array"
description = "List of orders"

[requirements]
capabilities = ["ShopifyManage", "NetConnect"]
minTier = "A"
`);

  registerBuiltin('shopify-manage', async (ctx) => {
    const config = getShopifyConfig();
    if (!config) {
      return { success: false, error: 'Shopify credentials not configured (SHOPIFY_ACCESS_TOKEN, SHOPIFY_STORE_URL)' };
    }

    const action = String(ctx.inputs.action || 'get_orders');
    log.info({ action, moleculeId: ctx.moleculeId }, 'Shopify skill executing');

    switch (action) {
      case 'create_product':
        return createProduct(config, ctx.inputs);
      case 'update_inventory':
        return updateInventory(config, ctx.inputs);
      case 'create_discount':
        return createDiscount(config, ctx.inputs);
      case 'get_orders':
        return getOrders(config, ctx.inputs);
      default:
        return { success: false, error: `Unknown action: ${action}. Valid: create_product, update_inventory, create_discount, get_orders` };
    }
  });

  log.info('Shopify skill registered');
}
