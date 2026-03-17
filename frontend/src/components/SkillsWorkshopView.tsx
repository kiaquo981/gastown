'use client';

/**
 * SkillsWorkshopView — GT-027: Skills Workshop
 *
 * Skill catalog with cards: name, runtime badge, description preview,
 * capabilities list (tag pills), tools list, search + filter, stats bar.
 * Ayu Dark aesthetic: bg-[#0f1419], border-[#2d363f], text-[#e6e1cf], font-mono, rounded-none.
 * Polls GET /api/meow/skills every 8s with AbortController cleanup.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ORCHESTRATOR_URL as API } from '@/lib/config';

// ─── Types ──────────────────────────────────────────────────────────────────

interface Skill {
  name: string;
  description: string;
  runtime: string;
  capabilities: string[];
  tools: string[];
  inputSchema: Record<string, unknown>;
}

interface SkillsResponse {
  skills: Skill[];
  count: number;
}

type RuntimeFilter = 'all' | 'node' | 'python' | 'shell';

// ─── Runtime Config ─────────────────────────────────────────────────────────

const RUNTIME_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  node:   { bg: 'bg-emerald-500/10', text: 'text-emerald-400', border: 'border-emerald-500/20' },
  python: { bg: 'bg-sky-500/10',     text: 'text-sky-400',     border: 'border-sky-500/20' },
  shell:  { bg: 'bg-amber-500/10',   text: 'text-amber-400',   border: 'border-amber-500/20' },
};

const POLL_INTERVAL = 8000;

// ─── Fallback Data ──────────────────────────────────────────────────────────

const FALLBACK_SKILLS: Skill[] = [
  {
    name: 'web-scraper',
    description: 'Scrape and extract structured data from any web page using headless browser automation with CSS selectors and XPath queries.',
    runtime: 'node',
    capabilities: ['web-scraping', 'data-extraction', 'html-parsing', 'screenshot'],
    tools: ['puppeteer', 'cheerio', 'axios'],
    inputSchema: { url: { type: 'string' }, selector: { type: 'string' }, format: { type: 'string', enum: ['json', 'csv'] } },
  },
  {
    name: 'data-analyzer',
    description: 'Run statistical analysis and generate visualizations on tabular data using pandas and matplotlib pipelines.',
    runtime: 'python',
    capabilities: ['data-analysis', 'visualization', 'statistics', 'csv-processing'],
    tools: ['pandas', 'matplotlib', 'numpy', 'scipy'],
    inputSchema: { dataset: { type: 'string' }, analysis_type: { type: 'string' }, columns: { type: 'array' } },
  },
  {
    name: 'deploy-runner',
    description: 'Execute deployment scripts with environment variable injection, health checks, and rollback support.',
    runtime: 'shell',
    capabilities: ['deployment', 'ci-cd', 'health-check', 'rollback'],
    tools: ['bash', 'curl', 'docker', 'ssh'],
    inputSchema: { target: { type: 'string' }, env: { type: 'string', enum: ['staging', 'production'] } },
  },
  {
    name: 'llm-chain',
    description: 'Build and execute multi-step LLM reasoning chains with memory, tool use, and structured output validation.',
    runtime: 'python',
    capabilities: ['llm-orchestration', 'prompt-chaining', 'tool-use', 'memory'],
    tools: ['langchain', 'openai', 'tiktoken'],
    inputSchema: { prompt: { type: 'string' }, model: { type: 'string' }, temperature: { type: 'number' } },
  },
  {
    name: 'api-tester',
    description: 'Automated REST API testing with assertion chains, response validation, and performance benchmarks.',
    runtime: 'node',
    capabilities: ['api-testing', 'assertion', 'benchmarking', 'schema-validation'],
    tools: ['supertest', 'ajv', 'pino'],
    inputSchema: { base_url: { type: 'string' }, method: { type: 'string' }, path: { type: 'string' } },
  },
  {
    name: 'file-converter',
    description: 'Convert files between formats: PDF to text, CSV to JSON, images to WebP, audio transcription.',
    runtime: 'python',
    capabilities: ['file-conversion', 'pdf-parsing', 'image-processing', 'transcription'],
    tools: ['pdfplumber', 'pillow', 'ffmpeg', 'whisper'],
    inputSchema: { input_path: { type: 'string' }, output_format: { type: 'string' } },
  },
  {
    name: 'cron-scheduler',
    description: 'Schedule and manage recurring tasks with cron expressions, retry logic, and failure notifications.',
    runtime: 'shell',
    capabilities: ['scheduling', 'cron', 'retry', 'notification'],
    tools: ['cron', 'systemd', 'curl', 'jq'],
    inputSchema: { expression: { type: 'string' }, command: { type: 'string' }, retries: { type: 'number' } },
  },
  {
    name: 'code-reviewer',
    description: 'AI-powered code review analyzing style, bugs, security vulnerabilities, and performance issues.',
    runtime: 'node',
    capabilities: ['code-review', 'security-audit', 'style-check', 'performance'],
    tools: ['eslint', 'semgrep', 'openai'],
    inputSchema: { repo: { type: 'string' }, branch: { type: 'string' }, language: { type: 'string' } },
  },
];

// ─── Component ──────────────────────────────────────────────────────────────

export default function SkillsWorkshopView() {
  const [skills, setSkills] = useState<Skill[]>(FALLBACK_SKILLS);
  const [search, setSearch] = useState('');
  const [runtimeFilter, setRuntimeFilter] = useState<RuntimeFilter>('all');
  const [capabilityFilter, setCapabilityFilter] = useState('');
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);
  const [executingSkill, setExecutingSkill] = useState<string | null>(null);
  const [executionOutput, setExecutionOutput] = useState<Record<string, string>>({});
  const [dataSource, setDataSource] = useState<'loading' | 'real' | 'demo'>('loading');
  const abortRef = useRef<AbortController | null>(null);

  // ── Fetch Skills ────────────────────────────────────────────────────────
  const fetchSkills = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch(`${API}/api/meow/skills`, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: SkillsResponse = await res.json();
      if (data.skills && data.skills.length > 0) {
        setSkills(data.skills);
        setDataSource('real');
      } else {
        setDataSource('demo');
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setDataSource('demo');
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    fetchSkills(ctrl.signal);
    const iv = setInterval(() => fetchSkills(ctrl.signal), POLL_INTERVAL);
    return () => { ctrl.abort(); clearInterval(iv); };
  }, [fetchSkills]);

  // ── Execute Skill ───────────────────────────────────────────────────────
  const executeSkill = useCallback(async (skillName: string) => {
    setExecutingSkill(skillName);
    setExecutionOutput(prev => ({ ...prev, [skillName]: '' }));
    try {
      const res = await fetch(`${API}/api/meow/skills/${skillName}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: {} }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setExecutionOutput(prev => ({
        ...prev,
        [skillName]: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
      }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setExecutionOutput(prev => ({ ...prev, [skillName]: `Error: ${msg}` }));
    } finally {
      setExecutingSkill(null);
    }
  }, []);

  // ── Derived Data ────────────────────────────────────────────────────────
  const allCapabilities = useMemo(() => {
    const set = new Set<string>();
    skills.forEach(s => (s.capabilities ?? []).forEach(c => set.add(c)));
    return Array.from(set).sort();
  }, [skills]);

  const runtimeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    skills.forEach(s => { counts[s.runtime] = (counts[s.runtime] || 0) + 1; });
    return counts;
  }, [skills]);

  const filtered = useMemo(() => {
    return skills.filter(s => {
      if (runtimeFilter !== 'all' && s.runtime !== runtimeFilter) return false;
      if (capabilityFilter && !s.capabilities.includes(capabilityFilter)) return false;
      if (search) {
        const q = search.toLowerCase();
        return (
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          s.capabilities.some(c => c.toLowerCase().includes(q)) ||
          s.tools.some(t => t.toLowerCase().includes(q))
        );
      }
      return true;
    });
  }, [skills, runtimeFilter, capabilityFilter, search]);

  // ── Render ──────────────────────────────────────────────────────────────
  const rtColors = (rt: string) => RUNTIME_COLORS[rt] || { bg: 'bg-white/5', text: 'text-[#6c7680]', border: 'border-[#2d363f]' };

  return (
    <div className="min-h-screen bg-[#0f1419] text-[#e6e1cf] font-mono p-6 space-y-6">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white/95">Skills Workshop</h1>
          <p className="text-sm text-[#4a5159] mt-1">GT-027 &middot; Skill catalog, search, and execution</p>
        </div>
        <div className="flex items-center gap-3">
          {dataSource === 'real' && (
            <span className="px-2 py-1 text-[10px] uppercase tracking-wider bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-none">
              Live Data
            </span>
          )}
          {dataSource === 'demo' && (
            <span className="px-2 py-1 text-[10px] uppercase tracking-wider bg-amber-500/10 text-amber-400 border border-amber-500/20 rounded-none">
              Demo Data
            </span>
          )}
          {dataSource === 'loading' && (
            <span className="px-2 py-1 text-[10px] uppercase tracking-wider bg-white/5 text-[#4a5159] border border-[#2d363f] rounded-none animate-pulse">
              Loading...
            </span>
          )}
        </div>
      </div>

      {/* ── Stats Bar ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
        <StatBox label="Total Skills" value={skills.length} />
        {Object.entries(runtimeCounts).map(([rt, ct]) => (
          <StatBox key={rt} label={rt.toUpperCase()} value={ct} accent={rtColors(rt).text} />
        ))}
        <StatBox label="Capabilities" value={allCapabilities.length} />
        <StatBox label="Filtered" value={filtered.length} />
      </div>

      {/* ── Search + Filters ───────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-3">
        <input
          type="text"
          placeholder="Search skills, capabilities, tools..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="flex-1 min-w-[240px] px-3 py-2 bg-[#1a1f26] border border-[#2d363f] rounded-none text-sm text-[#e6e1cf] placeholder:text-white/20 outline-none focus:border-white/20 transition-colors font-mono"
        />
        <div className="flex gap-1">
          {(['all', 'node', 'python', 'shell'] as RuntimeFilter[]).map(rt => (
            <button
              key={rt}
              onClick={() => setRuntimeFilter(rt)}
              className={`px-3 py-2 text-xs uppercase tracking-wider border rounded-none transition-all ${
                runtimeFilter === rt
                  ? 'bg-white/10 border-white/20 text-white/90'
                  : 'bg-[#1a1f26] border-[#2d363f] text-[#4a5159] hover:text-[#6c7680]'
              }`}
            >
              {rt}
            </button>
          ))}
        </div>
        <select
          value={capabilityFilter}
          onChange={e => setCapabilityFilter(e.target.value)}
          className="px-3 py-2 bg-[#1a1f26] border border-[#2d363f] rounded-none text-sm text-[#e6e1cf] outline-none focus:border-white/20 transition-colors font-mono"
        >
          <option value="">All Capabilities</option>
          {allCapabilities.map(c => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>

      {/* ── Skill Cards Grid ───────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        <AnimatePresence mode="popLayout">
          {filtered.map((skill, i) => {
            const rt = rtColors(skill.runtime);
            const isExpanded = expandedSkill === skill.name;
            const isExecuting = executingSkill === skill.name;
            const output = executionOutput[skill.name];

            return (
              <motion.div
                key={skill.name}
                layout
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.25, delay: i * 0.03 }}
                className={`bg-[#1a1f26] border rounded-none transition-all cursor-pointer ${
                  isExpanded ? 'border-white/20 col-span-1 md:col-span-2 xl:col-span-3' : 'border-[#2d363f] hover:border-[#2d363f]'
                }`}
                onClick={() => setExpandedSkill(isExpanded ? null : skill.name)}
              >
                {/* Card Header */}
                <div className="p-4">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-semibold text-white/90 tracking-tight">{skill.name}</h3>
                    <span className={`px-2 py-0.5 text-[10px] uppercase tracking-wider border rounded-none ${rt.bg} ${rt.text} ${rt.border}`}>
                      {skill.runtime}
                    </span>
                  </div>
                  <p className="text-xs text-[#4a5159] leading-relaxed line-clamp-2">{skill.description}</p>

                  {/* Capabilities */}
                  <div className="flex flex-wrap gap-1.5 mt-3">
                    {skill.capabilities.slice(0, isExpanded ? undefined : 3).map(cap => (
                      <span
                        key={cap}
                        className="px-2 py-0.5 text-[10px] bg-white/[0.04] border border-white/[0.06] text-white/50 rounded-none"
                      >
                        {cap}
                      </span>
                    ))}
                    {!isExpanded && skill.capabilities.length > 3 && (
                      <span className="px-2 py-0.5 text-[10px] text-white/25">
                        +{skill.capabilities.length - 3}
                      </span>
                    )}
                  </div>

                  {/* Tools */}
                  <div className="flex items-center gap-2 mt-3">
                    <span className="text-[10px] uppercase tracking-wider text-white/20">Tools:</span>
                    <div className="flex flex-wrap gap-1">
                      {skill.tools.map(tool => (
                        <span key={tool} className="text-[10px] text-[#4a5159]">{tool}</span>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Expanded Section */}
                <AnimatePresence>
                  {isExpanded && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="overflow-hidden"
                      onClick={e => e.stopPropagation()}
                    >
                      <div className="border-t border-[#2d363f] p-4 space-y-4">
                        {/* Input Schema */}
                        <div>
                          <h4 className="text-[10px] uppercase tracking-wider text-[#4a5159] mb-2">Input Schema</h4>
                          <pre className="text-[11px] text-white/50 bg-[#0f1419] border border-[#2d363f] p-3 rounded-none overflow-x-auto">
                            {JSON.stringify(skill.inputSchema, null, 2)}
                          </pre>
                        </div>

                        {/* All Capabilities */}
                        <div>
                          <h4 className="text-[10px] uppercase tracking-wider text-[#4a5159] mb-2">All Capabilities</h4>
                          <div className="flex flex-wrap gap-1.5">
                            {skill.capabilities.map(cap => (
                              <span key={cap} className="px-2 py-0.5 text-[10px] bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-none">
                                {cap}
                              </span>
                            ))}
                          </div>
                        </div>

                        {/* Execute Button */}
                        <div className="flex items-center gap-3">
                          <button
                            onClick={() => executeSkill(skill.name)}
                            disabled={isExecuting}
                            className="px-4 py-2 text-xs uppercase tracking-wider bg-white/5 border border-[#2d363f] text-white/70 hover:bg-white/10 hover:text-white/90 transition-all rounded-none disabled:opacity-40"
                          >
                            {isExecuting ? (
                              <span className="flex items-center gap-2">
                                <motion.span
                                  animate={{ rotate: 360 }}
                                  transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
                                  className="inline-block w-3 h-3 border border-white/40 border-t-transparent rounded-full"
                                />
                                Executing...
                              </span>
                            ) : (
                              'Execute Skill'
                            )}
                          </button>
                        </div>

                        {/* Execution Output */}
                        {output && (
                          <div>
                            <h4 className="text-[10px] uppercase tracking-wider text-[#4a5159] mb-2">Output</h4>
                            <pre className="text-[11px] text-emerald-400/70 bg-[#0f1419] border border-[#2d363f] p-3 rounded-none overflow-x-auto max-h-[200px] overflow-y-auto">
                              {output}
                            </pre>
                          </div>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      {/* Empty State */}
      {filtered.length === 0 && (
        <div className="text-center py-20">
          <p className="text-white/20 text-sm">No skills match your filters</p>
          <button
            onClick={() => { setSearch(''); setRuntimeFilter('all'); setCapabilityFilter(''); }}
            className="mt-3 text-xs text-[#4a5159] hover:text-[#6c7680] underline transition-colors"
          >
            Reset filters
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Sub-Components ─────────────────────────────────────────────────────────

function StatBox({ label, value, accent }: { label: string; value: number | string; accent?: string }) {
  return (
    <div className="bg-[#1a1f26] border border-[#2d363f] rounded-none p-3">
      <p className="text-[10px] uppercase tracking-wider text-white/25 mb-1">{label}</p>
      <p className={`text-lg font-bold tabular-nums ${accent || 'text-white/80'}`}>{value}</p>
    </div>
  );
}
