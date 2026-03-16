/**
 * Skill: Landing Page Deployment — LP-019 (Stage 04 Wave 3)
 *
 * Build and deploy landing pages.
 * Actions: assemble, upload, push_shopify, verify
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (for storage), SHOPIFY_* (for Shopify pages)
 */

import { registerBuiltin } from '../skill-runtime';
import { registerSkillFromTOML } from '../skill-registry';
import { createLogger } from '../../lib/logger';

const log = createLogger('skill-deploy-lp');

// ─────────────────────────────────────────────────────────────────────────────
// Security helpers
// ─────────────────────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function validatePixelId(id: string): string {
  // Pixel IDs should be alphanumeric only
  const cleaned = id.replace(/[^a-zA-Z0-9]/g, '');
  return cleaned;
}

// ─────────────────────────────────────────────────────────────────────────────
// Templates
// ─────────────────────────────────────────────────────────────────────────────

function buildHtmlPage(inputs: Record<string, unknown>): string {
  const headline = escapeHtml(String(inputs.headline || 'Your Product'));
  const subheadline = escapeHtml(String(inputs.subheadline || ''));
  const bodyContent = escapeHtml(String(inputs.body || inputs.content || ''));
  const ctaText = escapeHtml(String(inputs.cta_text || 'Buy Now'));
  const ctaUrl = escapeHtml(String(inputs.cta_url || '#'));
  const heroImage = escapeHtml(String(inputs.hero_image || ''));
  const price = escapeHtml(String(inputs.price || ''));
  const comparePrice = escapeHtml(String(inputs.compare_price || ''));
  const testimonials = (inputs.testimonials || []) as Array<{ name: string; text: string }>;
  const features = (inputs.features || []) as string[];
  const bgColor = escapeHtml(String(inputs.bg_color || '#0d1117'));
  const accentColor = escapeHtml(String(inputs.accent_color || '#22c55e'));
  const fontFamily = escapeHtml(String(inputs.font_family || 'Inter, system-ui, sans-serif'));
  const countdownEnd = inputs.countdown_end ? escapeHtml(String(inputs.countdown_end)) : '';
  const pixelId = inputs.meta_pixel_id ? validatePixelId(String(inputs.meta_pixel_id)) : '';

  const testimonialHtml = testimonials.map(t => `
    <div style="background:rgba(255,255,255,0.05);padding:1.5rem;border-left:3px solid ${accentColor};margin:1rem 0;">
      <p style="font-style:italic;margin:0 0 0.5rem;">"${escapeHtml(String(t.text || ''))}"</p>
      <strong style="color:${accentColor};">— ${escapeHtml(String(t.name || ''))}</strong>
    </div>`).join('');

  const featuresHtml = features.length > 0 ? `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:1rem;margin:2rem 0;">
      ${features.map(f => `<div style="background:rgba(255,255,255,0.05);padding:1rem;border:1px solid rgba(255,255,255,0.1);">✓ ${escapeHtml(String(f))}</div>`).join('')}
    </div>` : '';

  const priceHtml = price ? `
    <div style="text-align:center;margin:2rem 0;">
      ${comparePrice ? `<span style="text-decoration:line-through;color:#666;font-size:1.2rem;margin-right:0.5rem;">${comparePrice}</span>` : ''}
      <span style="font-size:2.5rem;font-weight:800;color:${accentColor};">${price}</span>
    </div>` : '';

  const countdownJs = countdownEnd ? `
    <script>
    (function(){
      var end = new Date('${countdownEnd}').getTime();
      var el = document.getElementById('countdown');
      if(!el) return;
      setInterval(function(){
        var now = Date.now();
        var diff = end - now;
        if(diff <= 0){el.textContent='EXPIRED';return;}
        var h=Math.floor(diff/3600000);
        var m=Math.floor((diff%3600000)/60000);
        var s=Math.floor((diff%60000)/1000);
        el.textContent=h+'h '+m+'m '+s+'s';
      },1000);
    })();
    </script>
    <div style="text-align:center;margin:1rem 0;">
      <span style="font-size:0.9rem;color:#aaa;">Offer ends in: </span>
      <span id="countdown" style="font-size:1.5rem;font-weight:700;color:#ef4444;"></span>
    </div>` : '';

  const pixelScript = pixelId ? `
    <script>
    !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
    n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
    n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
    t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
    document,'script','https://connect.facebook.net/en_US/fbevents.js');
    fbq('init','${pixelId}');fbq('track','PageView');
    </script>
    <noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=${pixelId}&ev=PageView&noscript=1"/></noscript>` : '';

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${headline}</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{background:${bgColor};color:#e5e7eb;font-family:${fontFamily};line-height:1.6;}
    .container{max-width:800px;margin:0 auto;padding:2rem 1rem;}
    .cta-btn{display:inline-block;background:${accentColor};color:#000;padding:1rem 3rem;font-size:1.2rem;font-weight:700;text-decoration:none;border:none;cursor:pointer;text-transform:uppercase;letter-spacing:0.05em;transition:opacity 0.2s;}
    .cta-btn:hover{opacity:0.9;}
    @media(max-width:640px){.container{padding:1rem 0.5rem;} h1{font-size:1.8rem!important;}}
  </style>
  ${pixelScript}
</head>
<body>
  <div class="container">
    ${heroImage ? `<img src="${heroImage}" alt="${headline}" style="width:100%;max-height:500px;object-fit:cover;margin-bottom:2rem;">` : ''}
    <h1 style="font-size:2.8rem;font-weight:800;line-height:1.1;margin-bottom:1rem;">${headline}</h1>
    ${subheadline ? `<p style="font-size:1.3rem;color:#9ca3af;margin-bottom:2rem;">${subheadline}</p>` : ''}
    <div style="font-size:1.1rem;margin-bottom:2rem;">${bodyContent}</div>
    ${featuresHtml}
    ${testimonialHtml}
    ${priceHtml}
    ${countdownJs}
    <div style="text-align:center;margin:2rem 0;">
      <a href="${ctaUrl}" class="cta-btn">${ctaText}</a>
    </div>
  </div>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────

async function assemblePage(inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const html = buildHtmlPage(inputs);
    return {
      success: true,
      html,
      size_bytes: new TextEncoder().encode(html).length,
      sections: [
        'hero', 'headline', 'body', 'features', 'testimonials', 'price', 'countdown', 'cta',
      ].filter(s => {
        if (s === 'hero') return Boolean(inputs.hero_image);
        if (s === 'features') return ((inputs.features || []) as unknown[]).length > 0;
        if (s === 'testimonials') return ((inputs.testimonials || []) as unknown[]).length > 0;
        if (s === 'price') return Boolean(inputs.price);
        if (s === 'countdown') return Boolean(inputs.countdown_end);
        return true;
      }),
    };
  } catch (err) {
    return { success: false, error: `Assembly failed: ${err}` };
  }
}

async function uploadToStorage(inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  const html = String(inputs.html || '');
  const fileName = String(inputs.file_name || `lp-${Date.now()}.html`);
  const bucket = String(inputs.bucket || 'landing-pages');

  if (!html) return { success: false, error: 'html content is required' };

  if (!supabaseUrl || !supabaseKey) {
    log.warn('SUPABASE_URL or SUPABASE_SERVICE_KEY not set — cannot upload');
    return {
      success: false,
      error: 'Supabase credentials not configured (SUPABASE_URL, SUPABASE_SERVICE_KEY)',
      html_size: html.length,
      file_name: fileName,
    };
  }

  try {
    const resp = await fetch(
      `${supabaseUrl}/storage/v1/object/${bucket}/${fileName}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'text/html',
          'x-upsert': 'true',
        },
        body: html,
      },
    );

    if (!resp.ok) {
      const errText = await resp.text();
      return { success: false, error: `Upload failed: ${resp.status}`, details: errText.slice(0, 300) };
    }

    const publicUrl = `${supabaseUrl}/storage/v1/object/public/${bucket}/${fileName}`;

    return {
      success: true,
      public_url: publicUrl,
      bucket,
      file_name: fileName,
      size_bytes: new TextEncoder().encode(html).length,
    };
  } catch (err) {
    return { success: false, error: `Upload exception: ${err}` };
  }
}

async function pushToShopify(inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  const storeUrl = process.env.SHOPIFY_STORE_URL?.replace(/\/$/, '');
  const html = String(inputs.html || inputs.body_html || '');
  const title = String(inputs.title || 'Landing Page');
  const handle = String(inputs.handle || `lp-${Date.now()}`);
  const published = inputs.published !== false;

  if (!html) return { success: false, error: 'html content is required' };

  if (!token || !storeUrl) {
    return { success: false, error: 'Shopify credentials not configured (SHOPIFY_ACCESS_TOKEN, SHOPIFY_STORE_URL)' };
  }

  try {
    const resp = await fetch(`${storeUrl}/admin/api/2024-10/pages.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({
        page: { title, handle, body_html: html, published },
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return { success: false, error: `Shopify page creation failed: ${resp.status}`, details: errText.slice(0, 300) };
    }

    const data = await resp.json() as { page: { id: number; handle: string } };
    return {
      success: true,
      page_id: data.page?.id,
      handle: data.page?.handle,
      url: `${storeUrl}/pages/${data.page?.handle}`,
      admin_url: `${storeUrl}/admin/pages/${data.page?.id}`,
    };
  } catch (err) {
    return { success: false, error: `Shopify exception: ${err}` };
  }
}

async function verifyPage(inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = String(inputs.url || '');
  if (!url) return { success: false, error: 'url is required' };

  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'MEOW-HealthCheck/1.0' },
      redirect: 'follow',
    });

    const contentType = resp.headers.get('content-type') || '';
    const contentLength = resp.headers.get('content-length') || 'unknown';

    return {
      success: resp.ok,
      url,
      status: resp.status,
      content_type: contentType,
      content_length: contentLength,
      is_html: contentType.includes('html'),
      redirected: resp.redirected,
      final_url: resp.url,
    };
  } catch (err) {
    return {
      success: false,
      url,
      error: `Verification failed: ${err}`,
      is_live: false,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerDeployLPSkill(): void {
  registerSkillFromTOML(`
[skill]
name = "deploy-lp"
version = "1.0.0"
description = "Build and deploy landing pages to storage or Shopify"
author = "meow"
runtime = "builtin"

[inputs.action]
type = "string"
required = true
description = "Action: assemble, upload, push_shopify, verify"

[inputs.headline]
type = "string"
required = false
description = "Page headline"

[inputs.html]
type = "string"
required = false
description = "Pre-built HTML content"

[inputs.url]
type = "string"
required = false
description = "URL to verify"

[inputs.cta_text]
type = "string"
required = false
description = "Call-to-action button text"

[inputs.cta_url]
type = "string"
required = false
description = "CTA destination URL"

[outputs.success]
type = "boolean"
description = "Whether the operation succeeded"

[outputs.html]
type = "string"
description = "Assembled HTML"

[outputs.public_url]
type = "string"
description = "Public URL of deployed page"

[requirements]
capabilities = ["NetConnect", "FileWrite"]
minTier = "B"
`);

  registerBuiltin('deploy-lp', async (ctx) => {
    const action = String(ctx.inputs.action || 'assemble');
    log.info({ action, moleculeId: ctx.moleculeId }, 'Deploy LP skill executing');

    switch (action) {
      case 'assemble':
        return assemblePage(ctx.inputs);
      case 'upload':
        return uploadToStorage(ctx.inputs);
      case 'push_shopify':
        return pushToShopify(ctx.inputs);
      case 'verify':
        return verifyPage(ctx.inputs);
      default:
        return { success: false, error: `Unknown action: ${action}. Valid: assemble, upload, push_shopify, verify` };
    }
  });

  log.info('Deploy LP skill registered');
}
