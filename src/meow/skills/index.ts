/**
 * Stage 04 Wave 3 — Skill Implementations Index
 *
 * 8 real skill implementations for the MEOW system.
 * Each skill registers both its TOML manifest and builtin handler.
 *
 * LP-013: Meta Ads Management (Marketing API)
 * LP-014: Shopify Management (Admin API)
 * LP-015: WhatsApp Messaging (Evolution API)
 * LP-016: Content Generation (Gemini/Fal.ai/ElevenLabs/HeyGen)
 * LP-017: Data Analysis (Supabase/Postgres)
 * LP-018: Web Scraping (Apify + Gemini fallback)
 * LP-019: Landing Page Deployment (Storage + Shopify Pages)
 * LP-020: Git Operations (git + gh CLI)
 */

import { createLogger } from '../../lib/logger';

import { registerMetaAdsSkill } from './skill-meta-ads';
import { registerShopifySkill } from './skill-shopify';
import { registerWhatsAppSkill } from './skill-whatsapp';
import { registerContentGenerateSkill } from './skill-content-generate';
import { registerDataAnalyzeSkill } from './skill-data-analyze';
import { registerWebScrapeSkill } from './skill-web-scrape';
import { registerDeployLPSkill } from './skill-deploy-lp';
import { registerGitOpsSkill } from './skill-git-ops';

const log = createLogger('stage04-skills');

/**
 * Register all Stage 04 Wave 3 skills.
 * Call this from the MEOW init sequence after builtin-skills.
 */
export function registerAllStage04Skills(): number {
  const skills = [
    { name: 'meta-ads-manage', register: registerMetaAdsSkill },
    { name: 'shopify-manage', register: registerShopifySkill },
    { name: 'whatsapp-send', register: registerWhatsAppSkill },
    { name: 'content-generate', register: registerContentGenerateSkill },
    { name: 'data-analyze', register: registerDataAnalyzeSkill },
    { name: 'web-scrape', register: registerWebScrapeSkill },
    { name: 'deploy-lp', register: registerDeployLPSkill },
    { name: 'git-operations', register: registerGitOpsSkill },
  ];

  let loaded = 0;

  for (const skill of skills) {
    try {
      skill.register();
      loaded++;
    } catch (err) {
      log.error({ err, skill: skill.name }, `Failed to register Stage 04 skill: ${skill.name}`);
    }
  }

  log.info({ loaded, total: skills.length }, 'Stage 04 Wave 3 skills registered');
  return loaded;
}

// Re-export individual registrations for selective loading
export { registerMetaAdsSkill } from './skill-meta-ads';
export { registerShopifySkill } from './skill-shopify';
export { registerWhatsAppSkill } from './skill-whatsapp';
export { registerContentGenerateSkill } from './skill-content-generate';
export { registerDataAnalyzeSkill } from './skill-data-analyze';
export { registerWebScrapeSkill } from './skill-web-scrape';
export { registerDeployLPSkill } from './skill-deploy-lp';
export { registerGitOpsSkill } from './skill-git-ops';
