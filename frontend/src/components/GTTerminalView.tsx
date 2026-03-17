'use client';

/**
 * GTTerminalView — GT Terminal: Web-based CLI for Gas Town
 *
 * Full terminal emulator interface for the `gt` command system.
 * Sends commands to POST /api/meow/stage06/cli, renders output with
 * syntax highlighting, supports history navigation, tab completion,
 * quick-command sidebar, and session telemetry bar.
 *
 * API: POST {API}/api/meow/stage06/cli  { command } => { success, output, format, durationMs }
 *      GET  {API}/api/meow/stage06/cli/history => recent commands
 * TERMINAL AESTHETIC (Ayu Dark): bg-[#0a0e14], cards #1a1f26, text #e6e1cf
 * Prompt #c2d94c, error #f07178, info #59c2ff, font-mono, rounded-none
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ORCHESTRATOR_URL as API } from '@/lib/config';

// ─── Types ──────────────────────────────────────────────────────────────────────

interface CliResponse {
  success: boolean;
  output: string;
  format?: 'text' | 'json' | 'table' | 'status';
  durationMs?: number;
}

interface TerminalEntry {
  id: string;
  command: string;
  output: string;
  success: boolean;
  format?: string;
  durationMs?: number;
  timestamp: number;
}

interface QuickCommand {
  label: string;
  command: string;
  description: string;
  category: 'core' | 'workers' | 'comms' | 'ops';
}

interface SessionInfo {
  sessionId: string;
  startedAt: number;
  commandCount: number;
  lastCommandAt: number | null;
}

// ─── Constants ──────────────────────────────────────────────────────────────────

const HISTORY_STORAGE_KEY = 'gt-terminal-history';
const MAX_HISTORY = 500;
const PROMPT_PREFIX = 'gt> ';

const KNOWN_COMMANDS = [
  'status', 'workers', 'beads', 'convoy', 'sling', 'nudge',
  'seance', 'handoff', 'mail', 'cook', 'guzzoline', 'help',
  'clear', 'history', 'whoami', 'version', 'config', 'logs',
  'patrol', 'refinery', 'hooks', 'skills', 'molecules', 'deacon',
];

const QUICK_COMMANDS: QuickCommand[] = [
  { label: 'gt status',                    command: 'gt status',                    description: 'System overview',          category: 'core' },
  { label: 'gt workers list',              command: 'gt workers list',              description: 'List all workers',         category: 'workers' },
  { label: 'gt beads list --limit 10',     command: 'gt beads list --limit 10',     description: 'Recent beads',             category: 'core' },
  { label: 'gt convoy list',               command: 'gt convoy list',               description: 'Active convoys',           category: 'core' },
  { label: 'gt sling <beadId> <agent>',    command: 'gt sling ',                    description: 'Assign work to agent',     category: 'ops' },
  { label: 'gt nudge <agent> <message>',   command: 'gt nudge ',                    description: 'Poke an agent',            category: 'comms' },
  { label: 'gt seance <sessionId>',        command: 'gt seance ',                   description: 'Recover dead session',     category: 'ops' },
  { label: 'gt handoff',                   command: 'gt handoff',                   description: 'Graceful session transfer', category: 'ops' },
  { label: 'gt mail <to> <subject>',       command: 'gt mail ',                     description: 'Send mail',                category: 'comms' },
  { label: 'gt cook <formula>',            command: 'gt cook ',                     description: 'Run formula',              category: 'ops' },
  { label: 'gt guzzoline',                 command: 'gt guzzoline',                 description: 'Show fuel gauge',          category: 'core' },
  { label: 'gt help',                      command: 'gt help',                      description: 'Help & usage',             category: 'core' },
];

const CATEGORY_LABELS: Record<string, string> = {
  core: 'Core',
  workers: 'Workers',
  comms: 'Communications',
  ops: 'Operations',
};

const CATEGORY_COLORS: Record<string, string> = {
  core: '#c2d94c',
  workers: '#59c2ff',
  comms: '#ffb454',
  ops: '#d2a6ff',
};

// ─── Helpers ────────────────────────────────────────────────────────────────────

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function generateSessionId(): string {
  return `ses-${Math.random().toString(36).slice(2, 10)}`;
}

function formatUptime(startMs: number): string {
  const diff = Math.floor((Date.now() - startMs) / 1000);
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = diff % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false });
}

/** Detect if output looks like JSON and pretty-print it */
function tryFormatJson(text: string): { isJson: boolean; formatted: string } {
  const trimmed = text.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      const parsed = JSON.parse(trimmed);
      return { isJson: true, formatted: JSON.stringify(parsed, null, 2) };
    } catch {
      return { isJson: false, formatted: text };
    }
  }
  return { isJson: false, formatted: text };
}

