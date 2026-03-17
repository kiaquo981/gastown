# Gas Town — Complete System Architecture

## 1. High-Level System Overview

```mermaid
graph TB
    subgraph INFRA["Infrastructure"]
        VERCEL["Vercel CDN<br/>Next.js 15 + React 19<br/>26 Views"]
        RAILWAY["Railway<br/>Express + Node 22<br/>~98k LOC Backend"]
        SUPABASE[("Supabase PostgreSQL<br/>Persistent State")]
    end

    subgraph FRONTEND["Frontend — 4 Nav Groups"]
        CORE["CORE<br/>HQ | Timeline"]
        ENGINE["ENGINE<br/>Guzzoline | Terminal | GUPP<br/>Chemistry | NDI | Seance<br/>tmux | Maestro"]
        MEOW_V["MEOW<br/>Molecules | Beads | Convoys<br/>Workers | Mayor | Observatory<br/>Refinery | Patrol | Skills<br/>Wisps | Quality Gate"]
        WORKERS_V["WORKERS<br/>Hooks | Polecats | Crew<br/>Deacon | Mail"]
    end

    VERCEL --> CORE & ENGINE & MEOW_V & WORKERS_V
    CORE & ENGINE & MEOW_V & WORKERS_V -->|fetch + SSE| RAILWAY
    RAILWAY -->|SQL| SUPABASE

    style VERCEL fill:#1a1f26,stroke:#95e6cb,color:#e6e1cf
    style RAILWAY fill:#1a1f26,stroke:#c2d94c,color:#e6e1cf
    style SUPABASE fill:#1a1f26,stroke:#d2a6ff,color:#e6e1cf
    style CORE fill:#0f1419,stroke:#95e6cb,color:#95e6cb
    style ENGINE fill:#0f1419,stroke:#d2a6ff,color:#d2a6ff
    style MEOW_V fill:#0f1419,stroke:#c2d94c,color:#c2d94c
    style WORKERS_V fill:#0f1419,stroke:#ffb454,color:#ffb454
```

## 2. Backend Architecture — Module Map

```mermaid
graph LR
    subgraph EXPRESS["Express Server :3000"]
        HEALTH["/health<br/>/readiness"]
        SSE["/api/events<br/>SSE Stream"]
    end

    subgraph MEOW["MEOW Core Routes"]
        MEOW_R["/api/meow/*<br/>cook | pour | wisp | squash"]
        BEADS_R["/api/beads/*<br/>CRUD | deps | search"]
        WORKER_R["/api/meow/mayor | gupp<br/>polecats | witness | deacon<br/>boot | crew | overseer | mail"]
        SKILL_R["/api/meow/skills/*<br/>registry | execute"]
        OBS_R["/api/meow/observability/*<br/>townlog | keepalive | budget"]
        TOWN_R["/api/meow/town/*<br/>pulse | buildings | timeline<br/>maestro bridge"]
        REFINERY_R["/api/meow/refinery/*<br/>queue | gates | merge"]
        GUARD_R["/api/meow/guard/*<br/>state transitions"]
    end

    subgraph INTEGRATIONS["Integration Modules"]
        MAESTRO_R["/api/maestro/*<br/>agents | worktrees<br/>playbooks | sessions<br/>dispatch"]
        FRANK_R["/api/frankflow/*<br/>checkpoints | orphans<br/>retries | routing<br/>patterns | quality<br/>review | spec-sync"]
    end

    EXPRESS --> MEOW
    EXPRESS --> INTEGRATIONS

    style EXPRESS fill:#0f1419,stroke:#95e6cb,color:#e6e1cf
    style MEOW fill:#1a1f26,stroke:#c2d94c,color:#c2d94c
    style INTEGRATIONS fill:#1a1f26,stroke:#d2a6ff,color:#d2a6ff
```

## 3. MEOW Engine — Molecular State Machine

