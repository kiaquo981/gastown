# Gas Town — Masterclass Completa

> "Gas Town é Kubernetes cruzado com Temporal — mas pra agentes de IA, não pra containers."
> — Steve Yegge, criador do Gas Town

---

## 1. O QUE É GAS TOWN

Gas Town é uma **fábrica autônoma de código**. Tu joga trabalho, ele organiza, distribui pra agentes de IA, monitora execução, mergeia resultados, e te entrega PRs prontos.

Criado por Steve Yegge (ex-Amazon, ex-Google, autor dos rants lendários) em Go (~189k linhas, ~2000 commits em 17 dias). Lançado em 1 de janeiro de 2026. A versão neste repo é um port TypeScript white-label.

A metáfora é **Mad Max: Fury Road**:
- **Gas Town** = a cidade industrial que produz combustível pro deserto
- **Guzzoline** = o combustível (capacidade computacional)
- **Rigs** = os projetos (como war rigs)
- **Polecats** = os war boys descartáveis que saem, lutam e morrem
- **Refinery** = onde o output bruto é processado e mergeado
- **Convoys** = movimentos coordenados entregando trabalho
- **Wasteland** = o ecossistema de Gas Towns federados

---

## 2. A ESCALA DE MATURIDADE (Stages 1-8)

```mermaid
graph LR
    S1["Stage 1-4<br/>IDE + Copilot"]
    S5["Stage 5<br/>1 agente<br/>(Claude Code)"]
    S6["Stage 6<br/>3-5 agentes<br/>YOLO mode"]
    S7["Stage 7<br/>10+ agentes<br/>coordenação manual"]
    S8["Stage 8<br/>20-30+ agentes<br/>GAS TOWN"]

    S1 -->|"aprender prompting"| S5
    S5 -->|"perceber que 1 é pouco"| S6
    S6 -->|"caos começa"| S7
    S7 -->|"precisa de fábrica"| S8

    style S8 fill:#c2d94c,stroke:#0f1419,color:#0f1419,stroke-width:3px
    style S1 fill:#2d363f,stroke:#6c7680,color:#e6e1cf
    style S5 fill:#2d363f,stroke:#6c7680,color:#e6e1cf
    style S6 fill:#2d363f,stroke:#6c7680,color:#e6e1cf
    style S7 fill:#2d363f,stroke:#6c7680,color:#e6e1cf
```

Gas Town é pra quem já tá no Stage 7+ — se tu não tá gerenciando múltiplos agentes simultaneamente, ele vai ser contraproducente.

---

## 3. FILOSOFIA CORE

### "Gado, Não Pets"
- **Sessões são gado** — efêmeras, descartáveis, matáveis
- **Agentes são identidades persistentes** — história e contexto sobrevivem morte de sessão
- **Estado vive no Git e no banco, não na memória** — se crashar, o próximo agente olha o hook e continua

### "Física, Não Educação"
A regra fundamental: **"Se tem trabalho no teu Hook, TU TEM QUE EXECUTAR."**
Sem perguntar, sem esperar, sem discutir. Acordou → olha o hook → executa.

### "Caminho Não-Determinístico, Resultado Convergente"
Cada agente pode tomar caminhos diferentes. Mas o resultado converge porque:
1. O workflow (formula) é imutável
2. Os critérios de aceite são explícitos
3. Os três pilares de persistência rastreiam O QUE foi feito, não COMO

---

## 4. MEOW — O MOTOR MOLECULAR (Molecular Expression of Work)

Todo trabalho no Gas Town passa por 4 fases, modeladas como estados da matéria:

```mermaid
graph TB
    subgraph "MEOW State Machine"
        ICE9["❄️ ICE9<br/>Template Congelado<br/>(TOML no Git)"]
        SOLID["🧊 SOLID<br/>Protomolecule<br/>(variáveis substituídas,<br/>ainda não executando)"]
        LIQUID["💧 LIQUID<br/>Molecule<br/>(executando, persistido<br/>no PostgreSQL)"]
        VAPOR["💨 VAPOR<br/>Wisp<br/>(efêmero, in-memory,<br/>TTL countdown)"]
        DEAD["💀 Destruído<br/>(só artefatos restam)"]
        CONDENSED["📦 Condensado<br/>(digest comprimido)"]
    end

    ICE9 -->|"cook(formula, vars)"| SOLID
    SOLID -->|"pour(proto, context)"| LIQUID
    SOLID -->|"wisp(proto, TTL)"| VAPOR
    LIQUID -->|"squash(digest)"| CONDENSED
    VAPOR -->|"burn(TTL expirou)"| DEAD

    style ICE9 fill:#59c2ff,stroke:#0f1419,color:#0f1419
    style SOLID fill:#d2a6ff,stroke:#0f1419,color:#0f1419
    style LIQUID fill:#c2d94c,stroke:#0f1419,color:#0f1419
    style VAPOR fill:#ffb454,stroke:#0f1419,color:#0f1419
    style DEAD fill:#f07178,stroke:#0f1419,color:#0f1419
    style CONDENSED fill:#95e6cb,stroke:#0f1419,color:#0f1419
```

