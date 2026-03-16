/**
 * Skill: WhatsApp Messaging — LP-015 (Stage 04 Wave 3)
 *
 * Real WhatsApp messaging via Evolution API.
 * Actions: send_text, send_template, send_media, check_status
 *
 * Env: EVOLUTION_API_URL, EVOLUTION_INSTANCE, EVOLUTION_API_KEY
 */

import { registerBuiltin } from '../skill-runtime';
import { registerSkillFromTOML } from '../skill-registry';
import { createLogger } from '../../lib/logger';

const log = createLogger('skill-whatsapp');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface EvolutionConfig {
  apiUrl: string;
  instance: string;
  apiKey: string;
}

function getEvolutionConfig(): EvolutionConfig | null {
  const apiUrl = process.env.EVOLUTION_API_URL;
  const instance = process.env.EVOLUTION_INSTANCE;
  const apiKey = process.env.EVOLUTION_API_KEY;
  if (!apiUrl || !instance || !apiKey) {
    log.warn('EVOLUTION_API_URL, EVOLUTION_INSTANCE, or EVOLUTION_API_KEY not set — WhatsApp skill disabled');
    return null;
  }
  return { apiUrl: apiUrl.replace(/\/$/, ''), instance, apiKey };
}

function normalizePhone(phone: string): string {
  // Remove non-numeric chars, ensure country code
  const cleaned = phone.replace(/\D/g, '');
  // If starts with 0, assume BR
  if (cleaned.startsWith('0')) return `55${cleaned.slice(1)}`;
  // If no country code (less than 12 digits for BR), prepend 55
  if (cleaned.length <= 11) return `55${cleaned}`;
  return cleaned;
}