```mermaid
stateDiagram-v2
    [*] --> ICE9: Formula (TOML)
    ICE9 --> SOLID: cook(formula, vars)
    SOLID --> LIQUID: pour(protoId)
    SOLID --> VAPOR: wisp(protoId, ttl)
    LIQUID --> DIGESTED: squash(moleculeId)
    VAPOR --> DESTROYED: burn(wispId)
    VAPOR --> LIQUID: promote(wispId)
    DIGESTED --> [*]
    DESTROYED --> [*]

    state ICE9 {
        [*] --> FormulaSource
        FormulaSource: 10 Built-in Templates
        FormulaSource: + Custom TOML
    }

    state SOLID {
        [*] --> Protomolecule
        Protomolecule: Immutable Snapshot
        Protomolecule: Reusable Template
    }

    state LIQUID {
        [*] --> ActiveMolecule
        ActiveMolecule: DAG of Steps
        ActiveMolecule: DB-Persisted
        ActiveMolecule: Executing
        ActiveMolecule --> StepComplete
        ActiveMolecule --> StepFailed
    }

    state VAPOR {
        [*] --> EphemeralWisp
        EphemeralWisp: In-Memory Only
        EphemeralWisp: TTL Countdown
        EphemeralWisp: Auto-Expires
    }
```

## 4. Complete Bead Lifecycle — From Creation to Done

```mermaid
flowchart TD
    CREATE["Bead Created<br/>status: backlog"] --> READY_CHECK{"Dependencies<br/>resolved?"}
    READY_CHECK -->|No| BLOCKED["status: blocked<br/>Wait for deps"]
    BLOCKED --> READY_CHECK
    READY_CHECK -->|Yes| READY["status: ready"]

    READY --> AUTO_LOOP{"Autonomous Loop<br/>scans every 30s"}
    AUTO_LOOP --> GUPP["GUPP placeHook()<br/>Hook → Worker"]

    GUPP --> ROUTE{"Smart Router<br/>13 categories"}
    ROUTE -->|debug| DEBUGGER["Debugger Agent"]
    ROUTE -->|security| SECURITY["Security Sentinel"]
    ROUTE -->|feature| CODER["Code Agent"]
    ROUTE -->|review| REVIEWER["Review Agent"]
    ROUTE -->|default| DEFAULT["Default Skill"]

    DEBUGGER & SECURITY & CODER & REVIEWER & DEFAULT --> DISPATCH{"Dispatch via"}
    DISPATCH -->|Local| POLECAT["Polecat Spawner<br/>Git Worktree"]
    DISPATCH -->|Remote| MAESTRO["Maestro CLI<br/>Claude/Codex/Gemini"]

    POLECAT & MAESTRO --> EXECUTE["Execute Skill<br/>status: in_progress"]

    EXECUTE --> CHECKPOINT["Checkpoint Engine<br/>JSONL save state"]
    CHECKPOINT --> GATES{"Quality Gates"}

    GATES --> TSC["tsc --noEmit"]
    GATES --> LINT["eslint"]
    GATES --> TEST["jest/vitest"]
    GATES --> AUDIT["npm audit"]
    TSC & LINT & TEST & AUDIT --> GATE_RESULT{"All pass?"}

    GATE_RESULT -->|No| AUTOFIX{"Auto-fix<br/>possible?"}
    AUTOFIX -->|Yes| FIX["Apply fixes<br/>Re-run gates"]
    FIX --> GATE_RESULT
    AUTOFIX -->|No| REVIEW_PIPE["Multi-Agent Review<br/>4 reviewers parallel"]
    REVIEW_PIPE --> FAIL_DECIDE{"Critical<br/>findings?"}
    FAIL_DECIDE -->|Yes, round < 2| FIX
    FAIL_DECIDE -->|Yes, round >= 2| FAILED["status: failed<br/>Retry Manager"]
    FAIL_DECIDE -->|No| PR

    GATE_RESULT -->|Yes| PR["Create PR<br/>Feature Branch"]

    PR --> REFINERY["Refinery Merge Queue<br/>FIFO + Priority"]
    REFINERY --> REBASE{"Conflicts?"}
    REBASE -->|Yes| RESOLVE["Rebase Strategy<br/>auto | manual | ff"]
    RESOLVE --> REFINERY
    REBASE -->|No| MERGE["Git Push<br/>Serialized Lock"]

    MERGE --> POST["Post-Merge Cleanup<br/>Delete branch"]
    POST --> DONE["status: done"]

    DONE --> CASCADE["Cascade:<br/>Wake dependent beads<br/>Update convoy<br/>Notify mail"]

    FAILED --> RETRY{"Retry Manager<br/>max 3 attempts"}
    RETRY -->|Retryable| BACKOFF["Exponential Backoff<br/>Preserve checkpoint"]
    BACKOFF --> EXECUTE
    RETRY -->|Permanent| DEAD["status: cancelled<br/>Escalate via mail"]

    CASCADE --> AUTO_LOOP

    style CREATE fill:#1a1f26,stroke:#6c7680,color:#e6e1cf
    style READY fill:#1a1f26,stroke:#c2d94c,color:#c2d94c
    style EXECUTE fill:#1a1f26,stroke:#59c2ff,color:#59c2ff
    style DONE fill:#1a1f26,stroke:#c2d94c,color:#c2d94c
    style FAILED fill:#1a1f26,stroke:#f07178,color:#f07178
    style DEAD fill:#1a1f26,stroke:#f07178,color:#f07178
    style GUPP fill:#0f1419,stroke:#ffb454,color:#ffb454
    style REFINERY fill:#0f1419,stroke:#d2a6ff,color:#d2a6ff
    style MAESTRO fill:#0f1419,stroke:#95e6cb,color:#95e6cb
    style POLECAT fill:#0f1419,stroke:#95e6cb,color:#95e6cb
```