### Operadores Bond (Álgebra MEOW)

| Operador | De | Pra | O que faz |
|----------|-----|-----|-----------|
| `cook` | ICE9 (TOML) | SOLID | Parseia formula, substitui variáveis, valida DAG |
| `pour` | SOLID | LIQUID | Inicia execução, marca steps prontos, persiste no DB |
| `wisp` | SOLID | VAPOR | Cria instância efêmera com TTL (patrulhas, checks) |
| `squash` | LIQUID | LIQUID | Condensa steps completos num digest resumido |
| `burn` | VAPOR | 💀 | Destrói wisp expirado, mantém só artefatos |
| `compound` | ICE9 + ICE9 | ICE9 | Compõe duas formulas numa formula composta |

### Exemplo concreto:

```
1. Formula "bug-fix" existe como TOML no Git (ICE9)

2. Tu pede: "fix o bug #42"
   → cook("bug-fix", {bug_description: "login quebrado"})
   → Protomolecule criada (SOLID)

3. Sistema inicia execução:
   → pour(proto, {repo: "/app"})
   → Molecule ativa (LIQUID), 6 steps no DAG

4. Step 1 "reproduce" fica ready
   → Polecat executa → marca completed
   → Step 2 "diagnose" fica ready automaticamente
   → ... continua até step 6

5. Todos steps completed → Molecule status = completed
```

---

## 5. GLOSSÁRIO COMPLETO

```mermaid
graph TB
    subgraph "📋 TRABALHO"
        BEAD["🔵 BEAD<br/>Unidade atômica de trabalho<br/>= ticket do Jira<br/>Status: backlog→ready→<br/>in_progress→done"]
        MOLECULE["🧬 MOLECULE<br/>Workflow com etapas<br/>= DAG de steps<br/>Persistido no DB"]
        WISP["💨 WISP<br/>Molecule efêmera<br/>= vive só na memória<br/>Auto-destrói após TTL"]
        CONVOY["🚚 CONVOY<br/>Sprint/batch de beads<br/>= entrega coordenada<br/>Agrupa beads pra delivery"]
        FORMULA["📜 FORMULA<br/>Template TOML de workflow<br/>= DNA do processo<br/>Imutável, versionada"]
    end

    subgraph "⚙️ EXECUÇÃO"
        GUPP["⚡ GUPP HOOK<br/>Fila de trabalho do agente<br/>= 'se tem hook, executa'<br/>Propulsão automática"]
        SKILL["🔧 SKILL<br/>Capacidade registrada<br/>= HOW do step<br/>TOML manifest"]
        RIG["🏗️ RIG<br/>Projeto/repositório<br/>= war rig do Mad Max<br/>Git repo sob gestão"]
    end

    subgraph "👥 WORKERS"
        MAYOR["🎩 MAYOR<br/>Chefe de Staff<br/>Nunca escreve código<br/>Orquestra, delega, resolve"]
        POLECAT["🐾 POLECAT<br/>Worker descartável<br/>Nasce, trabalha, PR, morre<br/>Max 5 simultâneos por rig"]
        CREW["👷 CREW<br/>Worker persistente<br/>Mantém contexto longo<br/>Design, review, arquitetura"]
        DEACON["🐺 DEACON<br/>Daemon Beacon<br/>Vigia saúde do sistema<br/>26 checks a cada 10min"]
        WITNESS["👁️ WITNESS<br/>Supervisor de polecats<br/>Nudge stuck, escala falhas<br/>10 checks a cada 5min"]
        DOG["🐕 DOG<br/>Ajudante do Deacon<br/>Compactor, Doctor,<br/>Janitor, Wisp Reaper"]
        BOOT["🔔 BOOT<br/>Watchdog do Deacon<br/>Vigia o vigilante<br/>Check a cada 5min"]
    end

    subgraph "🏭 INFRAESTRUTURA"
        REFINERY["⚗️ REFINERY<br/>Merge queue manager<br/>Quality gates + push lock<br/>Rebase + conflict detection"]
        GUZZOLINE["⛽ GUZZOLINE<br/>Reservatório de capacidade<br/>Generators (enchem)<br/>Consumers (drenam)"]
        NDI["♾️ NDI<br/>Crash recovery<br/>3 pilares de persistência<br/>Nondeterministic Idempotence"]
        SEANCE["👻 SEANCE<br/>Resurreição de sessão<br/>Consulta sessões anteriores<br/>Contexto entre vidas"]
        MAIL["📬 MAIL<br/>Mensagens entre workers<br/>4 prioridades, broadcast<br/>Bridges: SSE/Slack/WA"]
    end

    BEAD --> MOLECULE
    FORMULA --> MOLECULE
    MOLECULE --> GUPP
    GUPP --> POLECAT
    POLECAT --> REFINERY
    MAYOR --> CONVOY
    CONVOY --> BEAD
    DEACON --> DOG
    DEACON --> WITNESS
    BOOT --> DEACON
```

