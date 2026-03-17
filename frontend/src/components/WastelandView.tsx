'use client';

/**
 * WastelandView — Federation System: A Thousand Gas Towns
 *
 * Yegge's Wasteland concept: connecting multiple Gas Towns together
 * via DoltHub-backed federation. Wanted board, town registry,
 * sync history, and trust/reputation.
 *
 * AYU DARK: bg #0f1419, cards #1a1f26, text #e6e1cf, muted #6c7680
 * border #2d363f, green #c2d94c, yellow #ffb454, red #f07178,
 * cyan #95e6cb, purple #d2a6ff. Font-mono, rounded-none.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ORCHESTRATOR_URL as API } from '@/lib/config';

// ── Ayu Dark palette ────────────────────────────────────────────────────────
const C = {
  bg: '#0f1419',
  card: '#1a1f26',
  text: '#e6e1cf',
  muted: '#6c7680',
  border: '#2d363f',
  green: '#c2d94c',
  yellow: '#ffb454',
  red: '#f07178',
  cyan: '#95e6cb',
  purple: '#d2a6ff',
} as const;

// ── Types ───────────────────────────────────────────────────────────────────

type WantedDifficulty = 'trivial' | 'easy' | 'medium' | 'hard' | 'legendary';
type WantedStatus = 'open' | 'claimed' | 'completed';
type TownStatus = 'online' | 'offline' | 'stale';
type SyncOp = 'push' | 'pull' | 'merge';

interface WantedItem {
  id: string;
  title: string;
  description: string;
  reward: number;
  difficulty: WantedDifficulty;
  status: WantedStatus;
  postedBy: string;
  postedByTown: string;
  claimedBy?: string;
  createdAt: string;
  completedAt?: string;
  tags?: string[];
}

interface FederatedTown {
  id: string;
  name: string;
  handle: string;
  rigCount: number;
  trustScore: number;
  status: TownStatus;
  lastSeen: string;
  region?: string;
  version?: string;
}

interface SyncEvent {
  id: string;
  op: SyncOp;
  timestamp: string;
  itemsSynced: number;
  conflicts: number;
  remoteTown?: string;
  durationMs?: number;
  summary?: string;
}

interface TownIdentity {
  name: string;
  handle: string;
  rigCount: number;
  upstreamPath?: string;
  federationStatus: 'connected' | 'disconnected';
  lastSync?: string;
  reputationScore?: number;
  completedContributions?: number;
}

// ── Constants ───────────────────────────────────────────────────────────────

const DIFFICULTY_CONFIG: Record<WantedDifficulty, { label: string; color: string; badge: string }> = {
  trivial:   { label: 'Trivial',   color: C.muted,  badge: 'bg-[#6c7680]/15 text-[#6c7680] border-[#6c7680]/30' },
  easy:      { label: 'Easy',      color: C.green,  badge: 'bg-[#c2d94c]/15 text-[#c2d94c] border-[#c2d94c]/30' },
  medium:    { label: 'Medium',    color: C.yellow, badge: 'bg-[#ffb454]/15 text-[#ffb454] border-[#ffb454]/30' },
  hard:      { label: 'Hard',      color: C.red,    badge: 'bg-[#f07178]/15 text-[#f07178] border-[#f07178]/30' },
  legendary: { label: 'Legendary', color: C.purple, badge: 'bg-[#d2a6ff]/15 text-[#d2a6ff] border-[#d2a6ff]/30' },
};

const STATUS_CONFIG: Record<WantedStatus, { label: string; color: string; badge: string }> = {
  open:      { label: 'Open',      color: C.green,  badge: 'bg-[#c2d94c]/15 text-[#c2d94c] border-[#c2d94c]/30' },
  claimed:   { label: 'Claimed',   color: C.yellow, badge: 'bg-[#ffb454]/15 text-[#ffb454] border-[#ffb454]/30' },
  completed: { label: 'Completed', color: C.cyan,   badge: 'bg-[#95e6cb]/15 text-[#95e6cb] border-[#95e6cb]/30' },
};

const SYNC_OP_COLORS: Record<SyncOp, string> = {
  push:  C.cyan,
  pull:  C.purple,
  merge: C.yellow,
};

// ── Mock federation data (federation is not live yet) ───────────────────────

function generateMockTowns(): FederatedTown[] {
  const towns: FederatedTown[] = [
    { id: 'town-alpha', name: 'Alpha Refinery', handle: '@alpha-refinery', rigCount: 14, trustScore: 92, status: 'online', lastSeen: new Date(Date.now() - 30_000).toISOString(), region: 'US-West', version: '0.9.4' },
    { id: 'town-beta', name: 'Beta Forge', handle: '@beta-forge', rigCount: 8, trustScore: 78, status: 'online', lastSeen: new Date(Date.now() - 120_000).toISOString(), region: 'EU-Central', version: '0.9.3' },
    { id: 'town-gamma', name: 'Gamma Works', handle: '@gamma-works', rigCount: 22, trustScore: 95, status: 'online', lastSeen: new Date(Date.now() - 45_000).toISOString(), region: 'US-East', version: '0.9.4' },
    { id: 'town-delta', name: 'Delta Pit', handle: '@delta-pit', rigCount: 5, trustScore: 45, status: 'stale', lastSeen: new Date(Date.now() - 7_200_000).toISOString(), region: 'APAC', version: '0.9.1' },
    { id: 'town-epsilon', name: 'Epsilon Yards', handle: '@epsilon-yards', rigCount: 11, trustScore: 67, status: 'online', lastSeen: new Date(Date.now() - 60_000).toISOString(), region: 'US-West', version: '0.9.4' },
    { id: 'town-zeta', name: 'Zeta Outpost', handle: '@zeta-outpost', rigCount: 3, trustScore: 31, status: 'offline', lastSeen: new Date(Date.now() - 86_400_000).toISOString(), region: 'SA', version: '0.8.7' },
    { id: 'town-eta', name: 'Eta Station', handle: '@eta-station', rigCount: 17, trustScore: 88, status: 'online', lastSeen: new Date(Date.now() - 15_000).toISOString(), region: 'EU-West', version: '0.9.4' },
  ];
  return towns;
}

function generateMockWanted(): WantedItem[] {
  return [
    { id: 'w-001', title: 'Port Terraform provider to TOML config', description: 'Need someone to convert existing Terraform HCL configs into Gas Town TOML formula format. Includes variable mapping and step dependencies.', reward: 350, difficulty: 'hard', status: 'open', postedBy: '@gamma-works', postedByTown: 'Gamma Works', createdAt: new Date(Date.now() - 3_600_000).toISOString(), tags: ['terraform', 'toml', 'formula'] },
    { id: 'w-002', title: 'Write patrol formula for Redis health', description: 'Deacon patrol formula that checks Redis cluster health, memory usage, and replication lag.', reward: 150, difficulty: 'medium', status: 'claimed', postedBy: '@alpha-refinery', postedByTown: 'Alpha Refinery', claimedBy: '@beta-forge', createdAt: new Date(Date.now() - 7_200_000).toISOString(), tags: ['patrol', 'redis', 'health'] },
    { id: 'w-003', title: 'Design Polecat skill for log rotation', description: 'Create a new Polecat skill that handles log rotation across tmux sessions with configurable retention.', reward: 200, difficulty: 'medium', status: 'open', postedBy: '@eta-station', postedByTown: 'Eta Station', createdAt: new Date(Date.now() - 14_400_000).toISOString(), tags: ['polecat', 'skill', 'logs'] },
    { id: 'w-004', title: 'Add DoltHub merge conflict resolver', description: 'Implement automatic 3-way merge for DoltHub sync conflicts using last-writer-wins strategy with audit trail.', reward: 500, difficulty: 'legendary', status: 'open', postedBy: '@gamma-works', postedByTown: 'Gamma Works', createdAt: new Date(Date.now() - 28_800_000).toISOString(), tags: ['dolt', 'merge', 'sync'] },
    { id: 'w-005', title: 'Bead compression utility', description: 'Simple bead compressor that deduplicates and compresses bead chains older than 7 days.', reward: 50, difficulty: 'easy', status: 'completed', postedBy: '@epsilon-yards', postedByTown: 'Epsilon Yards', claimedBy: '@alpha-refinery', createdAt: new Date(Date.now() - 86_400_000).toISOString(), completedAt: new Date(Date.now() - 43_200_000).toISOString(), tags: ['beads', 'compression'] },
    { id: 'w-006', title: 'Fix tmux session leak in convoy teardown', description: 'Convoy teardown sometimes leaves orphaned tmux sessions. Need cleanup logic in the molecule completion handler.', reward: 120, difficulty: 'easy', status: 'open', postedBy: '@beta-forge', postedByTown: 'Beta Forge', createdAt: new Date(Date.now() - 10_800_000).toISOString(), tags: ['tmux', 'convoy', 'bugfix'] },
    { id: 'w-007', title: 'NDI bridge for cross-town notifications', description: 'Extend NDI (Notification Dispatch Interface) to route notifications across federated towns via webhook relay.', reward: 400, difficulty: 'hard', status: 'claimed', postedBy: '@gamma-works', postedByTown: 'Gamma Works', claimedBy: '@eta-station', createdAt: new Date(Date.now() - 172_800_000).toISOString(), tags: ['ndi', 'federation', 'webhook'] },
    { id: 'w-008', title: 'Document Seance ritual patterns', description: 'Write comprehensive docs for Seance debugging ritual patterns with examples.', reward: 30, difficulty: 'trivial', status: 'open', postedBy: '@alpha-refinery', postedByTown: 'Alpha Refinery', createdAt: new Date(Date.now() - 259_200_000).toISOString(), tags: ['seance', 'docs'] },
  ];
}

function generateMockSyncHistory(): SyncEvent[] {
  const events: SyncEvent[] = [];
  const ops: SyncOp[] = ['push', 'pull', 'merge'];
  const towns = ['Alpha Refinery', 'Beta Forge', 'Gamma Works', 'Eta Station'];
  for (let i = 0; i < 15; i++) {
    const op = ops[Math.floor(Math.random() * ops.length)];
    events.push({
      id: `sync-${i}`,
      op,
      timestamp: new Date(Date.now() - i * 1_800_000 - Math.random() * 600_000).toISOString(),
      itemsSynced: Math.floor(Math.random() * 50) + 1,
      conflicts: op === 'merge' ? Math.floor(Math.random() * 5) : 0,
      remoteTown: towns[Math.floor(Math.random() * towns.length)],
      durationMs: Math.floor(Math.random() * 5000) + 200,
      summary: op === 'push' ? 'Pushed local changes to commons' : op === 'pull' ? 'Pulled updates from commons' : 'Merged divergent branches',
    });
  }
  return events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

// ── Trust Score Bar ─────────────────────────────────────────────────────────

function TrustBar({ score }: { score: number }) {
  const color = score > 70 ? C.green : score > 40 ? C.yellow : C.red;
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-[#2d363f]/50">
        <motion.div
          className="h-full"
          style={{ background: color }}
          initial={{ width: 0 }}
          animate={{ width: `${score}%` }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
        />
      </div>
      <span className="text-[10px] font-mono w-7 text-right" style={{ color }}>{score}</span>
    </div>
  );
}

// ── Federation Status Badge ─────────────────────────────────────────────────

function FederationBadge({ status }: { status: 'connected' | 'disconnected' }) {
  const isConnected = status === 'connected';
  return (
    <motion.span
      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[10px] uppercase tracking-wider border font-mono"
      style={{
        color: isConnected ? C.green : C.red,
        borderColor: isConnected ? `${C.green}40` : `${C.red}40`,
        background: isConnected ? `${C.green}10` : `${C.red}10`,
      }}
      animate={isConnected ? { opacity: [1, 0.7, 1] } : {}}
      transition={{ duration: 2, repeat: Infinity }}
    >
      <span className="w-1.5 h-1.5" style={{ background: isConnected ? C.green : C.red }} />
      {status}
    </motion.span>
  );
}

// ── Town Status Dot ─────────────────────────────────────────────────────────

function TownStatusDot({ status }: { status: TownStatus }) {
  const color = status === 'online' ? C.green : status === 'stale' ? C.yellow : C.red;
  return (
    <motion.span
      className="inline-block w-2 h-2"
      style={{ background: color }}
      animate={status === 'online' ? { opacity: [1, 0.4, 1] } : {}}
      transition={{ duration: 2, repeat: Infinity }}
    />
  );
}

// ── Post Work Modal ─────────────────────────────────────────────────────────

function PostWorkModal({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (item: Partial<WantedItem>) => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [reward, setReward] = useState('100');
  const [difficulty, setDifficulty] = useState<WantedDifficulty>('medium');

  const handleSubmit = () => {
    if (!title.trim()) return;
    onSubmit({
      title: title.trim(),
      description: description.trim(),
      reward: parseInt(reward) || 100,
      difficulty,
      status: 'open',
    });
    setTitle('');
    setDescription('');
    setReward('100');
    setDifficulty('medium');
    onClose();
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="w-[520px] border font-mono"
        style={{ background: C.card, borderColor: C.border }}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: C.border }}>
          <span className="text-sm font-bold" style={{ color: C.text }}>Post Work to Wanted Board</span>
          <button onClick={onClose} className="text-sm hover:opacity-70 transition-opacity" style={{ color: C.muted }}>X</button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-[9px] uppercase tracking-wider mb-1" style={{ color: C.muted }}>Title</label>
            <input
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="What needs to be done..."
              className="w-full px-3 py-2 text-xs border font-mono focus:outline-none"
              style={{ background: C.bg, borderColor: C.border, color: C.text }}
            />
          </div>
          <div>
            <label className="block text-[9px] uppercase tracking-wider mb-1" style={{ color: C.muted }}>Description</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={4}
              placeholder="Detailed description of the work..."
              className="w-full px-3 py-2 text-xs border font-mono focus:outline-none resize-none"
              style={{ background: C.bg, borderColor: C.border, color: C.text }}
            />
          </div>
          <div className="flex gap-4">
            <div className="flex-1">
              <label className="block text-[9px] uppercase tracking-wider mb-1" style={{ color: C.muted }}>Reward (tokens)</label>
              <input
                value={reward}
                onChange={e => setReward(e.target.value)}
                type="number"
                min="1"
                className="w-full px-3 py-2 text-xs border font-mono focus:outline-none"
                style={{ background: C.bg, borderColor: C.border, color: C.text }}
              />
            </div>
            <div className="flex-1">
              <label className="block text-[9px] uppercase tracking-wider mb-1" style={{ color: C.muted }}>Difficulty</label>
              <select
                value={difficulty}
                onChange={e => setDifficulty(e.target.value as WantedDifficulty)}
                className="w-full px-3 py-2 text-xs border font-mono focus:outline-none"
                style={{ background: C.bg, borderColor: C.border, color: C.text }}
              >
                {(Object.keys(DIFFICULTY_CONFIG) as WantedDifficulty[]).map(d => (
                  <option key={d} value={d}>{DIFFICULTY_CONFIG[d].label}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t" style={{ borderColor: C.border }}>
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs border transition-colors hover:opacity-70"
            style={{ color: C.muted, borderColor: C.border }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!title.trim()}
            className="px-4 py-1.5 text-xs border transition-colors hover:opacity-80 disabled:opacity-30 disabled:cursor-not-allowed"
            style={{ color: C.green, borderColor: `${C.green}40`, background: `${C.green}10` }}
          >
            Post Work
          </button>
        </div>
      </motion.div>
    </div>
  );
}

// ── Wanted Card ─────────────────────────────────────────────────────────────

function WantedCard({
  item,
  onClaim,
}: {
  item: WantedItem;
  onClaim: (id: string) => void;
}) {
  const diffCfg = DIFFICULTY_CONFIG[item.difficulty];
  const stCfg = STATUS_CONFIG[item.status];

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="border p-4 font-mono transition-colors hover:border-[#3d464f]"
      style={{ background: C.card, borderColor: C.border }}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-2">
        <h3 className="text-xs font-bold leading-snug" style={{ color: C.text }}>{item.title}</h3>
        <span className={`flex-none px-1.5 py-0.5 text-[9px] border ${stCfg.badge}`}>{stCfg.label}</span>
      </div>

      {/* Description */}
      <p className="text-[10px] leading-relaxed mb-3 line-clamp-2" style={{ color: C.muted }}>
        {item.description}
      </p>

      {/* Tags */}
      {item.tags && item.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-3">
          {item.tags.map(tag => (
            <span key={tag} className="px-1.5 py-0.5 text-[9px] border" style={{ color: C.muted, borderColor: `${C.border}80`, background: `${C.border}20` }}>
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Meta row */}
      <div className="flex items-center gap-3 mb-3 text-[10px]" style={{ color: C.muted }}>
        <span className={`px-1.5 py-0.5 border ${diffCfg.badge}`}>{diffCfg.label}</span>
        <span style={{ color: C.yellow }}>{item.reward} tokens</span>
        <span>{item.postedByTown}</span>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between">
        <span className="text-[9px]" style={{ color: C.muted }}>{timeAgo(item.createdAt)}</span>
        <div className="flex items-center gap-2">
          {item.claimedBy && (
            <span className="text-[9px]" style={{ color: C.yellow }}>Claimed: {item.claimedBy}</span>
          )}
          {item.status === 'open' && (
            <button
              onClick={() => onClaim(item.id)}
              className="px-3 py-1 text-[10px] uppercase tracking-wider border transition-colors hover:opacity-80"
              style={{ color: C.cyan, borderColor: `${C.cyan}40`, background: `${C.cyan}10` }}
            >
              Claim
            </button>
          )}
        </div>
      </div>
    </motion.div>
  );
}

// ── Main Component ──────────────────────────────────────────────────────────

export default function WastelandView() {
  const [townIdentity, setTownIdentity] = useState<TownIdentity | null>(null);
  const [towns, setTowns] = useState<FederatedTown[]>([]);
  const [wanted, setWanted] = useState<WantedItem[]>([]);
  const [syncHistory, setSyncHistory] = useState<SyncEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [dataSource, setDataSource] = useState<'db' | 'mock' | null>(null);
  const [tab, setTab] = useState<'wanted' | 'towns' | 'sync' | 'reputation'>('wanted');
  const [showPostModal, setShowPostModal] = useState(false);

  // Wanted board filters
  const [filterDifficulty, setFilterDifficulty] = useState<WantedDifficulty | 'all'>('all');
  const [filterStatus, setFilterStatus] = useState<WantedStatus | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  /* ── Fetch ─────────────────────────────────────────────────────────────── */

  const fetchTownIdentity = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/meow/town/pulse`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTownIdentity({
        name: data.town?.name || data.name || 'Gas Town',
        handle: data.town?.handle || data.handle || '@gas-town',
        rigCount: data.rigs?.length || data.rigCount || 0,
        upstreamPath: data.federation?.upstreamPath || 'dolthub/gastown-commons',
        federationStatus: 'disconnected',
        lastSync: data.federation?.lastSync,
        reputationScore: data.federation?.reputationScore || 72,
        completedContributions: data.federation?.completedContributions || 14,
      });
      setDataSource('db');
    } catch {
      setTownIdentity({
        name: 'Gas Town',
        handle: '@gas-town',
        rigCount: 6,
        upstreamPath: 'dolthub/gastown-commons',
        federationStatus: 'disconnected',
        reputationScore: 72,
        completedContributions: 14,
      });
      setDataSource('mock');
    }
  }, []);

  const fetchFederationData = useCallback(async () => {
    // Federation is not live yet; use mock data
    setTowns(generateMockTowns());
    setWanted(generateMockWanted());
    setSyncHistory(generateMockSyncHistory());
  }, []);

  useEffect(() => {
    setLoading(true);
    Promise.all([fetchTownIdentity(), fetchFederationData()]).finally(() => setLoading(false));
  }, [fetchTownIdentity, fetchFederationData]);

  /* ── Actions ───────────────────────────────────────────────────────────── */

  const claimWork = useCallback((id: string) => {
    setWanted(prev =>
      prev.map(w =>
        w.id === id
          ? { ...w, status: 'claimed' as WantedStatus, claimedBy: townIdentity?.handle || '@gas-town' }
          : w
      )
    );
  }, [townIdentity]);

  const postWork = useCallback((item: Partial<WantedItem>) => {
    const newItem: WantedItem = {
      id: `w-${Date.now()}`,
      title: item.title || 'Untitled',
      description: item.description || '',
      reward: item.reward || 100,
      difficulty: item.difficulty || 'medium',
      status: 'open',
      postedBy: townIdentity?.handle || '@gas-town',
      postedByTown: townIdentity?.name || 'Gas Town',
      createdAt: new Date().toISOString(),
      tags: [],
    };
    setWanted(prev => [newItem, ...prev]);
  }, [townIdentity]);

  /* ── Derived ───────────────────────────────────────────────────────────── */

  const filteredWanted = useMemo(() => {
    return wanted.filter(w => {
      if (filterDifficulty !== 'all' && w.difficulty !== filterDifficulty) return false;
      if (filterStatus !== 'all' && w.status !== filterStatus) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        if (!w.title.toLowerCase().includes(q) && !w.description.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [wanted, filterDifficulty, filterStatus, searchQuery]);

  const onlineTowns = useMemo(() => towns.filter(t => t.status === 'online').length, [towns]);
  const openWanted = useMemo(() => wanted.filter(w => w.status === 'open').length, [wanted]);
  const totalRewards = useMemo(() => wanted.filter(w => w.status === 'open').reduce((s, w) => s + w.reward, 0), [wanted]);

  /* ── Render ────────────────────────────────────────────────────────────── */

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center font-mono" style={{ background: C.bg, color: C.muted }}>
        <motion.div animate={{ opacity: [0.4, 1, 0.4] }} transition={{ duration: 1.5, repeat: Infinity }}>
          Scanning the Wasteland...
        </motion.div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col font-mono" style={{ background: C.bg, color: C.text }}>

      {/* ── Federation Status Header ─────────────────────────────────────── */}
      <div className="flex-none border-b" style={{ borderColor: C.border }}>
        <div className="px-6 py-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-4">
              <h1 className="text-sm uppercase tracking-widest" style={{ color: C.text }}>
                The Wasteland
              </h1>
              <span className="text-[10px]" style={{ color: C.muted }}>A Thousand Gas Towns</span>
              {dataSource === 'db' && <span className="px-2 py-0.5 text-[10px] bg-[#c2d94c]/10 text-[#c2d94c] border border-[#c2d94c]/20">LIVE</span>}
              {dataSource === 'mock' && <span className="px-2 py-0.5 text-[10px] bg-[#ffb454]/10 text-[#ffb454] border border-[#ffb454]/20">DEMO</span>}
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setShowPostModal(true)}
                className="px-3 py-1.5 text-[10px] uppercase tracking-wider border transition-colors hover:opacity-80"
                style={{ color: C.green, borderColor: `${C.green}40`, background: `${C.green}10` }}
              >
                Post Work
              </button>
              <button
                onClick={() => { fetchTownIdentity(); fetchFederationData(); }}
                className="px-2 py-1.5 text-[10px] border transition-colors hover:opacity-70"
                style={{ color: C.muted, borderColor: C.border }}
              >
                Refresh
              </button>
            </div>
          </div>

          {/* Town Identity Row */}
          {townIdentity && (
            <div className="flex items-center gap-6 flex-wrap">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold" style={{ color: C.text }}>{townIdentity.name}</span>
                <span className="text-[10px]" style={{ color: C.cyan }}>{townIdentity.handle}</span>
              </div>
              <div className="text-[10px]" style={{ color: C.muted }}>
                {townIdentity.rigCount} rigs
              </div>
              <FederationBadge status={townIdentity.federationStatus} />
              <div className="text-[10px]" style={{ color: C.muted }}>
                Upstream: <span style={{ color: C.purple }}>{townIdentity.upstreamPath}</span>
              </div>
              {townIdentity.lastSync && (
                <div className="text-[10px]" style={{ color: C.muted }}>
                  Last sync: {timeAgo(townIdentity.lastSync)}
                </div>
              )}
            </div>
          )}

          {/* Federation Offline Banner */}
          {townIdentity?.federationStatus === 'disconnected' && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              className="mt-3 px-4 py-2.5 border text-[10px]"
              style={{ borderColor: `${C.yellow}30`, background: `${C.yellow}08`, color: C.yellow }}
            >
              Federation Offline -- Connect to Wasteland to enable cross-town sync, wanted board, and reputation scoring.
              Data below is simulated to preview federation capabilities.
            </motion.div>
          )}
        </div>

        {/* KPI Bar */}
        <div className="flex items-center gap-6 px-6 py-2.5 border-t" style={{ borderColor: C.border, background: `${C.card}80` }}>
          <div className="flex items-center gap-2">
            <span className="text-[9px] uppercase tracking-wider" style={{ color: C.muted }}>Towns</span>
            <span className="text-xs font-bold" style={{ color: C.cyan }}>{onlineTowns}/{towns.length}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[9px] uppercase tracking-wider" style={{ color: C.muted }}>Open Work</span>
            <span className="text-xs font-bold" style={{ color: C.green }}>{openWanted}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[9px] uppercase tracking-wider" style={{ color: C.muted }}>Total Rewards</span>
            <span className="text-xs font-bold" style={{ color: C.yellow }}>{totalRewards} tokens</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[9px] uppercase tracking-wider" style={{ color: C.muted }}>Reputation</span>
            <span className="text-xs font-bold" style={{ color: C.purple }}>{townIdentity?.reputationScore || 0}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[9px] uppercase tracking-wider" style={{ color: C.muted }}>Contributions</span>
            <span className="text-xs font-bold" style={{ color: C.text }}>{townIdentity?.completedContributions || 0}</span>
          </div>
        </div>

        {/* Tab Switcher */}
        <div className="flex items-center gap-0 px-6 border-t" style={{ borderColor: C.border }}>
          {(['wanted', 'towns', 'sync', 'reputation'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className="px-4 py-2.5 text-[10px] uppercase tracking-wider transition-colors border-b-2"
              style={{
                color: tab === t ? C.text : C.muted,
                borderBottomColor: tab === t ? C.cyan : 'transparent',
              }}
            >
              {t === 'wanted' ? 'Wanted Board' : t === 'towns' ? 'Town Registry' : t === 'sync' ? 'Sync History' : 'Trust & Reputation'}
            </button>
          ))}
        </div>
      </div>

      {/* ── Main Content ─────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        <AnimatePresence mode="wait">

          {/* ──── Wanted Board ────────────────────────────────────────────── */}
          {tab === 'wanted' && (
            <motion.div
              key="wanted"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="p-4"
            >
              {/* Filters */}
              <div className="flex items-center gap-3 mb-4 flex-wrap">
                <input
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="Search wanted..."
                  className="px-3 py-1.5 text-xs border font-mono focus:outline-none w-56"
                  style={{ background: C.card, borderColor: C.border, color: C.text }}
                />
                <div className="w-px h-5" style={{ background: C.border }} />
                <div className="flex gap-1">
                  <button
                    onClick={() => setFilterDifficulty('all')}
                    className={`px-2 py-1 text-[10px] border ${filterDifficulty === 'all' ? 'bg-[#2d363f]/50 border-[#2d363f] text-[#e6e1cf]' : 'border-[#2d363f] text-[#6c7680] hover:text-[#e6e1cf]'}`}
                  >
                    All
                  </button>
                  {(Object.keys(DIFFICULTY_CONFIG) as WantedDifficulty[]).map(d => (
                    <button
                      key={d}
                      onClick={() => setFilterDifficulty(d)}
                      className={`px-2 py-1 text-[10px] border ${filterDifficulty === d ? DIFFICULTY_CONFIG[d].badge : 'border-[#2d363f] text-[#6c7680] hover:text-[#e6e1cf]'}`}
                    >
                      {DIFFICULTY_CONFIG[d].label}
                    </button>
                  ))}
                </div>
                <div className="w-px h-5" style={{ background: C.border }} />
                <select
                  value={filterStatus}
                  onChange={e => setFilterStatus(e.target.value as WantedStatus | 'all')}
                  className="px-2 py-1 text-xs border font-mono focus:outline-none"
                  style={{ background: C.card, borderColor: C.border, color: `${C.text}cc` }}
                >
                  <option value="all">All Status</option>
                  <option value="open">Open</option>
                  <option value="claimed">Claimed</option>
                  <option value="completed">Completed</option>
                </select>
              </div>

              {/* Cards Grid */}
              {filteredWanted.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20" style={{ color: C.muted }}>
                  <div className="text-3xl mb-3">&#x1F3DC;</div>
                  <div className="text-sm">No wanted items match your filters</div>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                  {filteredWanted.map(item => (
                    <WantedCard key={item.id} item={item} onClaim={claimWork} />
                  ))}
                </div>
              )}
            </motion.div>
          )}

          {/* ──── Town Registry ───────────────────────────────────────────── */}
          {tab === 'towns' && (
            <motion.div
              key="towns"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="p-4"
            >
              <div className="border font-mono" style={{ borderColor: C.border }}>
                {/* Table Header */}
                <div className="grid grid-cols-12 gap-2 px-4 py-2.5 text-[9px] uppercase tracking-wider border-b" style={{ borderColor: C.border, color: C.muted, background: `${C.card}80` }}>
                  <div className="col-span-1">Status</div>
                  <div className="col-span-3">Town</div>
                  <div className="col-span-1">Rigs</div>
                  <div className="col-span-2">Trust Score</div>
                  <div className="col-span-1">Region</div>
                  <div className="col-span-1">Version</div>
                  <div className="col-span-3">Last Seen</div>
                </div>
                {/* Rows */}
                {towns.map((town, idx) => (
                  <motion.div
                    key={town.id}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: idx * 0.05 }}
                    className="grid grid-cols-12 gap-2 px-4 py-3 items-center border-b transition-colors hover:bg-[#1a1f26]/50"
                    style={{ borderColor: `${C.border}60` }}
                  >
                    <div className="col-span-1 flex items-center">
                      <TownStatusDot status={town.status} />
                    </div>
                    <div className="col-span-3">
                      <div className="text-xs font-bold" style={{ color: C.text }}>{town.name}</div>
                      <div className="text-[9px]" style={{ color: C.cyan }}>{town.handle}</div>
                    </div>
                    <div className="col-span-1 text-xs" style={{ color: C.text }}>{town.rigCount}</div>
                    <div className="col-span-2">
                      <TrustBar score={town.trustScore} />
                    </div>
                    <div className="col-span-1 text-[10px]" style={{ color: C.muted }}>{town.region || '--'}</div>
                    <div className="col-span-1 text-[10px]" style={{ color: C.muted }}>{town.version || '--'}</div>
                    <div className="col-span-3 text-[10px]" style={{ color: C.muted }}>{timeAgo(town.lastSeen)}</div>
                  </motion.div>
                ))}
              </div>
            </motion.div>
          )}

          {/* ──── Sync History ────────────────────────────────────────────── */}
          {tab === 'sync' && (
            <motion.div
              key="sync"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="p-4"
            >
              <div className="space-y-2">
                {syncHistory.length === 0 ? (
                  <div className="text-center py-16 text-[11px]" style={{ color: C.muted }}>
                    No sync events yet. Connect to the Wasteland to begin syncing.
                  </div>
                ) : (
                  syncHistory.map((ev, idx) => {
                    const opColor = SYNC_OP_COLORS[ev.op];
                    return (
                      <motion.div
                        key={ev.id}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: idx * 0.03 }}
                        className="flex items-center gap-4 px-4 py-3 border font-mono"
                        style={{ background: C.card, borderColor: C.border }}
                      >
                        {/* Timeline connector */}
                        <div className="flex flex-col items-center w-4 shrink-0 self-stretch">
                          <div className="w-2 h-2" style={{ background: opColor }} />
                          <div className="flex-1 w-px mt-1" style={{ background: C.border }} />
                        </div>

                        {/* Op badge */}
                        <span
                          className="px-2 py-0.5 text-[9px] uppercase tracking-wider w-12 text-center"
                          style={{ background: `${opColor}15`, color: opColor, border: `1px solid ${opColor}30` }}
                        >
                          {ev.op}
                        </span>

                        {/* Details */}
                        <div className="flex-1 min-w-0">
                          <div className="text-xs" style={{ color: C.text }}>
                            {ev.summary || `${ev.op} operation`}
                          </div>
                          <div className="flex items-center gap-3 mt-0.5 text-[10px]" style={{ color: C.muted }}>
                            {ev.remoteTown && <span>{ev.remoteTown}</span>}
                            <span>{ev.itemsSynced} items</span>
                            {ev.conflicts > 0 && (
                              <span style={{ color: C.red }}>{ev.conflicts} conflicts</span>
                            )}
                            {ev.durationMs !== undefined && (
                              <span>{formatMs(ev.durationMs)}</span>
                            )}
                          </div>
                        </div>

                        {/* Timestamp */}
                        <span className="text-[10px] shrink-0" style={{ color: C.muted }}>
                          {timeAgo(ev.timestamp)}
                        </span>
                      </motion.div>
                    );
                  })
                )}
              </div>
            </motion.div>
          )}

          {/* ──── Trust & Reputation ──────────────────────────────────────── */}
          {tab === 'reputation' && (
            <motion.div
              key="reputation"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="p-4"
            >
              <div className="max-w-[800px] mx-auto space-y-6">
                {/* Reputation Card */}
                <div className="border p-6" style={{ background: C.card, borderColor: C.border }}>
                  <div className="text-[9px] uppercase tracking-wider mb-4" style={{ color: C.muted }}>Your Reputation</div>
                  <div className="flex items-center gap-8">
                    {/* Score gauge */}
                    <div className="relative">
                      <svg width={120} height={120}>
                        <circle cx={60} cy={60} r={52} fill="none" stroke={C.border} strokeWidth={4} />
                        <motion.circle
                          cx={60}
                          cy={60}
                          r={52}
                          fill="none"
                          stroke={C.purple}
                          strokeWidth={4}
                          strokeLinecap="butt"
                          strokeDasharray={2 * Math.PI * 52}
                          initial={{ strokeDashoffset: 2 * Math.PI * 52 }}
                          animate={{ strokeDashoffset: 2 * Math.PI * 52 * (1 - (townIdentity?.reputationScore || 0) / 100) }}
                          transition={{ duration: 1.2, ease: 'easeOut' }}
                          transform="rotate(-90 60 60)"
                        />
                        <text x={60} y={56} textAnchor="middle" fill={C.purple} fontFamily="monospace" fontSize={28} fontWeight="bold">
                          {townIdentity?.reputationScore || 0}
                        </text>
                        <text x={60} y={74} textAnchor="middle" fill={C.muted} fontFamily="monospace" fontSize={9}>
                          SCORE
                        </text>
                      </svg>
                    </div>

                    {/* Stats */}
                    <div className="flex-1 grid grid-cols-2 gap-4">
                      <div>
                        <div className="text-[9px] uppercase tracking-wider mb-1" style={{ color: C.muted }}>Completed</div>
                        <div className="text-xl font-bold" style={{ color: C.green }}>{townIdentity?.completedContributions || 0}</div>
                        <div className="text-[10px]" style={{ color: C.muted }}>contributions</div>
                      </div>
                      <div>
                        <div className="text-[9px] uppercase tracking-wider mb-1" style={{ color: C.muted }}>Posted</div>
                        <div className="text-xl font-bold" style={{ color: C.yellow }}>{wanted.filter(w => w.postedBy === (townIdentity?.handle || '@gas-town')).length}</div>
                        <div className="text-[10px]" style={{ color: C.muted }}>work items</div>
                      </div>
                      <div>
                        <div className="text-[9px] uppercase tracking-wider mb-1" style={{ color: C.muted }}>Trust Level</div>
                        <div className="text-sm font-bold" style={{ color: C.cyan }}>
                          {(townIdentity?.reputationScore || 0) >= 80 ? 'Trusted' : (townIdentity?.reputationScore || 0) >= 50 ? 'Established' : 'New'}
                        </div>
                      </div>
                      <div>
                        <div className="text-[9px] uppercase tracking-wider mb-1" style={{ color: C.muted }}>Syncs Today</div>
                        <div className="text-sm font-bold" style={{ color: C.text }}>
                          {syncHistory.filter(s => Date.now() - new Date(s.timestamp).getTime() < 86_400_000).length}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Trust Leaderboard */}
                <div className="border" style={{ background: C.card, borderColor: C.border }}>
                  <div className="px-5 py-3 border-b" style={{ borderColor: C.border }}>
                    <span className="text-[9px] uppercase tracking-wider" style={{ color: C.muted }}>Federation Trust Leaderboard</span>
                  </div>
                  <div className="p-4 space-y-2">
                    {[...towns].sort((a, b) => b.trustScore - a.trustScore).map((town, idx) => (
                      <motion.div
                        key={town.id}
                        initial={{ opacity: 0, x: -8 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: idx * 0.05 }}
                        className="flex items-center gap-3 px-3 py-2"
                        style={{ background: idx === 0 ? `${C.green}08` : 'transparent' }}
                      >
                        <span className="text-[10px] w-5 text-center font-bold" style={{ color: idx < 3 ? C.yellow : C.muted }}>
                          #{idx + 1}
                        </span>
                        <TownStatusDot status={town.status} />
                        <span className="text-xs flex-1 font-bold" style={{ color: C.text }}>{town.name}</span>
                        <div className="w-32">
                          <TrustBar score={town.trustScore} />
                        </div>
                      </motion.div>
                    ))}
                  </div>
                </div>

                {/* Post Work Form (inline) */}
                <div className="border p-5" style={{ background: C.card, borderColor: C.border }}>
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-[9px] uppercase tracking-wider" style={{ color: C.muted }}>Quick Post Work</span>
                    <button
                      onClick={() => setShowPostModal(true)}
                      className="px-3 py-1 text-[10px] uppercase tracking-wider border transition-colors hover:opacity-80"
                      style={{ color: C.green, borderColor: `${C.green}40`, background: `${C.green}10` }}
                    >
                      Open Full Form
                    </button>
                  </div>
                  <p className="text-[10px] leading-relaxed" style={{ color: C.muted }}>
                    Post work to the Wanted Board and earn reputation when other towns claim and complete it.
                    Higher reward items attract more attention. Your reputation score increases
                    as you post quality work and complete claims from other towns.
                  </p>
                </div>
              </div>
            </motion.div>
          )}

        </AnimatePresence>
      </div>

      {/* ── Post Work Modal ──────────────────────────────────────────────── */}
      <AnimatePresence>
        {showPostModal && (
          <PostWorkModal
            open={showPostModal}
            onClose={() => setShowPostModal(false)}
            onSubmit={postWork}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