## 5. Worker Ecosystem — 9 Roles

```mermaid
graph TB
    subgraph MAYOR_G["MAYOR — Strategic Orchestrator"]
        MAYOR["Priority scoring<br/>Resource allocation<br/>Convoy composition<br/>Conflict resolution"]
    end

    subgraph EXECUTION_G["Execution Workers"]
        POLECAT_W["POLECAT<br/>Code executor<br/>Git worktree isolation<br/>PR creation"]
        MAESTRO_W["MAESTRO<br/>Multi-agent dispatch<br/>Claude/Codex/Gemini<br/>Playbook execution"]
    end

    subgraph SUPERVISION_G["Supervision Workers"]
        WITNESS_W["WITNESS<br/>10 supervision checks<br/>Assignment tracking<br/>Escalation decisions"]
        DEACON_W["DEACON<br/>26 health checks<br/>Infrastructure monitor<br/>Alert trigger"]
    end

    subgraph SUPPORT_G["Support Workers"]
        GUPP_W["GUPP<br/>Hook placement<br/>Backpressure control<br/>NDI persistence"]
        CREW_W["CREW<br/>Team coordination<br/>Context sharing<br/>Handoff management"]
        BOOT_W["BOOT<br/>System bootstrap<br/>Startup sequences<br/>Recovery init"]
        OVERSEER_W["OVERSEER<br/>Circuit breaker<br/>Zombie detection<br/>Gate approval"]
    end

    MAYOR --> POLECAT_W & MAESTRO_W
    MAYOR --> WITNESS_W & DEACON_W
    WITNESS_W -->|supervises| POLECAT_W & MAESTRO_W
    DEACON_W -->|health checks| POLECAT_W & MAESTRO_W & GUPP_W
    GUPP_W -->|hooks| POLECAT_W & MAESTRO_W
    OVERSEER_W -->|gates| POLECAT_W & MAESTRO_W

    style MAYOR fill:#1a1f26,stroke:#ffb454,color:#ffb454
    style POLECAT_W fill:#1a1f26,stroke:#95e6cb,color:#95e6cb
    style MAESTRO_W fill:#1a1f26,stroke:#95e6cb,color:#95e6cb
    style WITNESS_W fill:#1a1f26,stroke:#d2a6ff,color:#d2a6ff
    style DEACON_W fill:#1a1f26,stroke:#d2a6ff,color:#d2a6ff
    style GUPP_W fill:#1a1f26,stroke:#59c2ff,color:#59c2ff
```

## 6. Maestro Integration — Multi-Agent Dispatch