---

## 6. O FLUXO AUTÔNOMO COMPLETO (The Main Loop)

```mermaid
sequenceDiagram
    participant U as 👤 Tu
    participant GT as 🏭 Gas Town
    participant AL as 🔄 Auto-Loop<br/>(cada 30s)
    participant GUPP as ⚡ GUPP
    participant M as 🖥️ Maestro Client<br/>(teu Mac)
    participant CC as 🤖 Claude Code
    participant RF as ⚗️ Refinery

    U->>GT: POST /api/beads<br/>{title: "fix login bug",<br/>status: "ready"}
    Note over GT: Bead bd-1a2b criada<br/>status = ready

    AL->>GT: scanCycle() — busca beads ready
    GT-->>AL: [bd-1a2b] ready, priority: high

    AL->>GUPP: placeHook("bd-1a2b", skill:"code")
    Note over GUPP: Hook criado<br/>status = pending<br/>Bead → in_progress

    M->>GT: GET /api/meow/gupp/hooks/pending<br/>(poll a cada 10s)
    GT-->>M: [{id: "hook-xyz",<br/>beadId: "bd-1a2b"}]

    M->>GT: POST /hooks/hook-xyz/claim
    Note over GUPP: Hook status → claimed

    M->>CC: claude --print -p "Fix login bug..."
    Note over CC: Claude Code executa:<br/>lê código, encontra bug,<br/>corrige, roda testes

    CC-->>M: Output: "Fixed null check<br/>in auth.ts line 42"

    M->>GT: POST /hooks/hook-xyz/complete<br/>{output: "Fixed..."}
    Note over GUPP: Hook → completed

    Note over GT: Bead bd-1a2b → done<br/>Auto-loop libera slot<br/>Próxima bead ready<br/>entra no ciclo

    Note over AL: 30s depois...<br/>scanCycle() busca<br/>próxima bead ready<br/>Ciclo recomeça ♻️
```

---

## 7. HIERARQUIA DE WORKERS

```mermaid
graph TB
    subgraph "🏛️ GAS TOWN HIERARCHY"
        OVERSEER["👤 OVERSEER<br/>(Humano)<br/>────────────<br/>Autoridade máxima<br/>Aprova gates<br/>Monitor de saúde"]

        MAYOR["🎩 MAYOR<br/>(1 por town)<br/>────────────<br/>Chief of Staff<br/>NUNCA escreve código<br/>Cria convoys<br/>Resolve conflitos<br/>Prioriza recursos"]

        DEACON["🐺 DEACON<br/>(1 por town)<br/>────────────<br/>Daemon Beacon<br/>26 health checks / 10min<br/>Escalação automática"]

        WITNESS["👁️ WITNESS<br/>(1 por rig)<br/>────────────<br/>Supervisor de polecats<br/>10 checks / 5min<br/>Nudge stuck (max 3)"]

        REFINERY["⚗️ REFINERY<br/>(1 por rig)<br/>────────────<br/>Merge queue<br/>4 quality gates<br/>Push serialization"]

        POLECAT["🐾 POLECATS<br/>(N por rig, max 5)<br/>────────────<br/>Efêmeros<br/>Worktree isolado<br/>10 steps: load→impl→<br/>test→review→PR→cleanup"]

        CREW["👷 CREW<br/>(N por rig)<br/>────────────<br/>Persistentes<br/>Contexto longo<br/>Design & review"]

        DOGS["🐕 DOGS<br/>(4 tipos)<br/>────────────<br/>Compactor: GC<br/>Doctor: health<br/>Janitor: cleanup<br/>WispReaper: burn"]

        BOOT["🔔 BOOT<br/>────────────<br/>Watchdog do Deacon<br/>Check a cada 5min<br/>Quem vigia o vigilante?"]
    end

    OVERSEER --> MAYOR
    OVERSEER --> DEACON
    MAYOR --> WITNESS
    MAYOR --> REFINERY
    WITNESS --> POLECAT
    WITNESS --> CREW
    DEACON --> DOGS
    BOOT -.->|"vigia"| DEACON

    style OVERSEER fill:#ffb454,stroke:#0f1419,color:#0f1419
    style MAYOR fill:#d2a6ff,stroke:#0f1419,color:#0f1419
    style DEACON fill:#f07178,stroke:#0f1419,color:#0f1419
    style WITNESS fill:#59c2ff,stroke:#0f1419,color:#0f1419
    style REFINERY fill:#95e6cb,stroke:#0f1419,color:#0f1419
    style POLECAT fill:#c2d94c,stroke:#0f1419,color:#0f1419
    style CREW fill:#c2d94c,stroke:#0f1419,color:#0f1419
    style DOGS fill:#6c7680,stroke:#0f1419,color:#e6e1cf
    style BOOT fill:#ff8f40,stroke:#0f1419,color:#0f1419
```

