'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';

const GasTownHQView = dynamic(() => import('@/components/GasTownHQView'), { ssr: false });
const GasTownTimelineView = dynamic(() => import('@/components/GasTownTimelineView'), { ssr: false });

type View = 'hq' | 'timeline';

export default function GasTownPage() {
  const [view, setView] = useState<View>('hq');

  return (
    <div className="min-h-screen" style={{ background: '#0f1419' }}>
      {/* Nav */}
      <nav className="flex items-center gap-2 px-4 py-2 border-b" style={{ borderColor: '#2d363f' }}>
        {[
          { id: 'hq' as View, label: 'HQ Control Center' },
          { id: 'timeline' as View, label: 'Timeline' },
        ].map(tab => (
          <button
            key={tab.id}
            onClick={() => setView(tab.id)}
            className="px-3 py-1.5 text-xs font-mono rounded transition-colors"
            style={{
              background: view === tab.id ? '#95e6cb15' : 'transparent',
              color: view === tab.id ? '#95e6cb' : '#6c7680',
              border: `1px solid ${view === tab.id ? '#95e6cb30' : '#2d363f'}`,
            }}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {/* Views */}
      {view === 'hq' && <GasTownHQView />}
      {view === 'timeline' && <GasTownTimelineView />}
    </div>
  );
}