```mermaid
sequenceDiagram
    participant GT as Gas Town
    participant AR as Agent Registry
    participant WM as Worktree Manager
    participant PE as Playbook Engine
    participant CLI as Agent CLI<br/>(Claude/Codex/Gemini)
    participant ST as Session Tracker

    GT->>AR: detectInstalledAgents()
    AR-->>GT: [claude-code, codex, gemini-cli...]

    GT->>WM: createWorktree(beadId)
    WM-->>GT: /path/to/worktree (isolated branch)

    GT->>PE: generatePlaybookFromBeads([beadIds])
    PE-->>GT: Playbook with markdown tasks

    GT->>ST: createSession(agentId, beadId)
    ST-->>GT: session-ms-xxxx

    GT->>CLI: spawn(claude --print --output-format stream-json ...)
    CLI-->>GT: stream-json events (tokens, result)

    GT->>ST: updateUsage(sessionId, tokens, cost)
    GT->>ST: completeSession(sessionId, output)

    GT->>WM: removeWorktree(path)
```

## 7. FrankFlow Execution Logic — Crash-Safe Pipeline

```mermaid
flowchart LR
    subgraph CHECKPOINT["Checkpoint Engine"]
        CE_START["Start execution"] --> CE_SAVE["saveCheckpoint(key, value)<br/>Append JSONL"]
        CE_SAVE --> CE_EXEC["Execute step"]
        CE_EXEC --> CE_CRASH{"Crash?"}
        CE_CRASH -->|Yes| CE_RESTORE["Restore from JSONL<br/>Skip completed steps"]
        CE_RESTORE --> CE_EXEC
        CE_CRASH -->|No| CE_NEXT["Next step"]
        CE_NEXT --> CE_SAVE
    end

    subgraph ORPHAN["Orphan Detector"]
        OD_SCAN["Scan workers"] --> OD_PID{"PID alive?<br/>kill(pid, 0)"}
        OD_PID -->|Dead| OD_RECOVER["Recover: reset to pending"]
        OD_PID -->|Alive| OD_HB{"Heartbeat<br/>< 5min?"}
        OD_HB -->|Stale| OD_RECOVER
        OD_HB -->|Fresh| OD_OK["Worker OK"]
    end

    subgraph RETRY["Retry Manager"]
        RM_ERR["Error occurred"] --> RM_CLASS{"Classify error"}
        RM_CLASS -->|Transient| RM_SCHED["Schedule retry<br/>Exponential backoff"]
        RM_CLASS -->|Permanent| RM_FAIL["Mark failed"]
        RM_SCHED --> RM_WAIT["Wait delay"] --> RM_EXEC["Re-execute<br/>From checkpoint"]
    end

    subgraph ROUTER["Smart Router"]
        SR_IN["Task text"] --> SR_MATCH["Pattern match<br/>13 categories"]
        SR_MATCH --> SR_OUT["Route to specialist<br/>+ inject context"]
    end

    subgraph LEARNER["Pattern Learner"]
        PL_ERR["Error"] --> PL_HASH["MD5 normalize<br/>Categorize"]
        PL_HASH --> PL_STORE["Store/increment count"]
        PL_STORE --> PL_MEM["Active Memory<br/>Top patterns at session start"]
    end

    style CHECKPOINT fill:#1a1f26,stroke:#c2d94c,color:#c2d94c
    style ORPHAN fill:#1a1f26,stroke:#f07178,color:#f07178
    style RETRY fill:#1a1f26,stroke:#ffb454,color:#ffb454
    style ROUTER fill:#1a1f26,stroke:#95e6cb,color:#95e6cb
    style LEARNER fill:#1a1f26,stroke:#d2a6ff,color:#d2a6ff
```

## 8. Quality Gate Pipeline