### Modelo de Tiers (custo/poder)

| Tier | Modelo | Workers | Custo/1M tokens |
|------|--------|---------|-----------------|
| **S** (Opus) | O mais capaz | Mayor, Overseer | $15 input / $75 output |
| **A** (Sonnet) | Balanceado | Polecat, Crew, Refinery, Witness | $3 input / $15 output |
| **B** (Haiku) | Rápido e barato | Deacon, Boot, Dogs | $0.25 input / $1.25 output |

---

## 8. LIFECYCLE DO POLECAT (mol-polecat-work)

```mermaid
graph LR
    subgraph "🐾 Polecat Lifecycle — 10 Steps"
        S1["1. Load Context<br/>Lê bead, entende<br/>requirements"]
        S2["2. Branch Setup<br/>Cria worktree +<br/>branch isolada"]
        S3["3. Implement<br/>Executa a skill<br/>(o trabalho real)"]
        S4["4. Self-Review<br/>Revisa próprio<br/>código"]
        S5["5. Quality Gates<br/>lint + typecheck<br/>+ tests"]
        S6["6. Commit<br/>Stage + commit<br/>changes"]
        S7["7. Pre-Verify<br/>Verificação final<br/>antes do PR"]
        S8["8. Submit PR<br/>Cria pull request"]
        S9["9. Await Verdict<br/>Espera CI + review<br/>humano"]
        S10["10. Cleanup<br/>Remove worktree<br/>Libera polecat"]
    end

    S1 --> S2 --> S3 --> S4 --> S5 --> S6 --> S7 --> S8 --> S9 --> S10

    style S3 fill:#c2d94c,stroke:#0f1419,color:#0f1419,stroke-width:3px
    style S8 fill:#59c2ff,stroke:#0f1419,color:#0f1419
    style S9 fill:#ffb454,stroke:#0f1419,color:#0f1419
```

O polecat **nasce, faz tudo isso, entrega o PR, e morre**. Se crashar no step 5, o próximo polecat olha a molecule, vê que steps 1-4 estão completos, e continua do 5.

---

## 9. NDI — CRASH RECOVERY (Nondeterministic Idempotence)

```mermaid
graph TB
    subgraph "♾️ 3 Pilares de Persistência"
        P1["🔵 Pilar 1: Agent Bead<br/>────────────<br/>QUEM está fazendo<br/>Identidade + assignment<br/>Tabela: meow_workers"]
        P2["⚡ Pilar 2: Hook Bead<br/>────────────<br/>QUE trabalho está<br/>vinculado a quem<br/>Tabela: meow_hooks"]
        P3["🧬 Pilar 3: Molecule Chain<br/>────────────<br/>ONDE no workflow<br/>Estado de execução<br/>Tabela: molecules"]
    end

    CRASH["💥 CRASH!<br/>Sessão morre"]
    RECOVER["🔄 RECOVERY<br/>Nova sessão<br/>inicia"]

    CRASH --> RECOVER
    RECOVER --> P1
    RECOVER --> P2
    RECOVER --> P3

    P1 -->|"sabe quem era"| CONTINUE["✅ Continua<br/>de onde parou"]
    P2 -->|"sabe o que fazia"| CONTINUE
    P3 -->|"sabe em qual step"| CONTINUE

    style CRASH fill:#f07178,stroke:#0f1419,color:#0f1419
    style RECOVER fill:#c2d94c,stroke:#0f1419,color:#0f1419
    style CONTINUE fill:#95e6cb,stroke:#0f1419,color:#0f1419
```

**Se QUALQUER pilar sobrevive, o trabalho pode ser recuperado.**

| Estado | Pilares | Ação |
|--------|---------|------|
| HEALTHY | 3/3 intactos | Continua normalmente |
| DEGRADED | 1 pilar perdido | Recupera do que resta |
| CRITICAL | 2+ pilares perdidos | Deacon escala pro Mayor |

---

## 10. O GUPP — PROPULSÃO UNIVERSAL