/** Detect if output contains ASCII table patterns */
function isTable(text: string): boolean {
  const lines = text.split('\n');
  const pipeLines = lines.filter(l => l.includes('|') && l.trim().startsWith('|'));
  const dashLines = lines.filter(l => /^[\s|+-]+$/.test(l));
  return pipeLines.length >= 2 || dashLines.length >= 1;
}

/** Colorize status keywords in output text */
function colorizeOutput(text: string): string {
  return text
    .replace(/\b(active|running|online|healthy|ok|success|done)\b/gi, '<<<GREEN>>>$1<<<\/GREEN>>>')
    .replace(/\b(error|failed|critical|dead|offline)\b/gi, '<<<RED>>>$1<<<\/RED>>>')
    .replace(/\b(warning|pending|queued|idle|blocked)\b/gi, '<<<YELLOW>>>$1<<<\/YELLOW>>>')
    .replace(/\b(info|ready|standby)\b/gi, '<<<CYAN>>>$1<<<\/CYAN>>>');
}

// ─── Components ─────────────────────────────────────────────────────────────────

/** Renders colorized terminal output with syntax detection */
function OutputRenderer({ text, format, success }: { text: string; format?: string; success: boolean }) {
  const lines = useMemo(() => {
    if (!success) {
      return text.split('\n').map(line => ({ line, color: '#f07178' }));
    }

    const { isJson, formatted } = tryFormatJson(text);

    if (format === 'json' || isJson) {
      return formatted.split('\n').map(line => {
        if (/^\s*"/.test(line)) return { line, color: '#c2d94c' };
        if (/:\s*\d/.test(line)) return { line, color: '#e6b450' };
        if (/:\s*true/.test(line)) return { line, color: '#c2d94c' };
        if (/:\s*false/.test(line)) return { line, color: '#f07178' };
        if (/:\s*null/.test(line)) return { line, color: '#5c6773' };
        if (/:\s*"/.test(line)) return { line, color: '#59c2ff' };
        return { line, color: '#e6e1cf' };
      });
    }

    if (format === 'table' || isTable(text)) {
      return text.split('\n').map(line => {
        if (/^[\s|+-]+$/.test(line)) return { line, color: '#5c6773' };
        if (line.includes('|')) return { line, color: '#b8cfe6' };
        return { line, color: '#e6e1cf' };
      });
    }

    // Default: apply keyword colorization
    const colorized = colorizeOutput(text);
    return colorized.split('\n').map(line => {
      // Parse our custom color markers
      if (line.includes('<<<GREEN>>>')) return { line: line.replace(/<<<\/?GREEN>>>/g, ''), color: '#c2d94c' };
      if (line.includes('<<<RED>>>')) return { line: line.replace(/<<<\/?RED>>>/g, ''), color: '#f07178' };
      if (line.includes('<<<YELLOW>>>')) return { line: line.replace(/<<<\/?YELLOW>>>/g, ''), color: '#ffb454' };
      if (line.includes('<<<CYAN>>>')) return { line: line.replace(/<<<\/?CYAN>>>/g, ''), color: '#59c2ff' };
      return { line, color: '#e6e1cf' };
    });
  }, [text, format, success]);

  return (
    <div className="whitespace-pre-wrap break-words">
      {lines.map((entry, i) => (
        <div key={i} style={{ color: entry.color }} className="leading-relaxed">
          {entry.line || '\u00A0'}
        </div>
      ))}
    </div>
  );
}

/** Single terminal history entry */
function TerminalEntryBlock({ entry }: { entry: TerminalEntry }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
      className="mb-3 group"
    >
      {/* Prompt + Command */}
      <div className="flex items-center gap-0 font-mono text-sm">
        <span style={{ color: '#c2d94c' }} className="select-none font-bold">
          {PROMPT_PREFIX}
        </span>
        <span style={{ color: '#e6e1cf' }} className="font-semibold">
          {entry.command}
        </span>
      </div>

      {/* Output */}
      {entry.output && (
        <div className="mt-1 pl-0 font-mono text-xs leading-relaxed">
          <OutputRenderer
            text={entry.output}
            format={entry.format}
            success={entry.success}
          />
        </div>
      )}

      {/* Duration / Timestamp */}
      <div className="mt-1 flex items-center gap-3 font-mono text-[10px] opacity-0 group-hover:opacity-100 transition-opacity">
        {entry.durationMs != null && (
          <span style={{ color: '#5c6773' }}>
            {entry.durationMs}ms
          </span>
        )}
        <span style={{ color: '#5c6773' }}>
          {formatTimestamp(entry.timestamp)}
        </span>
        {!entry.success && (
          <span style={{ color: '#f07178' }} className="font-bold">
            EXIT 1
          </span>
        )}
      </div>
    </motion.div>
  );
}

/** Loading indicator for pending command */
function CommandSpinner() {
  return (
    <div className="flex items-center gap-2 font-mono text-xs mt-1 mb-3">
      <motion.div
        className="flex gap-1"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
      >
        {[0, 1, 2].map(i => (
          <motion.span
            key={i}
            style={{ color: '#59c2ff' }}
            animate={{ opacity: [0.3, 1, 0.3] }}
            transition={{ duration: 0.8, repeat: Infinity, delay: i * 0.15 }}
          >
            .
          </motion.span>
        ))}
      </motion.div>
      <span style={{ color: '#5c6773' }}>executing...</span>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────────

export default function GTTerminalView() {
  // ── State ──────────────────────────────────────────────────────────────────
  const [entries, setEntries] = useState<TerminalEntry[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isExecuting, setIsExecuting] = useState(false);
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [showSidebar, setShowSidebar] = useState(true);
  const [tabSuggestions, setTabSuggestions] = useState<string[]>([]);
  const [tabIndex, setTabIndex] = useState(0);
  const [session] = useState<SessionInfo>(() => ({
    sessionId: generateSessionId(),
    startedAt: Date.now(),
    commandCount: 0,
    lastCommandAt: null,
  }));
  const [sessionCommandCount, setSessionCommandCount] = useState(0);
  const [lastCommandAt, setLastCommandAt] = useState<number | null>(null);
  const [uptimeStr, setUptimeStr] = useState('0s');

  // ── Refs ───────────────────────────────────────────────────────────────────
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // ── Uptime ticker ──────────────────────────────────────────────────────────
  useEffect(() => {
    const timer = setInterval(() => {
      setUptimeStr(formatUptime(session.startedAt));
    }, 1000);
    return () => clearInterval(timer);
  }, [session.startedAt]);

  // ── Load history from localStorage ─────────────────────────────────────────
  useEffect(() => {
    try {
      const stored = localStorage.getItem(HISTORY_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as string[];
        setCommandHistory(parsed.slice(-MAX_HISTORY));
      }
    } catch {
      // ignore
    }
  }, []);

  // ── Fetch remote history on mount ──────────────────────────────────────────
  useEffect(() => {
    async function fetchRemoteHistory() {
      try {
        const res = await fetch(`${API}/api/meow/stage06/cli/history`);
        if (!res.ok) return;
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          const welcomeEntry: TerminalEntry = {
            id: generateId(),
            command: '(session restored)',
            output: `Loaded ${data.length} commands from server history.`,
            success: true,
            format: 'text',
            timestamp: Date.now(),
          };
          setEntries(prev => [welcomeEntry, ...prev]);
        }
      } catch {
        // server not reachable; no problem
      }
    }
    fetchRemoteHistory();
  }, []);

  // ── Persist command history ────────────────────────────────────────────────
  const persistHistory = useCallback((history: string[]) => {
    try {
      const trimmed = history.slice(-MAX_HISTORY);
      localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(trimmed));
    } catch {
      // storage full or disabled
    }
  }, []);

  // ── Auto-scroll to bottom ──────────────────────────────────────────────────
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries, isExecuting]);

  // ── Auto-focus input ───────────────────────────────────────────────────────
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // ── Focus input on click anywhere in terminal ──────────────────────────────
  const handleTerminalClick = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  // ── Execute command ────────────────────────────────────────────────────────
  const executeCommand = useCallback(async (rawCommand: string) => {
    const command = rawCommand.trim();
    if (!command) return;

    // Reset tab state
    setTabSuggestions([]);
    setTabIndex(0);

    // Update history
    const newHistory = [...commandHistory.filter(c => c !== command), command];
    setCommandHistory(newHistory);
    persistHistory(newHistory);
    setHistoryIndex(-1);

    // Handle local commands
    if (command === 'clear' || command === 'gt clear') {
      setEntries([]);
      setInputValue('');
      return;
    }

    if (command === 'history' || command === 'gt history') {
      const historyOutput = newHistory
        .slice(-30)
        .map((cmd, i) => `  ${String(i + 1).padStart(4)}  ${cmd}`)
        .join('\n');
      setEntries(prev => [...prev, {
        id: generateId(),
        command,
        output: historyOutput || '(empty history)',
        success: true,
        format: 'text',
        timestamp: Date.now(),
      }]);
      setInputValue('');
      setSessionCommandCount(c => c + 1);
      setLastCommandAt(Date.now());
      return;
    }

    // Send to backend
    setIsExecuting(true);
    setInputValue('');

    try {
      const res = await fetch(`${API}/api/meow/stage06/cli`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => `HTTP ${res.status}`);
        setEntries(prev => [...prev, {
          id: generateId(),
          command,
          output: `Error: ${res.status} ${res.statusText}\n${errorText}`,
          success: false,
          timestamp: Date.now(),
        }]);
        return;
      }

      const data: CliResponse = await res.json();

      setEntries(prev => [...prev, {
        id: generateId(),
        command,
        output: data.output || '(no output)',
        success: data.success,
        format: data.format,
        durationMs: data.durationMs,
        timestamp: Date.now(),
      }]);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setEntries(prev => [...prev, {
        id: generateId(),
        command,
        output: `Connection error: ${message}\nIs the Gas Town backend running at ${API}?`,
        success: false,
        timestamp: Date.now(),
      }]);
    } finally {
      setIsExecuting(false);
      setSessionCommandCount(c => c + 1);
      setLastCommandAt(Date.now());
    }
  }, [commandHistory, persistHistory]);

  // ── Tab completion ─────────────────────────────────────────────────────────
  const handleTabCompletion = useCallback(() => {
    const value = inputValue.trim();
    const parts = value.split(/\s+/);
    const lastWord = parts[parts.length - 1] || '';

    // Match against known commands (strip 'gt ' prefix if present)
    const prefix = lastWord.replace(/^gt\s*/, '');
    const matches = KNOWN_COMMANDS.filter(cmd => cmd.startsWith(prefix));

    if (matches.length === 0) {
      setTabSuggestions([]);
      return;
    }

    if (matches.length === 1) {
      // Single match: auto-complete
      const base = parts.length > 1
        ? parts.slice(0, -1).join(' ') + ' '
        : (value.startsWith('gt ') ? 'gt ' : '');
      setInputValue(base + matches[0] + ' ');
      setTabSuggestions([]);
      setTabIndex(0);
    } else {
      // Multiple matches: show suggestions, cycle through
      setTabSuggestions(matches);
      const nextIndex = (tabIndex + 1) % matches.length;
      setTabIndex(nextIndex);
      const base = parts.length > 1
        ? parts.slice(0, -1).join(' ') + ' '
        : (value.startsWith('gt ') ? 'gt ' : '');
      setInputValue(base + matches[nextIndex]);
    }
  }, [inputValue, tabIndex]);

  // ── Key handler ────────────────────────────────────────────────────────────
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    // Ctrl+L: clear terminal
    if (e.ctrlKey && e.key === 'l') {
      e.preventDefault();
      setEntries([]);
      return;
    }

    // Tab: completion
    if (e.key === 'Tab') {
      e.preventDefault();
      handleTabCompletion();
      return;
    }

    // Clear tab suggestions on any other key
    if (e.key !== 'Tab') {
      setTabSuggestions([]);
      setTabIndex(0);
    }

    // Enter: execute
    if (e.key === 'Enter' && !isExecuting) {
      e.preventDefault();
      executeCommand(inputValue);
      return;
    }

    // Up: previous command
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (commandHistory.length === 0) return;
      const newIndex = historyIndex === -1
        ? commandHistory.length - 1
        : Math.max(0, historyIndex - 1);
      setHistoryIndex(newIndex);
      setInputValue(commandHistory[newIndex] || '');
      return;
    }

    // Down: next command
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex === -1) return;
      const newIndex = historyIndex + 1;
      if (newIndex >= commandHistory.length) {
        setHistoryIndex(-1);
        setInputValue('');
      } else {
        setHistoryIndex(newIndex);
        setInputValue(commandHistory[newIndex] || '');
      }
      return;
    }

    // Ctrl+C: cancel / clear input
    if (e.ctrlKey && e.key === 'c') {
      e.preventDefault();
      if (inputValue) {
        setEntries(prev => [...prev, {
          id: generateId(),
          command: inputValue + '^C',
          output: '',
          success: true,
          timestamp: Date.now(),
        }]);
        setInputValue('');
      }
      return;
    }
  }, [inputValue, isExecuting, commandHistory, historyIndex, executeCommand, handleTabCompletion]);

  // ── Quick command click ────────────────────────────────────────────────────
  const handleQuickCommand = useCallback((qc: QuickCommand) => {
    // If command ends with space, put in input for user to complete args
    if (qc.command.endsWith(' ')) {
      setInputValue(qc.command);
      inputRef.current?.focus();
    } else {
      executeCommand(qc.command);
    }
  }, [executeCommand]);

  // ── Grouped quick commands ─────────────────────────────────────────────────
  const groupedCommands = useMemo(() => {
    const groups: Record<string, QuickCommand[]> = {};
    for (const qc of QUICK_COMMANDS) {
      if (!groups[qc.category]) groups[qc.category] = [];
      groups[qc.category].push(qc);
    }
    return groups;
  }, []);

  // ── Global keyboard shortcut for Ctrl+L ────────────────────────────────────
  useEffect(() => {
    function handleGlobalKey(e: KeyboardEvent) {
      if (e.ctrlKey && e.key === 'l') {
        e.preventDefault();
        setEntries([]);
      }
    }
    window.addEventListener('keydown', handleGlobalKey);
    return () => window.removeEventListener('keydown', handleGlobalKey);
  }, []);

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      className="flex flex-col h-full w-full font-mono"
      style={{ background: '#0a0e14', color: '#e6e1cf' }}
    >
      {/* ── Session Info Bar ────────────────────────────────────────────────── */}
      <div
        className="flex items-center justify-between px-4 py-2 border-b text-xs shrink-0 select-none"
        style={{ background: '#1a1f26', borderColor: 'rgba(255,255,255,0.06)' }}
      >
        <div className="flex items-center gap-4">
          {/* Terminal title */}
          <div className="flex items-center gap-2">
            <span
              className="inline-block w-2 h-2 rounded-full animate-pulse"
              style={{ background: '#c2d94c' }}
            />
            <span className="font-bold tracking-wider" style={{ color: '#c2d94c' }}>
              GT TERMINAL
            </span>
          </div>

          {/* Session ID */}
          <span style={{ color: '#5c6773' }}>
            sid:<span style={{ color: '#59c2ff' }}>{session.sessionId}</span>
          </span>
        </div>

        <div className="flex items-center gap-4">
          {/* Uptime */}
          <span style={{ color: '#5c6773' }}>
            uptime:<span style={{ color: '#e6e1cf' }}>{uptimeStr}</span>
          </span>

          {/* Command count */}
          <span style={{ color: '#5c6773' }}>
            cmds:<span style={{ color: '#e6b450' }}>{sessionCommandCount}</span>
          </span>

          {/* Last command time */}
          <span style={{ color: '#5c6773' }}>
            last:{' '}
            <span style={{ color: '#e6e1cf' }}>
              {lastCommandAt ? formatTimestamp(lastCommandAt) : '--:--:--'}
            </span>
          </span>

          {/* Sidebar toggle */}
          <button
            onClick={() => setShowSidebar(s => !s)}
            className="px-2 py-0.5 text-xs rounded-none border transition-colors hover:border-white/20"
            style={{
              background: showSidebar ? '#c2d94c10' : 'transparent',
              borderColor: showSidebar ? '#c2d94c40' : 'rgba(255,255,255,0.08)',
              color: showSidebar ? '#c2d94c' : '#5c6773',
            }}
          >
            {showSidebar ? 'CMDS [-]' : 'CMDS [+]'}
          </button>
        </div>
      </div>

      {/* ── Main Content Area ─────────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0">

        {/* ── Quick Commands Sidebar ──────────────────────────────────────── */}
        <AnimatePresence>
          {showSidebar && (
            <motion.div
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 260, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="shrink-0 overflow-hidden border-r"
              style={{ background: '#1a1f26', borderColor: 'rgba(255,255,255,0.06)' }}
            >
              <div className="p-3 overflow-y-auto h-full">
                <div className="text-[10px] uppercase tracking-widest mb-3" style={{ color: '#5c6773' }}>
                  Quick Commands
                </div>

                {Object.entries(groupedCommands).map(([category, commands]) => (
                  <div key={category} className="mb-4">
                    <div
                      className="text-[10px] uppercase tracking-wider mb-2 font-bold"
                      style={{ color: CATEGORY_COLORS[category] || '#5c6773' }}
                    >
                      {CATEGORY_LABELS[category] || category}
                    </div>
                    {commands.map(qc => (
                      <button
                        key={qc.label}
                        onClick={() => handleQuickCommand(qc)}
                        className="w-full text-left px-2 py-1.5 mb-0.5 rounded-none transition-colors border border-transparent hover:border-white/10 group"
                        style={{ background: 'transparent' }}
                        onMouseEnter={e => {
                          (e.currentTarget as HTMLElement).style.background = '#0a0e1480';
                        }}
                        onMouseLeave={e => {
                          (e.currentTarget as HTMLElement).style.background = 'transparent';
                        }}
                      >
                        <div className="text-xs font-mono truncate" style={{ color: '#e6e1cf' }}>
                          {qc.label}
                        </div>
                        <div className="text-[10px] truncate" style={{ color: '#5c6773' }}>
                          {qc.description}
                        </div>
                      </button>
                    ))}
                  </div>
                ))}

                {/* Keyboard shortcuts */}
                <div className="mt-6 pt-3 border-t" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
                  <div className="text-[10px] uppercase tracking-widest mb-2" style={{ color: '#5c6773' }}>
                    Shortcuts
                  </div>
                  <div className="space-y-1 text-[10px]" style={{ color: '#5c6773' }}>
                    <div className="flex justify-between">
                      <span>Enter</span>
                      <span>Execute</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Up/Down</span>
                      <span>History</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Tab</span>
                      <span>Complete</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Ctrl+L</span>
                      <span>Clear</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Ctrl+C</span>
                      <span>Cancel</span>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Terminal Area ────────────────────────────────────────────────── */}
        <div className="flex flex-col flex-1 min-w-0">

          {/* Scrollable output */}
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto px-4 py-3 cursor-text"
            style={{ background: '#0a0e14' }}
            onClick={handleTerminalClick}
          >
            {/* Welcome banner */}
            {entries.length === 0 && !isExecuting && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.4 }}
                className="mb-4"
              >
                <pre className="text-xs leading-tight" style={{ color: '#c2d94c' }}>
{`  ██████╗ ████████╗    ████████╗███████╗██████╗ ███╗   ███╗
 ██╔════╝ ╚══██╔══╝    ╚══██╔══╝██╔════╝██╔══██╗████╗ ████║
 ██║  ███╗   ██║          ██║   █████╗  ██████╔╝██╔████╔██║
 ██║   ██║   ██║          ██║   ██╔══╝  ██╔══██╗██║╚██╔╝██║
 ╚██████╔╝   ██║          ██║   ███████╗██║  ██║██║ ╚═╝ ██║
  ╚═════╝    ╚═╝          ╚═╝   ╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝`}
                </pre>
                <div className="mt-3 text-xs" style={{ color: '#5c6773' }}>
                  Gas Town CLI Terminal v1.0.0 — type{' '}
                  <span style={{ color: '#c2d94c' }}>gt help</span> to get started
                </div>
                <div className="text-xs mt-1" style={{ color: '#5c6773' }}>
                  Session {session.sessionId} | Backend: {API}
                </div>
              </motion.div>
            )}

            {/* Command entries */}
            <AnimatePresence initial={false}>
              {entries.map(entry => (
                <TerminalEntryBlock key={entry.id} entry={entry} />
              ))}
            </AnimatePresence>

            {/* Loading spinner */}
            {isExecuting && <CommandSpinner />}

            {/* Tab suggestions */}
            {tabSuggestions.length > 1 && (
              <div className="mb-2 flex flex-wrap gap-2 text-xs font-mono">
                {tabSuggestions.map((s, i) => (
                  <span
                    key={s}
                    style={{
                      color: i === ((tabIndex - 1 + tabSuggestions.length) % tabSuggestions.length) ? '#c2d94c' : '#5c6773',
                    }}
                  >
                    {s}
                  </span>
                ))}
              </div>
            )}

            {/* Invisible scroll anchor */}
            <div ref={bottomRef} />
          </div>

          {/* ── Command Input ─────────────────────────────────────────────── */}
          <div
            className="shrink-0 border-t px-4 py-2 flex items-center gap-0"
            style={{
              background: '#1a1f26',
              borderColor: 'rgba(255,255,255,0.06)',
            }}
          >
            {/* Prompt prefix */}
            <span
              className="select-none font-bold text-sm shrink-0"
              style={{ color: '#c2d94c' }}
            >
              {PROMPT_PREFIX}
            </span>

            {/* Input */}
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isExecuting}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              placeholder={isExecuting ? 'executing...' : 'type a command...'}
              className="flex-1 bg-transparent outline-none font-mono text-sm placeholder:text-white/15"
              style={{
                color: '#e6e1cf',
                caretColor: '#c2d94c',
              }}
            />

            {/* Status indicator */}
            <div className="shrink-0 flex items-center gap-2 ml-2">
              {isExecuting ? (
                <motion.div
                  className="w-2 h-2 rounded-full"
                  style={{ background: '#ffb454' }}
                  animate={{ opacity: [1, 0.3, 1] }}
                  transition={{ duration: 0.8, repeat: Infinity }}
                />
              ) : (
                <div
                  className="w-2 h-2 rounded-full"
                  style={{ background: '#c2d94c' }}
                />
              )}
              <span className="text-[10px]" style={{ color: '#5c6773' }}>
                {isExecuting ? 'BUSY' : 'READY'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