```mermaid
flowchart TD
    CODE["Code changes"] --> DETECT["Auto-detect tech stacks"]

    DETECT --> NPM{"package.json?"}
    DETECT --> PY{"requirements.txt?"}
    DETECT --> GO{"go.mod?"}
    DETECT --> RUST{"Cargo.toml?"}
    DETECT --> RUBY{"Gemfile?"}
    DETECT --> JAVA{"pom.xml?"}
    DETECT --> ELIXIR{"mix.exs?"}

    NPM -->|Yes| NPM_GATES["eslint<br/>tsc --noEmit<br/>vitest/jest<br/>npm run build<br/>npm audit"]
    PY -->|Yes| PY_GATES["ruff/flake8<br/>mypy<br/>pytest<br/>pip-audit"]
    GO -->|Yes| GO_GATES["go vet<br/>golangci-lint<br/>go test<br/>govulncheck"]
    RUST -->|Yes| RUST_GATES["cargo check<br/>cargo clippy<br/>cargo test<br/>cargo audit"]

    NPM_GATES & PY_GATES & GO_GATES & RUST_GATES --> RESULT{"All pass?"}

    RESULT -->|Yes| REVIEW["Multi-Agent Review<br/>4 agents parallel"]
    RESULT -->|No, fixable| AUTOFIX["Auto-fix<br/>lint --fix<br/>fmt"]
    AUTOFIX --> RESULT
    RESULT -->|No, unfixable| BLOCK["Block merge"]

    REVIEW --> SIMPLICITY["Code Simplicity<br/>YAGNI check<br/>CRITICAL"]
    REVIEW --> SECURITY_R["Security Sentinel<br/>OWASP Top 10<br/>CRITICAL"]
    REVIEW --> PATTERNS["Pattern Recognition<br/>Consistency<br/>WARNING"]
    REVIEW --> A11Y["Accessibility<br/>WCAG check<br/>WARNING"]

    SIMPLICITY & SECURITY_R & PATTERNS & A11Y --> FINDINGS{"Critical<br/>findings?"}
    FINDINGS -->|No| PASS["PASS — Merge allowed"]
    FINDINGS -->|Yes| FIX_LOOP["Auto-fix attempt<br/>Max 2 rounds"]
    FIX_LOOP --> FINDINGS

    style CODE fill:#1a1f26,stroke:#6c7680,color:#e6e1cf
    style PASS fill:#1a1f26,stroke:#c2d94c,color:#c2d94c
    style BLOCK fill:#1a1f26,stroke:#f07178,color:#f07178
```

## 9. Patrol System — Exponential Backoff Health Checks

```mermaid
flowchart LR
    subgraph DEACON["Deacon Patrol<br/>26 checks"]
        D1["Workers alive?"]
        D2["Molecules stuck?"]
        D3["Queue depth OK?"]
        D4["Memory usage?"]
        D5["Budget remaining?"]
        D6["Error rate?"]
        D7["...20 more checks"]
    end

    subgraph WITNESS["Witness Patrol<br/>10 checks"]
        W1["Polecat supervision"]
        W2["Assignment tracking"]
        W3["Skill availability"]
        W4["Gate status"]
        W5["Escalation queue"]
    end

    subgraph REFINERY_P["Refinery Patrol<br/>9 checks"]
        R1["Queue depth"]
        R2["Gate failures"]
        R3["Conflicts"]
        R4["Merge throughput"]
        R5["Stale items"]
    end

    DEACON & WITNESS & REFINERY_P --> SCORE["Aggregated<br/>Health Score<br/>0-100"]

    SCORE --> BACKOFF{"All clean?"}
    BACKOFF -->|Yes| INCREASE["Increase interval<br/>base * 2^n"]
    BACKOFF -->|No| RESET["Reset to base<br/>interval"]
    INCREASE & RESET --> NEXT["Next patrol<br/>cycle"]
    NEXT --> DEACON & WITNESS & REFINERY_P

    style SCORE fill:#1a1f26,stroke:#c2d94c,color:#c2d94c
```

## 10. Guzzoline Gauge — System Fuel