```mermaid
graph TB
    subgraph "⚡ GUPP — Gas Town Universal Propulsion Principle"
        SCAN["🔍 GUPP Scan<br/>(cada 15s)"]
        PENDING["📋 Hooks Pending"]
        CLAIM["🤚 Worker Claims"]
        EXEC["🚀 Executa"]
        COMPLETE["✅ Complete"]
        FAIL["❌ Fail"]
        RETRY["🔄 Retry<br/>(até 3x)"]
        EXPIRE["⏰ Expired<br/>(TTL 1h)"]
        ESCALATE["🚨 Escalate<br/>→ Mayor"]
    end

    SCAN --> PENDING
    PENDING --> CLAIM
    CLAIM --> EXEC
    EXEC --> COMPLETE
    EXEC --> FAIL
    FAIL -->|"retryCount < 3"| RETRY
    RETRY --> PENDING
    FAIL -->|"retries esgotados"| ESCALATE
    PENDING -->|"TTL expirou"| EXPIRE
    EXPIRE --> ESCALATE

    subgraph "🛡️ Backpressure"
        BP["Max 100 hooks pending<br/>Warning em 80%<br/>Backoff exponencial"]
    end

    subgraph "📊 Priority Buckets"
        PB["critical: max 10 concurrent<br/>high: max 8<br/>normal: max 5<br/>low: max 3"]
    end

    style SCAN fill:#59c2ff,stroke:#0f1419,color:#0f1419
    style COMPLETE fill:#c2d94c,stroke:#0f1419,color:#0f1419
    style FAIL fill:#f07178,stroke:#0f1419,color:#0f1419
    style ESCALATE fill:#ffb454,stroke:#0f1419,color:#0f1419
```

---

## 11. REFINERY — MERGE QUEUE

```mermaid
graph LR
    subgraph "⚗️ Refinery Pipeline"
        ENQUEUE["📥 Enqueue<br/>PR entra na fila"]
        GATE1["🔍 Gate 1<br/>TypeCheck<br/>(tsc --noEmit)"]
        GATE2["🧹 Gate 2<br/>Lint<br/>(eslint)"]
        GATE3["🧪 Gate 3<br/>Test<br/>(jest/vitest)"]
        GATE4["🏗️ Gate 4<br/>Build<br/>(npm run build)"]
        REBASE["🔀 Rebase<br/>contra main"]
        CONFLICT["⚠️ Conflict?"]
        MERGE["✅ Merge<br/>Push to main"]
        CLEANUP["🧹 Cleanup<br/>Delete branch<br/>Update bead<br/>Notify convoy"]
    end

    ENQUEUE --> GATE1 --> GATE2 --> GATE3 --> GATE4
    GATE4 --> REBASE
    REBASE --> CONFLICT
    CONFLICT -->|"não"| MERGE
    CONFLICT -->|"sim"| RESOLVE["🔧 Resolve"]
    RESOLVE --> GATE1
    MERGE --> CLEANUP

    style MERGE fill:#c2d94c,stroke:#0f1419,color:#0f1419
    style CONFLICT fill:#ffb454,stroke:#0f1419,color:#0f1419
```

**Push Lock**: só 1 item pode pushar por vez. Isso serializa merges e previne race conditions.

---

## 12. SISTEMA DE PATRULHAS (Health Monitoring)

```mermaid
graph TB
    subgraph "🛡️ 3 Níveis de Patrulha — 45 checks total"
        D["🐺 DEACON PATROL<br/>26 checks / 10 min<br/>────────────<br/>Dogs alive?<br/>Workers healthy?<br/>Molecules stuck?<br/>Queue depth ok?<br/>Memory usage?<br/>Mail delivery?<br/>Convoy progress?<br/>Wisp counts?<br/>Hook status?<br/>Budget remaining?<br/>Error rates?<br/>Uptime metrics?"]

        W["👁️ WITNESS PATROL<br/>10 checks / 5 min<br/>────────────<br/>Polecats supervised?<br/>Assignments tracked?<br/>Skills available?<br/>Gates passing?<br/>Escalation queue?<br/>Heartbeats fresh?"]

        R["⚗️ REFINERY PATROL<br/>9 checks / cycle<br/>────────────<br/>Queue depth?<br/>Gate failures?<br/>Conflicts pending?<br/>Push lock stuck?<br/>Stale items?<br/>Merge rate ok?<br/>Rebase needed?<br/>Blocked items?<br/>Throughput?"]
    end

    D -->|"problema detectado"| ESCALATE["🚨 Escala pro Mayor"]
    W -->|"polecat stuck 3x"| ESCALATE
    R -->|"gate failing"| ESCALATE

    subgraph "📈 Backoff Inteligente"
        PASS["✅ Tudo OK<br/>Intervalo dobra<br/>(exponential backoff)"]
        FAIL2["❌ Falha detectada<br/>Intervalo reseta<br/>(resposta rápida)"]
    end

    style D fill:#f07178,stroke:#0f1419,color:#0f1419
    style W fill:#59c2ff,stroke:#0f1419,color:#0f1419
    style R fill:#95e6cb,stroke:#0f1419,color:#0f1419
```

