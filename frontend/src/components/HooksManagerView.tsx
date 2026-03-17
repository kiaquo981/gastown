'use client'

import { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

const API = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || 'http://localhost:8081'

interface Hook {
  id: string
  name: string
  type: 'pre' | 'post'
  target: 'create' | 'update' | 'close' | 'assign' | 'dep_add' | 'dep_remove'
  enabled: boolean
  actionUrl?: string
  script?: string
  description?: string
  createdAt: string
  updatedAt: string
  lastFired?: string
  fireCount: number
}

interface HookExecution {
  id: string
  hookId: string
  hookName: string
  beadId: string
  result: 'success' | 'error'
  message?: string
  duration: number
  timestamp: string
}

const TARGET_LABELS: Record<string, string> = {
  create: 'On Create',
  update: 'On Update',
  close: 'On Close',
  assign: 'On Assign',
  dep_add: 'On Dep Add',
  dep_remove: 'On Dep Remove',
}

const TYPE_LABELS: Record<string, { text: string; color: string }> = {
  pre: { text: 'PRE', color: 'text-orange-400 bg-orange-500/10 border-orange-500/20' },
  post: { text: 'POST', color: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20' },
}

export default function HooksManagerView() {
  const [hooks, setHooks] = useState<Hook[]>([])
  const [executions, setExecutions] = useState<HookExecution[]>([])
  const [expandedHook, setExpandedHook] = useState<string | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [activeTab, setActiveTab] = useState<'registry' | 'log'>('registry')
  const [toggling, setToggling] = useState<string | null>(null)

  // Form state
  const [formName, setFormName] = useState('')
  const [formType, setFormType] = useState<'pre' | 'post'>('post')
  const [formTarget, setFormTarget] = useState<string>('create')
  const [formActionUrl, setFormActionUrl] = useState('')
  const [formScript, setFormScript] = useState('')
  const [formDesc, setFormDesc] = useState('')

  const fetchHooks = useCallback(async (signal?: AbortSignal) => {
    try {
      const [hRes, eRes] = await Promise.all([
        fetch(`${API}/api/hooks`, { signal }).catch(() => null),
        fetch(`${API}/api/hooks/executions?limit=100`, { signal }).catch(() => null),
      ])
      if (hRes?.ok) setHooks((await hRes.json()).hooks || [])
      if (eRes?.ok) setExecutions((await eRes.json()).executions || [])
    } catch {
      /* aborted */
    }
  }, [])

  useEffect(() => {
    const ac = new AbortController()
    fetchHooks(ac.signal)
    const iv = setInterval(() => fetchHooks(), 8000)
    return () => { ac.abort(); clearInterval(iv) }
  }, [fetchHooks])

  const toggleHook = async (hook: Hook) => {
    setToggling(hook.id)
    try {
      const res = await fetch(`${API}/api/hooks/${hook.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !hook.enabled }),
      })
      if (res.ok) {
        setHooks(prev => prev.map(h =>
          h.id === hook.id ? { ...h, enabled: !h.enabled } : h
        ))
      }
    } catch {
      /* error */
    } finally {
      setToggling(null)
    }
  }

  const deleteHook = async (hookId: string) => {
    try {
      const res = await fetch(`${API}/api/hooks/${hookId}`, { method: 'DELETE' })
      if (res.ok) {
        setHooks(prev => prev.filter(h => h.id !== hookId))
        if (expandedHook === hookId) setExpandedHook(null)
      }
    } catch {
      /* error */
    }
  }

  const addHook = async () => {
    if (!formName.trim()) return
    try {
      const body: Record<string, unknown> = {
        name: formName.trim(),
        type: formType,
        target: formTarget,
        enabled: true,
      }
      if (formActionUrl.trim()) body.actionUrl = formActionUrl.trim()
      if (formScript.trim()) body.script = formScript.trim()
      if (formDesc.trim()) body.description = formDesc.trim()

      const res = await fetch(`${API}/api/hooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        resetForm()
        setShowAddForm(false)
        fetchHooks()
      }
    } catch {
      /* error */
    }
  }

  const resetForm = () => {
    setFormName('')
    setFormType('post')
    setFormTarget('create')
    setFormActionUrl('')
    setFormScript('')
    setFormDesc('')
  }

  const formatDate = (d: string | undefined) => {
    if (!d) return '--'
    try {
      return new Date(d).toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
      })
    } catch { return d }
  }

  const timeAgo = (d: string) => {
    const diff = Date.now() - new Date(d).getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    return `${Math.floor(hrs / 24)}d ago`
  }

  const hookExecs = expandedHook
    ? executions.filter(e => e.hookId === expandedHook).slice(0, 20)
    : []

  return (
    <div className="min-h-screen bg-[#0a0e17] text-white/[0.87] font-mono p-4">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center justify-between mb-5"
      >
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-bold tracking-wide text-white/90">HOOKS MANAGER</h1>
          <span className="text-xs text-white/20">{hooks.length} hooks registered</span>
        </div>
        <button
          onClick={() => { setShowAddForm(!showAddForm); if (showAddForm) resetForm() }}
          className={`px-3 py-1.5 text-xs border rounded-none transition-colors ${
            showAddForm
              ? 'bg-red-500/10 border-red-500/20 text-red-400'
              : 'bg-violet-500/20 border-violet-500/30 text-violet-300 hover:bg-violet-500/30'
          }`}
        >
          {showAddForm ? 'CANCEL' : '+ ADD HOOK'}
        </button>
      </motion.div>

      {/* Add Hook Form */}
      <AnimatePresence>
        {showAddForm && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="mb-5 bg-[#080b14] border border-violet-500/20 rounded-none overflow-hidden"
          >
            <div className="p-4 space-y-3">
              <p className="text-xs text-white/40 uppercase tracking-wider font-semibold">New Hook</p>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="text-[10px] text-white/30 uppercase mb-1 block">Name</label>
                  <input
                    value={formName}
                    onChange={e => setFormName(e.target.value)}
                    placeholder="my-hook"
                    className="w-full bg-[#0a0e17] border border-white/10 rounded-none px-3 py-2 text-xs text-white/70 placeholder-white/15 focus:outline-none focus:border-white/20"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-white/30 uppercase mb-1 block">Type</label>
                  <select
                    value={formType}
                    onChange={e => setFormType(e.target.value as 'pre' | 'post')}
                    className="w-full bg-[#0a0e17] border border-white/10 rounded-none px-3 py-2 text-xs text-white/70 focus:outline-none"
                  >
                    <option value="pre" className="bg-[#080b14]">Pre</option>
                    <option value="post" className="bg-[#080b14]">Post</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] text-white/30 uppercase mb-1 block">Target</label>
                  <select
                    value={formTarget}
                    onChange={e => setFormTarget(e.target.value)}
                    className="w-full bg-[#0a0e17] border border-white/10 rounded-none px-3 py-2 text-xs text-white/70 focus:outline-none"
                  >
                    {Object.entries(TARGET_LABELS).map(([k, v]) => (
                      <option key={k} value={k} className="bg-[#080b14]">{v}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="text-[10px] text-white/30 uppercase mb-1 block">Action URL (webhook)</label>
                <input
                  value={formActionUrl}
                  onChange={e => setFormActionUrl(e.target.value)}
                  placeholder="https://example.com/webhook"
                  className="w-full bg-[#0a0e17] border border-white/10 rounded-none px-3 py-2 text-xs text-white/70 placeholder-white/15 focus:outline-none focus:border-white/20"
                />
              </div>

              <div>
                <label className="text-[10px] text-white/30 uppercase mb-1 block">Script (alternative to URL)</label>
                <textarea
                  value={formScript}
                  onChange={e => setFormScript(e.target.value)}
                  placeholder="// JavaScript hook script"
                  rows={3}
                  className="w-full bg-[#0a0e17] border border-white/10 rounded-none px-3 py-2 text-xs text-white/70 placeholder-white/15 focus:outline-none focus:border-white/20 resize-y"
                />
              </div>

              <div>
                <label className="text-[10px] text-white/30 uppercase mb-1 block">Description</label>
                <input
                  value={formDesc}
                  onChange={e => setFormDesc(e.target.value)}
                  placeholder="What this hook does..."
                  className="w-full bg-[#0a0e17] border border-white/10 rounded-none px-3 py-2 text-xs text-white/70 placeholder-white/15 focus:outline-none focus:border-white/20"
                />
              </div>

              <div className="flex gap-2 pt-1">
                <button
                  onClick={addHook}
                  disabled={!formName.trim()}
                  className="px-4 py-2 text-xs font-semibold bg-violet-500/20 border border-violet-500/30 text-violet-300 rounded-none hover:bg-violet-500/30 transition-colors disabled:opacity-30"
                >
                  CREATE HOOK
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Tabs */}
      <div className="flex border-b border-white/5 mb-4">
        {(['registry', 'log'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-xs uppercase tracking-wider transition-colors ${
              activeTab === tab
                ? 'text-white/80 border-b-2 border-violet-500/60'
                : 'text-white/30 hover:text-white/50'
            }`}
          >
            {tab === 'registry' ? 'Hook Registry' : 'Execution Log'}
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait">
        {/* Registry Tab */}
        {activeTab === 'registry' && (
          <motion.div
            key="registry"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="space-y-2"
          >
            {hooks.length === 0 ? (
              <div className="bg-[#080b14] border border-white/5 rounded-none p-8 text-center">
                <p className="text-sm text-white/20">No hooks registered</p>
                <p className="text-[10px] text-white/10 mt-1">Click &quot;+ ADD HOOK&quot; to create one</p>
              </div>
            ) : (
              hooks.map((hook, i) => {
                const typeInfo = TYPE_LABELS[hook.type]
                const isExpanded = expandedHook === hook.id
                return (
                  <motion.div
                    key={hook.id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.03 }}
                    className="bg-[#080b14] border border-white/5 rounded-none hover:border-white/10 transition-colors"
                  >
                    {/* Hook row */}
                    <div className="p-3 flex items-center gap-3">
                      {/* Toggle switch */}
                      <button
                        onClick={() => toggleHook(hook)}
                        disabled={toggling === hook.id}
                        className={`relative w-10 h-5 rounded-full transition-colors ${
                          hook.enabled ? 'bg-emerald-500/30' : 'bg-white/10'
                        }`}
                      >
                        <motion.div
                          animate={{ x: hook.enabled ? 20 : 2 }}
                          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                          className={`absolute top-0.5 w-4 h-4 rounded-full transition-colors ${
                            hook.enabled ? 'bg-emerald-400' : 'bg-white/30'
                          }`}
                        />
                      </button>

                      {/* Info */}
                      <div
                        className="flex-1 cursor-pointer min-w-0"
                        onClick={() => setExpandedHook(isExpanded ? null : hook.id)}
                      >
                        <div className="flex items-center gap-2">
                          <h3 className="text-sm font-semibold text-white/80 truncate">{hook.name}</h3>
                          <span className={`px-1.5 py-0.5 text-[8px] border rounded-none ${typeInfo.color}`}>
                            {typeInfo.text}
                          </span>
                          <span className="px-1.5 py-0.5 text-[8px] bg-white/5 border border-white/10 text-white/30 rounded-none">
                            {TARGET_LABELS[hook.target]}
                          </span>
                        </div>
                        {hook.description && (
                          <p className="text-[10px] text-white/25 mt-0.5 truncate">{hook.description}</p>
                        )}
                      </div>

                      {/* Meta */}
                      <div className="flex items-center gap-3 text-[10px] text-white/20">
                        <span title="Fire count">{hook.fireCount}x</span>
                        {hook.lastFired && (
                          <span title="Last fired">{timeAgo(hook.lastFired)}</span>
                        )}
                      </div>

                      {/* Delete */}
                      <button
                        onClick={() => deleteHook(hook.id)}
                        className="text-[10px] text-red-400/30 hover:text-red-400 transition-colors px-1"
                      >
                        {'\u2715'}
                      </button>
                    </div>

                    {/* Expanded detail */}
                    <AnimatePresence>
                      {isExpanded && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          className="border-t border-white/5"
                        >
                          <div className="p-4 space-y-3">
                            {/* Config */}
                            <div className="grid grid-cols-2 gap-3">
                              <div className="bg-[#0a0e17] border border-white/5 rounded-none p-3">
                                <p className="text-[9px] text-white/25 uppercase mb-1">Action URL</p>
                                <p className="text-xs text-cyan-400/60 font-mono break-all">
                                  {hook.actionUrl || '--'}
                                </p>
                              </div>
                              <div className="bg-[#0a0e17] border border-white/5 rounded-none p-3">
                                <p className="text-[9px] text-white/25 uppercase mb-1">Script</p>
                                <pre className="text-[10px] text-white/40 whitespace-pre-wrap break-all max-h-[80px] overflow-y-auto">
                                  {hook.script || '--'}
                                </pre>
                              </div>
                            </div>

                            {/* Metadata */}
                            <div className="flex items-center gap-4 text-[10px] text-white/15">
                              <span>ID: {hook.id}</span>
                              <span>Created: {formatDate(hook.createdAt)}</span>
                              <span>Updated: {formatDate(hook.updatedAt)}</span>
                            </div>

                            {/* Recent executions for this hook */}
                            <div>
                              <p className="text-[10px] text-white/30 uppercase tracking-wider mb-2">
                                Recent Executions ({hookExecs.length})
                              </p>
                              {hookExecs.length === 0 ? (
                                <p className="text-[10px] text-white/15">No executions yet</p>
                              ) : (
                                <div className="space-y-1">
                                  {hookExecs.map(exec => (
                                    <div
                                      key={exec.id}
                                      className="flex items-center gap-2 px-2 py-1.5 bg-white/[0.02] border border-white/5 rounded-none"
                                    >
                                      <span className={`w-1.5 h-1.5 rounded-full ${
                                        exec.result === 'success' ? 'bg-emerald-400' : 'bg-red-400'
                                      }`} />
                                      <span className="text-[10px] text-white/40 font-mono">{exec.beadId}</span>
                                      <span className="text-[9px] text-white/20 flex-1 truncate">{exec.message || '--'}</span>
                                      <span className="text-[9px] text-white/15">{exec.duration}ms</span>
                                      <span className="text-[9px] text-white/10">{timeAgo(exec.timestamp)}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.div>
                )
              })
            )}
          </motion.div>
        )}

        {/* Log Tab */}
        {activeTab === 'log' && (
          <motion.div
            key="log"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            {executions.length === 0 ? (
              <div className="bg-[#080b14] border border-white/5 rounded-none p-8 text-center">
                <p className="text-sm text-white/20">No hook executions recorded</p>
              </div>
            ) : (
              <div className="space-y-0">
                {/* Header row */}
                <div className="flex items-center gap-3 px-3 py-2 text-[9px] text-white/20 uppercase tracking-wider border-b border-white/5">
                  <span className="w-4" />
                  <span className="w-32">Hook</span>
                  <span className="w-24">Bead</span>
                  <span className="flex-1">Message</span>
                  <span className="w-16 text-right">Duration</span>
                  <span className="w-24 text-right">Time</span>
                </div>

                {executions.map((exec, i) => (
                  <motion.div
                    key={exec.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: i * 0.015 }}
                    className="flex items-center gap-3 px-3 py-2 border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors"
                  >
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                      exec.result === 'success' ? 'bg-emerald-400' : 'bg-red-400'
                    }`} />
                    <span className="w-32 text-xs text-white/50 truncate">{exec.hookName}</span>
                    <span className="w-24 text-[10px] text-white/30 font-mono">{exec.beadId}</span>
                    <span className="flex-1 text-[10px] text-white/25 truncate">{exec.message || '--'}</span>
                    <span className="w-16 text-[10px] text-white/15 text-right">{exec.duration}ms</span>
                    <span className="w-24 text-[9px] text-white/10 text-right">{formatDate(exec.timestamp)}</span>
                  </motion.div>
                ))}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
