'use client';

import { useState, useEffect, useCallback, Component, type ReactNode, type ErrorInfo } from 'react';
import dynamic from 'next/dynamic';

// ── Error Boundary to catch and display client-side errors ──────────────────
class ViewErrorBoundary extends Component<{ children: ReactNode; viewId: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error(`[GasTown] View crash in ${this.props.viewId}:`, error, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{ background: '#0f1419', color: '#f07178', padding: 40, fontFamily: 'monospace', minHeight: '60vh' }}>
          <h2 style={{ color: '#e6e1cf', marginBottom: 16 }}>View Error: {this.props.viewId}</h2>
          <pre style={{ color: '#ffb454', whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.6 }}>{this.state.error.message}</pre>
          <pre style={{ color: '#6c7680', whiteSpace: 'pre-wrap', fontSize: 10, marginTop: 12 }}>{this.state.error.stack}</pre>
          <button onClick={() => this.setState({ error: null })} style={{ marginTop: 20, padding: '8px 16px', background: '#1a1f26', border: '1px solid #2d363f', color: '#95e6cb', cursor: 'pointer' }}>Retry</button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── View Components (lazy loaded, no SSR) ────────────────────────────────────
const views: Record<string, ReturnType<typeof dynamic>> = {
  'gastown-hq': dynamic(() => import('@/components/GasTownHQView'), { ssr: false }),
  'gastown-feed': dynamic(() => import('@/components/FeedView'), { ssr: false }),
  'gastown-doctor': dynamic(() => import('@/components/DoctorView'), { ssr: false }),
  'gastown-timeline': dynamic(() => import('@/components/GasTownTimelineView'), { ssr: false }),
  // Engine (deep views)
  'engine-guzzoline': dynamic(() => import('@/components/GuzzolineGaugeView'), { ssr: false }),
  'engine-terminal': dynamic(() => import('@/components/GTTerminalView'), { ssr: false }),
  'engine-gupp': dynamic(() => import('@/components/GUPPDashboardView'), { ssr: false }),
  'engine-chemistry': dynamic(() => import('@/components/MEOWChemistryView'), { ssr: false }),
  'engine-ndi': dynamic(() => import('@/components/NDIStatusView'), { ssr: false }),
  'engine-seance': dynamic(() => import('@/components/SeanceLogView'), { ssr: false }),
  'engine-tmux': dynamic(() => import('@/components/TmuxSessionView'), { ssr: false }),
  'engine-maestro': dynamic(() => import('@/components/MaestroIntegrationView'), { ssr: false }),
  'engine-wasteland': dynamic(() => import('@/components/WastelandView'), { ssr: false }),
  'engine-formulas': dynamic(() => import('@/components/FormulaLabView'), { ssr: false }),
  // MEOW Stack
  'meow-molecules': dynamic(() => import('@/components/MoleculeView'), { ssr: false }),
  'meow-beads': dynamic(() => import('@/components/BeadsView'), { ssr: false }),
  'meow-convoys': dynamic(() => import('@/components/ConvoyTrackerView'), { ssr: false }),
  'meow-workers': dynamic(() => import('@/components/WorkerPoolView'), { ssr: false }),
  'meow-mayor': dynamic(() => import('@/components/MayorCommandView'), { ssr: false }),
  'meow-observatory': dynamic(() => import('@/components/ObservabilityTowerView'), { ssr: false }),
  'meow-refinery': dynamic(() => import('@/components/RefineryView'), { ssr: false }),
  'meow-patrol': dynamic(() => import('@/components/PatrolView'), { ssr: false }),
  'meow-skills': dynamic(() => import('@/components/SkillsWorkshopView'), { ssr: false }),
  'meow-wisps': dynamic(() => import('@/components/WispMonitorView'), { ssr: false }),
  'meow-quality-gate': dynamic(() => import('@/components/QualityGateView'), { ssr: false }),
  // Gas Town Workers
  'gastown-hooks': dynamic(() => import('@/components/HooksManagerView'), { ssr: false }),
  'gastown-mail': dynamic(() => import('@/components/MailCenterView'), { ssr: false }),
  'gastown-crew': dynamic(() => import('@/components/CrewRosterView'), { ssr: false }),
  'gastown-deacon': dynamic(() => import('@/components/DeaconHealthView'), { ssr: false }),
  'gastown-polecats': dynamic(() => import('@/components/PolecatSwarmView'), { ssr: false }),
};

// ── View Registry ────────────────────────────────────────────────────────────
const NAV = [
  // Core
  { id: 'gastown-hq', label: 'HQ', icon: '🏙️', group: 'core' },
  { id: 'gastown-feed', label: 'Feed', icon: '▦', group: 'core' },
  { id: 'gastown-doctor', label: 'Doctor', icon: '🩺', group: 'core' },
  { id: 'gastown-timeline', label: 'Timeline', icon: '📅', group: 'core' },
  // Engine (deep views)
  { id: 'engine-guzzoline', label: 'Guzzoline', icon: '⛽', group: 'engine' },
  { id: 'engine-terminal', label: 'GT Terminal', icon: '>', group: 'engine' },
  { id: 'engine-gupp', label: 'GUPP', icon: '⚡', group: 'engine' },
  { id: 'engine-chemistry', label: 'Chemistry', icon: '⚗️', group: 'engine' },
  { id: 'engine-ndi', label: 'NDI', icon: '∞', group: 'engine' },
  { id: 'engine-seance', label: 'Seance', icon: '☠', group: 'engine' },
  { id: 'engine-tmux', label: 'tmux', icon: '$', group: 'engine' },
  { id: 'engine-maestro', label: 'Maestro', icon: '♦', group: 'engine' },
  { id: 'engine-wasteland', label: 'Wasteland', icon: '🌐', group: 'engine' },
  { id: 'engine-formulas', label: 'Formulas', icon: '📜', group: 'engine' },
  // MEOW Stack
  { id: 'meow-molecules', label: 'Molecules', icon: '🧬', group: 'meow' },
  { id: 'meow-beads', label: 'Beads', icon: '📿', group: 'meow' },
  { id: 'meow-convoys', label: 'Convoys', icon: '🚚', group: 'meow' },
  { id: 'meow-workers', label: 'Workers', icon: '👷', group: 'meow' },
  { id: 'meow-mayor', label: 'Mayor', icon: '🎩', group: 'meow' },
  { id: 'meow-observatory', label: 'Observatory', icon: '🔭', group: 'meow' },
  { id: 'meow-refinery', label: 'Refinery', icon: '⚗️', group: 'meow' },
  { id: 'meow-patrol', label: 'Patrol', icon: '🛡️', group: 'meow' },
  { id: 'meow-skills', label: 'Skills', icon: '🔧', group: 'meow' },
  { id: 'meow-wisps', label: 'Wisps', icon: '💨', group: 'meow' },
  { id: 'meow-quality-gate', label: 'Quality Gate', icon: '✅', group: 'meow' },
  // Gas Town Workers
  { id: 'gastown-hooks', label: 'GUPP Hooks', icon: '🪝', group: 'workers' },
  { id: 'gastown-polecats', label: 'Polecats', icon: '😺', group: 'workers' },
  { id: 'gastown-crew', label: 'Crew', icon: '👷', group: 'workers' },
  { id: 'gastown-deacon', label: 'Deacon', icon: '🐺', group: 'workers' },
  { id: 'gastown-mail', label: 'Mail', icon: '📬', group: 'workers' },
] as const;

const C = {
  bgDark: '#0f1419',
  border: '#2d363f',
  muted: '#6c7680',
  cyan: '#95e6cb',
  green: '#c2d94c',
  yellow: '#ffb454',
  purple: '#d2a6ff',
};

const GROUP_COLORS: Record<string, string> = {
  core: C.cyan,
  engine: C.purple,
  meow: C.green,
  workers: C.yellow,
};

// ── Main Page ────────────────────────────────────────────────────────────────

export default function GasTownPage() {
  const [currentView, setCurrentView] = useState('gastown-hq');

  // Read ?view= from URL on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const v = params.get('view');
    if (v) setCurrentView(v);
  }, []);

  // Listen for popstate (back/forward + navigate() from HQView)
  useEffect(() => {
    const handler = () => {
      const params = new URLSearchParams(window.location.search);
      const v = params.get('view');
      setCurrentView(v || 'gastown-hq');
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);

  const navigate = useCallback((viewId: string) => {
    setCurrentView(viewId);
    const url = new URL(window.location.href);
    url.searchParams.set('view', viewId);
    window.history.pushState({ view: viewId }, '', url.toString());
  }, []);

  // Render the active view component
  const ViewComponent = views[currentView] || views['gastown-hq'];

  return (
    <div className="min-h-screen" style={{ background: C.bgDark }}>
      {/* ── Sticky Navigation ───────────────────────────────────────────── */}
      <nav
        className="sticky top-0 z-50 px-3 py-2 overflow-x-auto"
        style={{ background: C.bgDark + 'f0', borderBottom: `1px solid ${C.border}`, backdropFilter: 'blur(8px)' }}
      >
        <div className="flex items-center gap-1 min-w-max">
          {(['core', 'engine', 'meow', 'workers'] as const).map((group, gi) => (
            <div key={group} className="flex items-center gap-1">
              {gi > 0 && <span className="w-px h-5 mx-1" style={{ background: C.border }} />}
              {NAV.filter(v => v.group === group).map(v => {
                const active = currentView === v.id;
                const color = GROUP_COLORS[group] || C.muted;
                return (
                  <button
                    key={v.id}
                    onClick={() => navigate(v.id)}
                    className="px-2 py-1 text-[10px] font-mono rounded-none whitespace-nowrap transition-all"
                    style={{
                      background: active ? color + '18' : 'transparent',
                      color: active ? color : C.muted,
                      border: `1px solid ${active ? color + '40' : 'transparent'}`,
                      fontWeight: active ? 600 : 400,
                    }}
                  >
                    {v.icon} {v.label}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </nav>

      {/* ── Active View ──────────────────────────────────────────────────── */}
      <ViewErrorBoundary viewId={currentView} key={currentView}>
        <ViewComponent />
      </ViewErrorBoundary>
    </div>
  );
}