---

## 13. GUZZOLINE — RESERVATÓRIO DE CAPACIDADE

```mermaid
graph TB
    subgraph "⛽ Guzzoline Gauge (0-100%)"
        GENERATORS["📈 GENERATORS<br/>(enchem o tanque)<br/>────────────<br/>Bead creation<br/>Budget top-up<br/>Slot release<br/>Quota reset"]

        TANK["⛽ TANQUE<br/>Level: 0-100%<br/>Burn rate: X/hora<br/>Fill rate: Y/hora<br/>Hours remaining: Z"]

        CONSUMERS["📉 CONSUMERS<br/>(drenam o tanque)<br/>────────────<br/>Polecat work<br/>API calls<br/>Merge ops<br/>Patrol runs"]
    end

    GENERATORS -->|"fill"| TANK
    TANK -->|"drain"| CONSUMERS

    TANK -->|"< 20%"| ALERT["🚨 LOW FUEL ALERT<br/>SSE broadcast<br/>Pausa auto-loop"]

    style TANK fill:#ffb454,stroke:#0f1419,color:#0f1419,stroke-width:3px
    style ALERT fill:#f07178,stroke:#0f1419,color:#0f1419
    style GENERATORS fill:#c2d94c,stroke:#0f1419,color:#0f1419
    style CONSUMERS fill:#59c2ff,stroke:#0f1419,color:#0f1419
```

---

## 14. MAIL — COMUNICAÇÃO ENTRE WORKERS

```mermaid
graph LR
    subgraph "📬 Mail System"
        SEND["📤 Sender<br/>(qualquer worker)"]
        ROUTER["📮 Mail Router<br/>────────────<br/>4 prioridades:<br/>critical/high/normal/low<br/><br/>5 tipos:<br/>task/escalation/<br/>notification/report/nudge<br/><br/>2 modos:<br/>direct / broadcast"]
        INBOX["📥 Inbox<br/>(max 500 msgs)"]
    end

    SEND --> ROUTER
    ROUTER -->|"direct"| INBOX
    ROUTER -->|"broadcast"| ROLE["📢 Todos do role"]

    subgraph "🌉 Bridges (saída externa)"
        SSE["SSE Stream"]
        SLACK["Slack"]
        EMAIL["Email"]
        WA["WhatsApp"]
    end

    ROUTER -->|"critical"| SSE
    ROUTER -->|"critical"| WA

    style ROUTER fill:#d2a6ff,stroke:#0f1419,color:#0f1419
```

---

## 15. FORMULA — DNA DO WORKFLOW

```mermaid
graph TB
    subgraph "📜 Formula TOML → Molecule DAG"
        TOML["feature-build.formula.toml<br/>────────────<br/>[formula]<br/>name = 'feature-build'<br/>version = 1<br/>type = 'workflow'<br/><br/>[vars.feature_description]<br/>required = true<br/><br/>[[steps]]<br/>id = 'load-context'<br/>skill = 'code'<br/>needs = []<br/>timeout = 120"]

        DAG["DAG Executável<br/>(após cook + pour)"]

        S1["load-context"]
        S2["implement"]
        S3["write-tests"]
        S4["run-quality"]
        S5["self-review"]
        S6["submit-pr"]
    end

    TOML -->|"cook() + pour()"| DAG
    DAG --> S1
    S1 --> S2
    S2 --> S3
    S3 --> S4
    S4 --> S5
    S5 --> S6

    subgraph "💎 Diamond DAG (pr-review)"
        PR1["fetch-pr"]
        PR2["analyze-changes"]
        PR3["check-tests"]
        PR4["compose-review"]
        PR5["submit-review"]

        PR1 --> PR2
        PR1 --> PR3
        PR2 --> PR4
        PR3 --> PR4
        PR4 --> PR5
    end

    style TOML fill:#1a1f26,stroke:#95e6cb,color:#e6e1cf
    style S1 fill:#c2d94c,stroke:#0f1419,color:#0f1419
    style S6 fill:#59c2ff,stroke:#0f1419,color:#0f1419
    style PR2 fill:#c2d94c,stroke:#0f1419,color:#0f1419
    style PR3 fill:#c2d94c,stroke:#0f1419,color:#0f1419
```

**Diamond DAG**: Steps 2 e 3 rodam em paralelo (ambos dependem só do step 1). Step 4 espera os dois terminarem.

---

## 16. FRANKFLOW — QUALITY GATES

