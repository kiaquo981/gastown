/**
 * Skill: Content Generation — LP-016 (Stage 04 Wave 3)
 *
 * Multi-modal content generation via AI APIs.
 * Actions: generate_copy, generate_image, generate_voice, generate_video
 *
 * Env: GEMINI_API_KEY (required), FAL_KEY (optional), ELEVENLABS_API_KEY (optional), HEYGEN_API_KEY (optional)
 */

import { registerBuiltin } from '../skill-runtime';
import { registerSkillFromTOML } from '../skill-registry';
import { createLogger } from '../../lib/logger';

const log = createLogger('skill-content-generate');

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const FAL_ENDPOINT = 'https://queue.fal.run';
const ELEVENLABS_ENDPOINT = 'https://api.elevenlabs.io/v1';

// ─────────────────────────────────────────────────────────────────────────────
// Gemini LLM Call
// ─────────────────────────────────────────────────────────────────────────────

function getGeminiModel(tier?: 'S' | 'A' | 'B'): string {
  switch (tier) {
    case 'S': return 'gemini-2.0-flash';
    case 'A': return 'gemini-2.0-flash';
    case 'B': return 'gemini-2.0-flash-lite';
    default: return 'gemini-2.0-flash';
  }
}

async function callGemini(
  systemPrompt: string,
  userMessage: string,
  tier?: 'S' | 'A' | 'B',
): Promise<{ text: string; tokensUsed: number }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { text: '[GEMINI_API_KEY not set] Content generation unavailable', tokensUsed: 0 };
  }

  const model = getGeminiModel(tier);

  try {
    const resp = await fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        max_tokens: 4096,
        temperature: 0.8,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      log.warn({ status: resp.status, body: errText.slice(0, 200) }, 'Gemini call failed');
      return { text: `[Gemini error ${resp.status}]`, tokensUsed: 0 };
    }

    const data = await resp.json() as {
      choices: Array<{ message: { content: string } }>;
      usage?: { total_tokens: number };
    };
    const text = data.choices?.[0]?.message?.content || '';
    const tokensUsed = data.usage?.total_tokens || 0;
    return { text, tokensUsed };
  } catch (err) {
    log.error({ err }, 'Gemini call exception');
    return { text: `[Gemini exception: ${err}]`, tokensUsed: 0 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────────────

async function generateCopy(inputs: Record<string, unknown>, tier?: 'S' | 'A' | 'B'): Promise<Record<string, unknown>> {
  const product = String(inputs.product || inputs.topic || '');
  const audience = String(inputs.audience || 'general');
  const copyType = String(inputs.copy_type || inputs.type || 'headline');
  const framework = String(inputs.framework || 'halbert');
  const tone = String(inputs.tone || 'persuasive');
  const language = String(inputs.language || 'pt-BR');
  const quantity = Number(inputs.quantity || 5);

  const frameworkInstructions: Record<string, string> = {
    halbert: 'Use Gary Halbert\'s Boron Letters framework: personal story, problem, agitate pain, solution, proof, offer, urgency, CTA.',
    schwartz: 'Use Eugene Schwartz\'s 5 levels of awareness framework. Identify the audience awareness level and craft copy accordingly.',
    hormozi: 'Use Alex Hormozi\'s $100M Offers framework: dream outcome, perceived likelihood, time delay, effort/sacrifice.',
    pas: 'Use Problem-Agitate-Solve (PAS) framework.',
    aida: 'Use Attention-Interest-Desire-Action (AIDA) framework.',
  };

  const systemPrompt = `You are a world-class direct response copywriter.
${frameworkInstructions[framework] || frameworkInstructions.halbert}
Write in ${language}. Tone: ${tone}.
Output JSON with keys: "main" (the primary copy), "variations" (array of ${quantity} alternative versions), "hooks" (array of 3 attention-grabbing hooks).`;

  const userMessage = `Product/Service: ${product}
Target Audience: ${audience}
Copy Type: ${copyType}
Generate ${quantity} variations.`;

  const { text, tokensUsed } = await callGemini(systemPrompt, userMessage, tier);

  // Try to parse JSON
  let parsed: Record<string, unknown>;
  try {
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
    parsed = JSON.parse(jsonMatch[1] || text) as Record<string, unknown>;
  } catch {
    parsed = { main: text, variations: [], hooks: [] };
  }

  return { success: true, ...parsed, tokensUsed, framework, copy_type: copyType };
}

async function generateImage(inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
  const falKey = process.env.FAL_KEY;
  const prompt = String(inputs.prompt || inputs.description || '');
  const style = String(inputs.style || 'photorealistic');
  const size = String(inputs.size || 'landscape_16_9');
  const numImages = Number(inputs.num_images || 1);

  if (!prompt) return { success: false, error: 'prompt is required' };

  if (!falKey) {
    log.warn('FAL_KEY not set — returning prompt description only');
    return {
      success: true,
      mode: 'description_only',
      prompt: `${style}: ${prompt}`,
      message: 'FAL_KEY not configured. Set FAL_KEY env var to enable image generation via Fal.ai FLUX.',
    };
  }

  try {
    // Use FLUX schnell for fast generation
    const resp = await fetch(`${FAL_ENDPOINT}/fal-ai/flux/schnell`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Key ${falKey}`,
      },
      body: JSON.stringify({
        prompt: `${style} style: ${prompt}`,
        image_size: size,
        num_images: numImages,
        enable_safety_checker: true,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return { success: false, error: `Fal.ai error ${resp.status}`, details: errText.slice(0, 300) };
    }

    const data = await resp.json() as { images: Array<{ url: string; content_type: string }> };
    return {
      success: true,
      images: data.images || [],
      count: (data.images || []).length,
      prompt,
      style,
    };
  } catch (err) {
    return { success: false, error: `Fal.ai exception: ${err}` };
  }
}

async function generateVoice(inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const text = String(inputs.text || inputs.script || '');
  const voiceId = String(inputs.voice_id || 'pNInz6obpgDQGcFmaJgB'); // Default: Adam
  const modelId = String(inputs.model_id || 'eleven_multilingual_v2');
  const stability = Number(inputs.stability || 0.5);
  const similarityBoost = Number(inputs.similarity_boost || 0.75);

  if (!text) return { success: false, error: 'text is required' };

  if (!apiKey) {
    log.warn('ELEVENLABS_API_KEY not set — returning text description only');
    return {
      success: true,
      mode: 'description_only',
      text,
      voice_id: voiceId,
      message: 'ELEVENLABS_API_KEY not configured. Set it to enable voice generation.',
    };
  }

  try {
    const resp = await fetch(`${ELEVENLABS_ENDPOINT}/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': apiKey,
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: { stability, similarity_boost: similarityBoost },
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return { success: false, error: `ElevenLabs error ${resp.status}`, details: errText.slice(0, 300) };
    }

    // Response is audio binary — get content type and size
    const contentType = resp.headers.get('content-type') || 'audio/mpeg';
    const audioBuffer = await resp.arrayBuffer();

    return {
      success: true,
      content_type: contentType,
      size_bytes: audioBuffer.byteLength,
      voice_id: voiceId,
      model_id: modelId,
      text_length: text.length,
      message: 'Audio generated. Binary data available in pipeline context.',
    };
  } catch (err) {
    return { success: false, error: `ElevenLabs exception: ${err}` };
  }
}

async function generateVideo(inputs: Record<string, unknown>): Promise<Record<string, unknown>> {
  const apiKey = process.env.HEYGEN_API_KEY;
  const script = String(inputs.script || inputs.text || '');
  const avatarId = String(inputs.avatar_id || '');
  const voiceId = String(inputs.voice_id || '');

  if (!script) return { success: false, error: 'script is required' };

  if (!apiKey) {
    log.warn('HEYGEN_API_KEY not set — returning placeholder');
    return {
      success: true,
      mode: 'placeholder',
      script,
      avatar_id: avatarId || 'default',
      message: 'HEYGEN_API_KEY not configured. Set it to enable AI avatar video generation.',
      estimated_duration_seconds: Math.ceil(script.split(' ').length / 2.5),
    };
  }

  try {
    const resp = await fetch('https://api.heygen.com/v2/video/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey,
      },
      body: JSON.stringify({
        video_inputs: [{
          character: { type: 'avatar', avatar_id: avatarId || 'default' },
          voice: { type: 'text', input_text: script, voice_id: voiceId || 'default' },
        }],
        dimension: { width: 1080, height: 1920 },
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return { success: false, error: `HeyGen error ${resp.status}`, details: errText.slice(0, 300) };
    }

    const data = await resp.json() as { data: { video_id: string } };
    return {
      success: true,
      video_id: data.data?.video_id,
      status: 'processing',
      message: 'Video generation started. Poll /v1/video_status.get to check progress.',
    };
  } catch (err) {
    return { success: false, error: `HeyGen exception: ${err}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerContentGenerateSkill(): void {
  registerSkillFromTOML(`
[skill]
name = "content-generate"
version = "1.0.0"
description = "Generate marketing content: copy, images, voice, video via AI APIs"
author = "meow"
runtime = "builtin"

[inputs.action]
type = "string"
required = true
description = "Action: generate_copy, generate_image, generate_voice, generate_video"

[inputs.product]
type = "string"
required = false
description = "Product/service for copy generation"

[inputs.prompt]
type = "string"
required = false
description = "Prompt for image generation"

[inputs.text]
type = "string"
required = false
description = "Text for voice/video generation"

[inputs.framework]
type = "string"
required = false
description = "Copy framework: halbert, schwartz, hormozi, pas, aida"

[inputs.audience]
type = "string"
required = false
description = "Target audience"

[outputs.success]
type = "boolean"
description = "Whether generation succeeded"

[outputs.main]
type = "string"
description = "Primary generated content"

[outputs.variations]
type = "array"
description = "Content variations"

[requirements]
capabilities = ["LLMCall", "NetConnect"]
minTier = "B"
`);

  registerBuiltin('content-generate', async (ctx) => {
    const action = String(ctx.inputs.action || 'generate_copy');
    log.info({ action, moleculeId: ctx.moleculeId, tier: ctx.tier }, 'Content generation skill executing');

    switch (action) {
      case 'generate_copy':
        return generateCopy(ctx.inputs, ctx.tier);
      case 'generate_image':
        return generateImage(ctx.inputs);
      case 'generate_voice':
        return generateVoice(ctx.inputs);
      case 'generate_video':
        return generateVideo(ctx.inputs);
      default:
        return { success: false, error: `Unknown action: ${action}. Valid: generate_copy, generate_image, generate_voice, generate_video` };
    }
  });

  log.info('Content generation skill registered');
}