```mermaid
graph TB
    subgraph GENERATORS["Generators — Fill Tank"]
        G1["Beads Created"]
        G2["Budget Top-up"]
        G3["Slot Release"]
        G4["Quota Reset"]
    end

    subgraph GAUGE["GUZZOLINE RESERVOIR<br/>Level: 0-100"]
        BREAKDOWN["Breakdown:<br/>Beads Ready<br/>Polecat Slots<br/>Budget $<br/>API Quota %<br/>Merge Queue Space %"]
    end

    subgraph CONSUMERS["Consumers — Drain Tank"]
        C1["Polecat Work"]
        C2["API Calls"]
        C3["Merge Ops"]
        C4["Patrol Runs"]
    end

    GENERATORS -->|fill| GAUGE
    GAUGE -->|drain| CONSUMERS

    GAUGE --> PROJECTION["Burn Rate Projector<br/>Hours remaining<br/>Projected empty time"]
    PROJECTION -->|< 30%| WARNING["LOW FUEL WARNING"]

    style GAUGE fill:#1a1f26,stroke:#ffb454,color:#ffb454
    style WARNING fill:#1a1f26,stroke:#f07178,color:#f07178
```

## 11. NDI — Nondeterministic Idempotence (3 Pillars)

```mermaid
graph TB
    MOTTO["Sessions are cattle, Agents are pets"]

    subgraph PILLAR1["Pillar 1: Agent Bead"]
        AB["Persistent worker identity<br/>CV chain (task history)<br/>Crash recovery<br/>Survives session death"]
    end

    subgraph PILLAR2["Pillar 2: Hook Bead"]
        HB["GUPP work assignments<br/>Persisted in DB<br/>Claimed/completed state<br/>Survives restarts"]
    end

    subgraph PILLAR3["Pillar 3: Molecule Chain"]
        MC["Step execution state<br/>DAG progress<br/>Checkpoint JSONL<br/>Convoy association"]
    end

    PILLAR1 <-->|"linked"| PILLAR2
    PILLAR2 <-->|"linked"| PILLAR3
    PILLAR3 <-->|"linked"| PILLAR1

    subgraph GIT["Git-Backed Persistence"]
        DB["PostgreSQL (all 3 pillars)"]
        JSONL["JSONL Checkpoints"]
        BRANCH["Feature Branches"]
    end

    PILLAR1 & PILLAR2 & PILLAR3 --> GIT

    MOTTO ~~~ PILLAR1

    style PILLAR1 fill:#1a1f26,stroke:#95e6cb,color:#95e6cb
    style PILLAR2 fill:#1a1f26,stroke:#ffb454,color:#ffb454
    style PILLAR3 fill:#1a1f26,stroke:#d2a6ff,color:#d2a6ff
    style GIT fill:#0f1419,stroke:#6c7680,color:#6c7680
```

## 12. Intelligence Layer — 34 Cognitive Modules

```mermaid
graph TB
    subgraph SCORING["Scoring & Selection"]
        S1["Priority Scoring"]
        S2["Skill Performance Ranking"]
        S3["Skill Auto-Selection"]
        S4["Convoy Composition"]
        S5["Resource Allocation"]
        S6["Dynamic Tier Adjustment"]
    end

    subgraph PREDICTION["Prediction"]
        P1["Demand Forecasting"]
        P2["Failure Prediction"]
        P3["Outcome Prediction"]
        P4["Cost Forecasting"]
        P5["Drift Detection"]
    end

    subgraph LEARNING["Learning & Memory"]
        L1["Worker Performance Learning"]
        L2["Pattern Library"]
        L3["Continuous Improvement"]
        L4["Cross-Molecule Knowledge"]
        L5["MegaBrain Context Injection"]
        L6["NOUS Epistemic Oracle"]
    end

    subgraph DECISIONS["Decision-Making"]
        D1["Auto-Retry Intelligence"]
        D2["Auto-Approve Engine"]
        D3["Conflict Resolution"]
        D4["Escalation Intelligence"]
        D5["Queue Rebalancing"]
        D6["Budget Management"]
    end

    SCORING --> DECISIONS
    PREDICTION --> DECISIONS
    LEARNING --> SCORING & PREDICTION

    style SCORING fill:#1a1f26,stroke:#c2d94c,color:#c2d94c
    style PREDICTION fill:#1a1f26,stroke:#ffb454,color:#ffb454
    style LEARNING fill:#1a1f26,stroke:#d2a6ff,color:#d2a6ff
    style DECISIONS fill:#1a1f26,stroke:#95e6cb,color:#95e6cb
```