```mermaid
graph TB
    subgraph "🔍 FrankFlow — 8 Módulos"
        CP["📋 Checkpoint<br/>JSONL append-only<br/>Resumable execution"]
        OR["🔎 Orphan Detector<br/>Detecta workers mortos<br/>PID probing + heartbeat"]
        RT["🔄 Retry Manager<br/>Backoff exponencial<br/>Classifica: transient vs permanent"]
        SR["🧭 Smart Router<br/>13 categorias<br/>debug/security/feature/etc"]
        PL["🧠 Pattern Learner<br/>Memória de erros<br/>MD5 normalização"]
        QG["✅ Quality Gates<br/>7 tech stacks<br/>npm/python/go/rust/ruby/java/elixir"]
        RP["👀 Review Pipeline<br/>4 reviewers paralelos<br/>Max 2 auto-fix rounds"]
        SS["📐 Spec Sync<br/>Spec → Beads<br/>Dependency DAG"]
    end

    style CP fill:#59c2ff,stroke:#0f1419,color:#0f1419
    style QG fill:#c2d94c,stroke:#0f1419,color:#0f1419
    style RP fill:#d2a6ff,stroke:#0f1419,color:#0f1419
```

---

## 17. MAESTRO BRIDGE — EXECUÇÃO LOCAL

```mermaid
sequenceDiagram
    participant MC as 🖥️ Maestro Client<br/>(teu Mac)
    participant GT as 🏭 Gas Town<br/>(Railway)
    participant GUPP as ⚡ GUPP

    loop Poll cada 10s
        MC->>GT: GET /hooks/pending
        GT-->>MC: [{id, beadId, skill}]
    end

    MC->>GT: POST /hooks/:id/claim<br/>{workerId: "maestro-mac"}
    Note over GUPP: Hook → claimed

    MC->>MC: spawn claude --print<br/>--dangerously-skip-permissions<br/>-p "Task: ..."

    Note over MC: Claude Code executa...<br/>(pode levar minutos)

    alt Sucesso
        MC->>GT: POST /hooks/:id/complete
        Note over GT: Bead → done ✅
    else Falha
        MC->>GT: POST /hooks/:id/fail<br/>{error: "..."}
        Note over GUPP: Retry ou escalate
    end
```

---

## 18. SOVEREIGN SUBSYSTEMS (27 Módulos Avançados)

```mermaid
graph TB
    subgraph "🏛️ 27 Sovereign Modules"
        subgraph "Core (5)"
            CLI["⌨️ GT CLI<br/>15 comandos"]
            CMDS["📋 Commands"]
            GUZ["⛽ Guzzoline+NDI"]
            MALL["🏪 Mol Mall<br/>Marketplace"]
            PLUGIN["🔌 Extensions"]
        end

        subgraph "Operations (7)"
            CHAOS["💥 Chaos Eng<br/>Fault injection"]
            CRISIS["🚨 Crisis Mode"]
            CIRCADIAN["🌅 Circadian<br/>Daily rhythms"]
            DEGRADE["📉 Graceful<br/>Degradation"]
            MAINT["🔧 Maintenance"]
            SNAPSHOT["📸 State<br/>Snapshot"]
            SCHED["📅 Self-<br/>Scheduling"]
        end

        subgraph "Advanced (15)"
            API_GW["🌐 API Gateway"]
            ATLAS["🗺️ Atlas Advisor"]
            REPORTS["📊 Auto Reports"]
            CHRONICLE["📜 Chronicle"]
            JOURNAL["📓 Decision<br/>Journal"]
            COUNCIL["🏛️ Entity<br/>Council"]
            GENESIS["🧬 Formula<br/>Genesis"]
            MARKET["🏪 Formula<br/>Marketplace"]
            NOUS["🧠 Nous Oracle"]
            REPUTATION["⭐ Reputation"]
            EVOLUTION["📈 Skill<br/>Evolution"]
            WEBHOOKS["🔔 Webhooks"]
            MEMORY["💾 Worker<br/>Memory"]
            SPECIAL["🎯 Worker<br/>Specialization"]
            FAILOVER["🌍 Cross-Region<br/>Failover"]
        end
    end

    style CHAOS fill:#f07178,stroke:#0f1419,color:#0f1419
    style NOUS fill:#d2a6ff,stroke:#0f1419,color:#0f1419
    style CLI fill:#c2d94c,stroke:#0f1419,color:#0f1419
```

**Chaos Engineering**: "Bota fogo na war rig de propósito — pra quando pegar fogo de verdade, tu já sabe o que fazer."

---

## 19. GAS TOWN vs OUTROS FRAMEWORKS