async function evolutionApi(
  config: EvolutionConfig,
  path: string,
  method: 'GET' | 'POST' = 'POST',
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; data: Record<string, unknown>; status: number }> {
  const url = `${config.apiUrl}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'apikey': config.apiKey,
  };

  const init: RequestInit = { method, headers };
  if (body && method === 'POST') init.body = JSON.stringify(body);

  try {
    const resp = await fetch(url, init);
    let data: Record<string, unknown>;
    const text = await resp.text();
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = { raw: text };
    }
    return { ok: resp.ok, data, status: resp.status };
  } catch (err) {
    return { ok: false, data: { error: String(err) }, status: 0 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────

async function sendText(
  config: EvolutionConfig,
  inputs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const number = normalizePhone(String(inputs.number || inputs.phone || ''));
  const text = String(inputs.text || inputs.message || '');
  if (!number) return { success: false, error: 'number is required' };
  if (!text) return { success: false, error: 'text is required' };

  const resp = await evolutionApi(config, `/message/sendText/${config.instance}`, 'POST', {
    number,
    text,
    delay: Number(inputs.delay || 0),
  });

  return {
    success: resp.ok,
    number,
    message_id: resp.data.key ? (resp.data.key as Record<string, unknown>).id : undefined,
    details: resp.ok ? undefined : resp.data,
  };
}

async function sendTemplate(
  config: EvolutionConfig,
  inputs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const number = normalizePhone(String(inputs.number || inputs.phone || ''));
  const templateName = String(inputs.template_name || '');
  const language = String(inputs.language || 'pt_BR');
  const components = inputs.components as unknown[] | undefined;

  if (!number) return { success: false, error: 'number is required' };
  if (!templateName) return { success: false, error: 'template_name is required' };

  const resp = await evolutionApi(config, `/message/sendTemplate/${config.instance}`, 'POST', {
    number,
    name: templateName,
    language,
    components: components || [],
  });

  return {
    success: resp.ok,
    number,
    template: templateName,
    message_id: resp.data.key ? (resp.data.key as Record<string, unknown>).id : undefined,
    details: resp.ok ? undefined : resp.data,
  };
}

async function sendMedia(
  config: EvolutionConfig,
  inputs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const number = normalizePhone(String(inputs.number || inputs.phone || ''));
  const mediaType = String(inputs.media_type || 'image'); // image, video, document, audio
  const mediaUrl = String(inputs.media_url || inputs.url || '');
  const caption = String(inputs.caption || '');
  const fileName = String(inputs.file_name || 'file');

  if (!number) return { success: false, error: 'number is required' };
  if (!mediaUrl) return { success: false, error: 'media_url is required' };

  const endpointMap: Record<string, string> = {
    image: 'sendMedia',
    video: 'sendMedia',
    document: 'sendMedia',
    audio: 'sendWhatsAppAudio',
  };

  const endpoint = endpointMap[mediaType] || 'sendMedia';
  const body: Record<string, unknown> = {
    number,
    mediatype: mediaType,
    media: mediaUrl,
    caption,
    fileName,
  };

  const resp = await evolutionApi(config, `/message/${endpoint}/${config.instance}`, 'POST', body);

  return {
    success: resp.ok,
    number,
    media_type: mediaType,
    message_id: resp.data.key ? (resp.data.key as Record<string, unknown>).id : undefined,
    details: resp.ok ? undefined : resp.data,
  };
}

async function checkStatus(
  config: EvolutionConfig,
  inputs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const number = normalizePhone(String(inputs.number || inputs.phone || ''));
  if (!number) return { success: false, error: 'number is required' };

  const resp = await evolutionApi(config, `/chat/whatsappNumbers/${config.instance}`, 'POST', {
    numbers: [number],
  });

  if (!resp.ok) {
    return { success: false, error: 'Failed to check status', details: resp.data };
  }

  const results = (resp.data as unknown as Array<Record<string, unknown>>) || [];
  const found = Array.isArray(results)
    ? results.find(r => String(r.jid || '').includes(number.slice(-10)))
    : null;

  return {
    success: true,
    number,
    exists: found ? Boolean(found.exists) : false,
    jid: found?.jid || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerWhatsAppSkill(): void {
  registerSkillFromTOML(`
[skill]
name = "whatsapp-send"
version = "1.0.0"
description = "Send WhatsApp messages via Evolution API"
author = "meow"
runtime = "builtin"

[inputs.action]
type = "string"
required = true
description = "Action: send_text, send_template, send_media, check_status"

[inputs.number]
type = "string"
required = true
description = "Phone number with country code (e.g. 5511999999999)"

[inputs.text]
type = "string"
required = false
description = "Text message content"

[inputs.template_name]
type = "string"
required = false
description = "Template name for send_template"

[inputs.media_url]
type = "string"
required = false
description = "Media URL for send_media"

[inputs.media_type]
type = "string"
required = false
description = "Media type: image, video, document, audio"

[outputs.success]
type = "boolean"
description = "Whether the message was sent"

[outputs.message_id]
type = "string"
description = "Message ID from WhatsApp"

[requirements]
capabilities = ["WhatsAppSend", "NetConnect"]
minTier = "B"
`);

  registerBuiltin('whatsapp-send', async (ctx) => {
    const config = getEvolutionConfig();
    if (!config) {
      return { success: false, error: 'Evolution API credentials not configured (EVOLUTION_API_URL, EVOLUTION_INSTANCE, EVOLUTION_API_KEY)' };
    }

    const action = String(ctx.inputs.action || 'send_text');
    log.info({ action, moleculeId: ctx.moleculeId }, 'WhatsApp skill executing');

    switch (action) {
      case 'send_text':
        return sendText(config, ctx.inputs);
      case 'send_template':
        return sendTemplate(config, ctx.inputs);
      case 'send_media':
        return sendMedia(config, ctx.inputs);
      case 'check_status':
        return checkStatus(config, ctx.inputs);
      default:
        return { success: false, error: `Unknown action: ${action}. Valid: send_text, send_template, send_media, check_status` };
    }
  });

  log.info('WhatsApp skill registered');
}
