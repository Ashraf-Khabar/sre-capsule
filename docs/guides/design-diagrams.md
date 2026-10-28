---
icon: material/vector-polyline
---

# Design Schemas & Diagrams

Reference architecture for **SRE Capsule**. Diagrams use [Mermaid](https://mermaid.js.org/). On this site they render with the themed, animated style in `docs/javascripts/mermaid-theme.js` (rounded flow, accent edges, a slow dash on the links). GitHub renders the same source as plain Mermaid, without that animation. Respect **Reduce motion** in the operating system and the animation stops.

Related narrative: [System Architecture](architecture.md) · [Platform User Guide](platform-user-guide.md)

---

## 1. System context (C4 Level 1)

Who interacts with the system and which external systems are called.

```mermaid
flowchart TB
    subgraph actors [Actors]
        SRE[SRE / QA Engineer]
        MGR[Engineering Manager]
        CI[CI/CD Pipeline]
    end

    QC[(SRE Capsule Control Plane)]

    subgraph external [External systems]
        SLACK[Slack / Teams]
        JIRA[Jira]
        PD[PagerDuty / Opsgenie]
        PROM[Prometheus Alertmanager]
    end

    SRE -->|HTTPS JWT| QC
    MGR -->|HTTPS JWT| QC
    CI -->|HTTPS X-API-Key| QC
    QC --> SLACK & JIRA & PD
    PROM -->|webhook| QC
```

---

## 2. Containers (C4 Level 2)

Logical containers inside a single SRE Capsule process (Docker or bare metal).

```mermaid
flowchart TB
    USER[Browser / CI client]

    subgraph process [SRE Capsule process :9000]
        WEB[Static Web UI<br/>Vanilla JS + Drawflow]
        API[HTTP API<br/>pkg/api/server]
        CORE[Domain core<br/>pkg/core]
        INT[Integration engine<br/>pkg/integrations]
        HEAL[Self-Healing<br/>pkg/healing]
        QN[Quarantine<br/>pkg/quarantine]
    end

    subgraph persist [Persistence]
        DB[(SQLite)]
        FS[(plugins + artifacts)]
    end

    USER --> WEB & API
    WEB -->|fetch JWT| API
    API --> CORE
    CORE --> DB
    CORE --> INT & HEAL & QN
    INT --> FS
    API --> FS
```

---

## 3. Component diagram — Go packages

```mermaid
flowchart TB
    subgraph entry [Entry]
        MAIN[cmd/srecapsule/main.go]
    end

    subgraph api [pkg/api/server]
        SRV[server.go routes]
        WH[webhook_handlers]
        INC[incident_handlers]
        WF[workflow_handlers]
        INTEL[intelligence_handlers]
        DORA_H[dora_handlers]
        RB[runbooks_handlers]
        SYS[system_handlers]
    end

    subgraph core [pkg/core]
        ING[ingest.go]
        REM[remediation.go]
        PW[project_workflow.go]
        PR[project_routing.go]
        DORA_C[dora.go]
        RBAC[rbac.go]
        SA[superapp.go]
        DBM[db.go migrations]
    end

    subgraph int [pkg/integrations]
        REG[registry.go]
        ENG[engine.go]
        WFE[workflow_engine.go]
        RBK[runbooks.go]
        COND[workflow.go conditions]
    end

    subgraph super [Super-App]
        HEAL_PKG[pkg/healing]
        Q_PKG[pkg/quarantine]
    end

    MAIN --> SRV
    SRV --> WH & INC & WF & INTEL & DORA_H & RB & SYS
    WH --> ING
    ING --> REM & SA
    REM --> ENG & WFE
    WF --> WFE
    SA --> HEAL_PKG & Q_PKG
    ENG --> REG
    WFE --> ENG
```

---

## 4. Deployment diagram

Typical **Docker Compose** or bare-metal deployment.

```mermaid
flowchart LR
    subgraph host [Host / VM / K8s pod]
        subgraph container [sre-capsule container]
            GO[Go binary :9000]
            WEB[./web static]
        end
    end

    subgraph volume [Persistent volumes]
        SQLITE[(srecapsule.db)]
        ARTIFACTS[(data/artifacts)]
        CONFIG[(config.yaml)]
        PLUGINS[(plugins/)]
    end

    BROWSER[Browser] -->|9000| GO
    CICD[CI runner] -->|9000 webhooks| GO
    GO --> SQLITE
    GO --> ARTIFACTS
    GO --> CONFIG
    GO --> PLUGINS
    GO --> WEB
```

| Port / path | Purpose |
|-------------|---------|
| `:9000` | HTTP — UI + API |
| `./data/srecapsule.db` | SQLite (mount for persistence) |
| `./config.yaml` | Server, SMTP, security, plugins dir |
| `./plugins/` | Integration manifests (optional bind-mount) |
| `./data/artifacts/` | Uploaded traces/screenshots |

---

## 5. Entity-relationship — core data model

```mermaid
erDiagram
    projects ||--o{ incidents : "has"
    projects ||--o| pipeline_runs : "records"
    projects {
        string id PK
        string name
        string api_key
        string sre_routing_json
        string sre_workflow_json
        int team_id FK
    }

    incidents {
        int id PK
        string project_name FK
        string name
        string status
        string fingerprint
        string pipeline_run_id
        bool is_resolved
    }

    pipeline_runs {
        string project_name FK
        string pipeline_run_id
        string commit_sha
        string branch
        string outcome
    }

    projects ||--o{ test_quarantine_entries : "deny-list"
    test_quarantine_entries {
        int id PK
        string project_name
        string test_identity_fingerprint
        bool is_active
    }

    incidents ||--o| ai_analysis_jobs : "optional"
    incidents ||--o| incident_rca_reports : "optional"
    ai_analysis_jobs {
        int incident_id FK
        string status
        string provider
    }

    external_signals ||--o{ external_signal_correlations : ""
    incidents ||--o{ external_signal_correlations : ""
```

---

## 6. Sequence — Webhook ingest (full path)

```mermaid
sequenceDiagram
    autonumber
    participant CI as CI pipeline
    participant WH as webhook_handlers
    participant DB as SQLite
    participant PA as ProcessAlert
    participant Q as Quarantine gate
    participant REM as EvaluateAlertRules
    participant HOOK as PostIncidentHooks
    participant HEAL as HealingService
    participant QE as QuarantineEngine

    CI->>WH: POST /api/webhooks/ + X-API-Key
    WH->>DB: SELECT project by api_key
    WH->>WH: Parse JSON / JUnit batch
    loop Each alert
        WH->>PA: ProcessAlert
        PA->>Q: IsTestQuarantined?
        alt Quarantined
            Q-->>PA: skip ingest
            PA->>QE: RecordTransition async
        else Not quarantined
            PA->>DB: COUNT dedup fingerprint+run
            PA->>DB: Flaky / PERF checks
            PA->>DB: INSERT incidents
            PA->>REM: async remediation
            PA->>HOOK: async
            Note over HOOK: no auto-RCA enqueue
            HOOK->>QE: RecordTransition
        end
    end
    WH->>DB: RecordPipelineRun
    WH-->>CI: 202 + incident_ids + quarantined_skipped
```

---

## 7. Sequence — Remediation mode selection

```mermaid
sequenceDiagram
    participant PA as ProcessAlert
    participant REM as EvaluateAlertRules
    participant DB as SQLite
    participant LEG as Engine.EvaluateAlertRules
    participant WFE as WorkflowEngine

    PA->>REM: EvaluateAlertRules(project, alert, allowed)
    REM->>DB: Load sre_workflow_json by project name
    alt Workflow enabled + valid DAG
        REM->>WFE: Execute(ctx, doc, wctx) async
        Note over WFE: walk trigger → condition → action
    else Legacy
        REM->>LEG: keyword AUTO-RUN async
        Note over LEG: foreach manifest auto_run + trigger_on
    end
```

---

## 8. Activity — WorkflowEngine branch walk

```mermaid
flowchart TD
    START([Enter node_id]) --> CTX{ctx cancelled?}
    CTX -->|yes| END([Stop branch])
    CTX -->|no| CY{Already visited?}
    CY -->|yes| END
    CY -->|no| MARK[Mark visited]
    MARK --> TYPE{Node type?}

    TYPE -->|trigger| OUT0[Follow all outgoing edges]
    OUT0 --> START

    TYPE -->|condition| EVAL[EvaluateCondition when]
    EVAL --> BR{result true?}
    BR -->|yes| OUT1[Follow edges when=true]
    BR -->|no| OUT2[Follow edges when=false]
    OUT1 --> START
    OUT2 --> START

    TYPE -->|action| ALLOW{Allowed on gateway?}
    ALLOW -->|no| SKIP[Log skip reason]
    ALLOW -->|yes| RUN[runManifest plugin]
    SKIP --> OUT3[Follow all outgoing edges]
    RUN --> OUT3
    OUT3 --> START
```

---

## 9. State — Gateway workflow modes

```mermaid
stateDiagram-v2
    [*] --> Legacy: No sre_workflow_json

    Legacy --> Draft: Save DAG enabled=false
    Legacy --> Active: Save DAG enabled=true

    Draft --> Active: Enable + Save
    Active --> Draft: Disable + Save

    Draft --> Legacy: Reset workflow
    Active --> Legacy: Reset workflow

    state Legacy {
        [*] --> LinearAutoRun
        LinearAutoRun: Engine.EvaluateAlertRules
    }

    state Active {
        [*] --> DAGEngine
        DAGEngine: WorkflowEngine.Execute
    }
```

---

## 10. State — Incident lifecycle (UI)

```mermaid
stateDiagram-v2
    [*] --> Active: Webhook ingest failure

    Active --> Resolved: User/API PUT resolve
    Resolved --> Active: Re-failure ingest

    Active --> Deleted: Manager delete
    Resolved --> Deleted: Manager delete
    Deleted --> [*]

    note right of Active
        May be tagged [FLAKY] or [PERF]
        RCA job may run async
    end note

    note right of Resolved
        Flaky re-fail within 48h
        → new incident with [FLAKY]
    end note
```

---

## 11. Sequence — Self-healing MCP flow

```mermaid
sequenceDiagram
    participant AG as MCP Agent
    participant API as /mcp
    participant HEAL as HealingService
    participant DB as SQLite
    participant GH as GitHub API

    AG->>API: tools/call list_failed_incidents
    API->>HEAL: ListInsights
    HEAL->>DB: SELECT open incidents
    AG->>API: tools/call propose_healing
    API->>HEAL: BuildContext + ProposeFix
    AG->>API: tools/call submit_healing_patch
    API->>DB: INSERT healing_patch_submissions
    AG->>API: tools/call create_remediation_pr
    API->>GH: CreateRemediationPR
    API->>DB: UPDATE healing_patch_submissions (pr_created)
    AG->>API: tools/call resolve_incident
    API->>DB: UPDATE incidents SET resolved
```

---

## 12. Sequence — Quarantine at ingest

```mermaid
sequenceDiagram
    participant PA as ProcessAlert
    participant QG as IsTestQuarantined
    participant DB as test_quarantine_entries
    participant QE as QuarantineEngine

    PA->>QG: project + testName
    QG->>DB: ActiveEntry?
    alt is_active = 1
        QG-->>PA: true
        PA-->>PA: return Skipped Quarantined
        PA->>QE: RecordTransition async only
    else not quarantined
        QG-->>PA: false
        Note over PA: normal insert + remediation
    end
```

---

## 13. RBAC — Role vs capability matrix

```mermaid
flowchart LR
    subgraph roles [Roles]
        ADM[admin]
        MGR[manager]
        LED[lead]
        OBS[observer]
    end

    subgraph caps [Capabilities]
        IAM[IAM / Settings]
        FIN[FinOps / DORA]
        GW[Gateways CRUD]
        WF[Workflow edit]
        PLG[Plugins config]
        TRI[Resolve incidents]
        DEL[Delete incidents]
        RCA_R[RCA read]
        Q_R[Quarantine read]
        Q_W[Quarantine write]
    end

    ADM --> IAM & GW
    MGR --> FIN & GW & PLG & TRI & DEL & WF & Q_W
    LED --> GW & PLG & TRI & WF & Q_W & RCA_R
    OBS --> TRI & RCA_R & Q_R
```

| Capability | admin | manager | lead | observer |
|------------|:-----:|:-------:|:----:|:--------:|
| Operations dashboard | ✓ | ✓ | ✓ | read |
| Resolve incidents | ✓ | ✓ | ✓ | — |
| Delete incidents | ✓ | ✓ | — | — |
| CI/CD Gateways | ✓ | ✓ | ✓ | — |
| Workflow editor | ✓ | ✓ | ✓ | read |
| Plugin Engine | ✓ | ✓ | ✓ | — |
| FinOps | — | ✓ | — | — |
| DORA | — | ✓ | — | — |
| RCA insights | ✓ | ✓ | ✓ | read |
| Quarantine manage | ✓ | ✓ | ✓ | — |
| AI config | ✓ | ✓ | — | — |
| IAM / Teams | ✓ | partial | — | — |

---

## 14. Frontend — module architecture

```mermaid
flowchart TB
    HTML[index.html views]
    APP[app.js bootstrap]

    HTML --> APP
    APP --> API[api.js]
    APP --> UI[ui.js]
    APP --> ROLES[roles.js]

    APP --> IAM[iam.js]
    APP --> SET[settings.js]
    APP --> WF[workflow-editor.js]
    APP --> RCA[rca.js]
    APP --> QUAR[quarantine.js]
    APP --> RB[runbooks.js]
    APP --> DORA[dora.js]
    APP --> FIN[finops.js]
    APP --> ABOUT[about.js Help Center]

    WF --> DRAW[Drawflow CDN]
    WF --> API
    SET --> WF
```

---

## 15. Plugin registry — load and execute

```mermaid
flowchart LR
    subgraph disk [plugins/]
        M1[slack/slack-notifier.json]
        M2[jira/jira-ticket.json]
        M3[...]
    end

    subgraph startup [Startup]
        LOAD[LoadRegistry]
        ENG[NewEngine]
    end

    subgraph runtime [Runtime]
        AR[AUTO-RUN scan]
        WF[Workflow action]
        MAN[Manual /api/plugins/run]
    end

    M1 & M2 & M3 --> LOAD --> ENG
    ENG --> AR & WF & MAN
    AR --> HTTP[Outbound HTTPS]
    WF --> HTTP
    MAN --> HTTP
```

---

## 16. DORA & Prometheus — data flow

```mermaid
flowchart TB
    WH[Webhook batch] --> PR[pipeline_runs table]
    WH --> INC[incidents table]
    PR --> DORA[ComputeDORAMetrics]
    INC --> DORA

    PROM[POST /api/webhooks/prometheus] --> SIG[external_signals]
    SIG --> CORR[external_signal_correlations]
    INC --> CORR

    DORA --> UI_DORA[DORA dashboard Manager]
```

---

## 17. Visual workflow — canonical JSON vs Drawflow UI

```mermaid
flowchart LR
    subgraph ui [Browser]
        DF[Drawflow canvas]
        EXP[export / import]
    end

    subgraph canonical [sre_workflow_json]
        NODES[nodes map]
        EDGES[edges array]
        ENTRY[entry id]
        EN[enabled flag]
        UI_SNAP[ui: drawflow snapshot]
    end

    subgraph server [Go]
        VAL[ValidateWorkflow]
        SIM[PlanExecution dry-run]
        EXEC[Execute runtime]
    end

    DF <--> EXP
    EXP -->|save PUT| canonical
    canonical --> VAL
    canonical --> SIM
    canonical --> EXEC
```

---

## 18. Runbook apply flow

```mermaid
sequenceDiagram
    participant U as Lead user
    participant API as POST /api/runbooks/apply
    participant RB as runbooks.go templates
    participant VAL as ValidateWorkflow
    participant DB as projects.sre_workflow_json

    U->>API: project_id + template_id
    API->>RB: Load template DAG
    API->>VAL: Validate paths vs registry
    API->>DB: Save + enabled=true
    API-->>U: 200 OK
    Note over DB: WorkflowEngine takes over remediation
```

---

## Diagram index

| # | Diagram | Use when |
|---|---------|----------|
| 1 | C4 Context | Stakeholder presentations |
| 2 | C4 Containers | Onboarding / ops |
| 3 | Go components | Contributing code |
| 4 | Deployment | Docker / K8s planning |
| 5 | ER model | SQL / reporting |
| 6 | Ingest sequence | Debugging webhooks |
| 7 | Remediation selection | Workflow vs legacy |
| 8 | Workflow walk | DAG behavior |
| 9–10 | State machines | Gateway + incident |
| 11–12 | Healing MCP / Quarantine | Super-App hooks |
| 13 | RBAC | Access design |
| 14 | Frontend modules | UI changes |
| 15 | Plugins | Integration authors |
| 16 | DORA | Executive metrics |
| 17 | Workflow JSON | Editor/API contract |
| 18 | Runbooks | Template apply |

---

## Exporting diagrams

- **MkDocs:** `mkdocs serve` — Mermaid renders automatically.
- **GitHub:** Mermaid blocks in markdown render natively.
- **PNG/SVG:** Use [Mermaid Live Editor](https://mermaid.live) or `mmdc` CLI to export from this page.