```mermaid
graph TB
    subgraph "🔄 CrewAI / AutoGen / LangGraph"
        SEQ["Sequencial<br/>PM → Architect → Dev → QA"]
        MEM["Estado in-memory<br/>Sessão morre = perde tudo"]
        PERS["Personas especializadas<br/>Simulam org chart"]
        CHAIN["Prompt chaining<br/>Output A → Input B"]
    end

    subgraph "🏭 Gas Town"
        PAR["Paralelo<br/>20-30 agentes simultâneos"]
        GIT["Estado no Git + DB<br/>Crash = continua de onde parou"]
        DISP["Workers descartáveis<br/>Cattle, not pets"]
        WORK["Worktrees + hooks<br/>Isolamento real via Git"]
    end

    style SEQ fill:#2d363f,stroke:#6c7680,color:#e6e1cf
    style MEM fill:#2d363f,stroke:#6c7680,color:#e6e1cf
    style PAR fill:#c2d94c,stroke:#0f1419,color:#0f1419
    style GIT fill:#c2d94c,stroke:#0f1419,color:#0f1419
```

| Aspecto | CrewAI/AutoGen | Gas Town |
|---------|----------------|----------|
| Execução | Sequencial, 1 por vez | Paralelo, 20-30 simultâneos |
| Estado | In-memory | Git + PostgreSQL |
| Crash | Perde tudo | NDI: continua de onde parou |
| Workers | Personas fixas | Descartáveis (polecats) |
| Coordenação | Prompt chaining | GUPP hooks + mail + patrols |
| Merge | Manual | Refinery automática com gates |
| Custo | Baixo ($10-50/mês) | Alto ($2,000-5,000/mês) |

---

## 20. NÚMEROS DO SISTEMA (gastown-wl)

| Métrica | Quantidade |
|---------|------------|
| Backend LOC | ~98,000 |
| Frontend LOC | ~22,000 |
| Worker Roles | 9 |
| Cognitive AI Modules | 32 |
| Sovereign Systems | 27 |
| Formula Templates | 14 |
| FrankFlow Modules | 8 |
| Patrol Checks | 45 (26+10+9) |
| API Endpoints | ~280 |
| Frontend Views | 42 |
| GT CLI Commands | 15 |

---

## 21. RESUMO EM UMA IMAGEM

```mermaid
graph TB
    YOU["👤 TU<br/>Cria beads"]
    YOU --> BEADS["📋 BEADS<br/>(tarefas)"]
    BEADS --> AUTOLOOP["🔄 AUTO-LOOP<br/>(scan cada 30s)"]
    AUTOLOOP --> GUPP["⚡ GUPP<br/>(fila de hooks)"]
    GUPP --> MAESTRO["🖥️ MAESTRO<br/>(teu Mac)"]
    MAESTRO --> CLAUDE["🤖 CLAUDE CODE<br/>(executa)"]
    CLAUDE --> RESULT["📦 RESULTADO<br/>(código + PR)"]
    RESULT --> REFINERY["⚗️ REFINERY<br/>(quality gates)"]
    REFINERY --> MERGE["✅ MERGED<br/>(em main)"]

    DEACON["🐺 DEACON<br/>(vigia tudo)"] -.->|"health checks"| AUTOLOOP
    DEACON -.->|"health checks"| GUPP
    DEACON -.->|"health checks"| REFINERY
    MAYOR["🎩 MAYOR<br/>(orquestra)"] -.->|"prioriza"| AUTOLOOP
    MAYOR -.->|"resolve conflitos"| REFINERY

    style YOU fill:#ffb454,stroke:#0f1419,color:#0f1419,stroke-width:3px
    style MERGE fill:#c2d94c,stroke:#0f1419,color:#0f1419,stroke-width:3px
    style CLAUDE fill:#59c2ff,stroke:#0f1419,color:#0f1419
    style GUPP fill:#d2a6ff,stroke:#0f1419,color:#0f1419
```

**Tu cria a tarefa. Gas Town faz TODO o resto.**

---

> Fontes: [GitHub steveyegge/gastown](https://github.com/steveyegge/gastown) · [Welcome to Gas Town (Medium)](https://steve-yegge.medium.com/welcome-to-gas-town-4f25ee16dd04) · [Gas Town Emergency User Manual](https://steve-yegge.medium.com/gas-town-emergency-user-manual-cf0e4556d74b) · [The Future of Coding Agents](https://steve-yegge.medium.com/the-future-of-coding-agents-e9451a84207c) · [Welcome to the Wasteland](https://steve-yegge.medium.com/welcome-to-the-wasteland-a-thousand-gas-towns-a5eb9bc8dc1f) · [Maggie Appleton - Gas Town Patterns](https://maggieappleton.com/gastown) · [Steve Klabnik - How to Think About Gas Town](https://steveklabnik.com/writing/how-to-think-about-gas-town/) · [DeepWiki - steveyegge/gastown](https://deepwiki.com/steveyegge/gastown) · Codebase local `~/gastown-wl`