## 13. Mail System — Inter-Agent Communication

```mermaid
flowchart LR
    SENDER["Sender Worker"] --> MAIL["Mail Router"]

    MAIL --> DIRECT["Direct Delivery<br/>Single recipient"]
    MAIL --> BROADCAST["Broadcast<br/>All workers in role"]

    DIRECT & BROADCAST --> PRIORITY{"Priority"}
    PRIORITY -->|Critical| SSE_B["SSE Broadcast"] & WA["WhatsApp Alert"] & MAILBOX["Mailbox"]
    PRIORITY -->|High| SSE_B & MAILBOX
    PRIORITY -->|Normal| MAILBOX
    PRIORITY -->|Low| MAILBOX

    MAILBOX --> DND{"DND on?"}
    DND -->|Yes, non-critical| SUPPRESS["Suppress"]
    DND -->|No or critical| DELIVER["Deliver to inbox"]

    DELIVER --> CLEANUP["Auto-cleanup<br/>Read msgs > 24h"]

    style MAIL fill:#1a1f26,stroke:#59c2ff,color:#59c2ff
    style WA fill:#1a1f26,stroke:#c2d94c,color:#c2d94c
```

## 14. Deployment Architecture

```mermaid
graph TB
    DEV["Developer"] -->|git push| GITHUB["GitHub<br/>kiaquo981/gastown"]

    GITHUB -->|"railway up"| RAILWAY_BUILD["Railway Build<br/>Docker multi-stage<br/>Node 22-slim"]
    RAILWAY_BUILD --> RAILWAY_DEPLOY["Railway Deploy<br/>gastown-production.up.railway.app<br/>Health: /health<br/>SSE: /api/events"]

    GITHUB -->|"vercel --prod"| VERCEL_BUILD["Vercel Build<br/>next build"]
    VERCEL_BUILD --> VERCEL_DEPLOY["Vercel Deploy<br/>frontend-alpha-six-57.vercel.app<br/>CDN Edge"]

    RAILWAY_DEPLOY -->|DATABASE_URL| SUPABASE_DB[("Supabase PostgreSQL<br/>knusqfbvhsqworzyhvip<br/>Migrations auto-applied")]

    VERCEL_DEPLOY -->|"NEXT_PUBLIC_GASTOWN_URL"| RAILWAY_DEPLOY

    subgraph ENV["Environment Variables"]
        E1["DATABASE_URL"]
        E2["GASTOWN_API_KEY"]
        E3["MEOW_AUTONOMOUS"]
        E4["MEOW_AUTO_INTERVAL_MS"]
        E5["MEOW_AUTO_MAX_INFLIGHT"]
        E6["NODE_ENV=production"]
    end

    RAILWAY_DEPLOY -.-> ENV

    style GITHUB fill:#1a1f26,stroke:#6c7680,color:#e6e1cf
    style RAILWAY_DEPLOY fill:#1a1f26,stroke:#c2d94c,color:#c2d94c
    style VERCEL_DEPLOY fill:#1a1f26,stroke:#95e6cb,color:#95e6cb
    style SUPABASE_DB fill:#1a1f26,stroke:#d2a6ff,color:#d2a6ff
```

## System Stats

| Metric | Value |
|--------|-------|
| Backend LOC | ~98,000 |
| Frontend LOC | ~22,000 |
| Total LOC | ~120,000 |
| Frontend Views | 26 |
| API Endpoints | ~280 |
| Worker Roles | 9 |
| Cognitive Modules | 34 |
| Sovereign Systems | 28 |
| Built-in Skills | 9 |
| Formula Templates | 10 |
| FrankFlow Modules | 9 |
| Maestro Modules | 5 |
| Patrol Checks | 45 (26+10+9) |
| Tech Stack Gates | 7 |

---

*Gas Town — AI Agent Orchestration Engine*
*"Physics over politeness. If there is work on your hook, YOU MUST RUN IT."*
