# AccessLease diagram pack

Status: proposed topology for autonomous PRD drafting; not approved for implementation.

#### ◇ Diagram — Architecture
*The core works independently; adapters are optional.*

```mermaid
%%{init: {'theme':'base','themeVariables':{'background':'#0d1117','primaryColor':'#161b22','primaryBorderColor':'#00f0ff','primaryTextColor':'#e2e8f0','lineColor':'#94a3b8','fontFamily':'JetBrains Mono, monospace'}}}%%
graph LR
 subgraph Local["Self-hosted boundary"]
 A["Task and scoped access request"]:::hot
 B["Lease policy and revocation worker"]:::green
 C["Versioned evidence store"]:::hot
 D["Verified revocation receipt"]:::green
 end
 E["Optional ecosystem adapter"]:::ext
 A ==> B
 B ==> C
 C ==> D
 D -.-> E

classDef hot fill:#0d1117,stroke:#00f0ff,stroke-width:2px,color:#e2e8f0;
classDef green fill:#0d1117,stroke:#10b981,stroke-width:1.5px,color:#e2e8f0;
classDef ext fill:#0d1117,stroke:#64748b,stroke-dasharray:4 3,color:#94a3b8;
linkStyle 0,1,2 stroke:#00f0ff,stroke-width:2px;
linkStyle 3 stroke:#64748b,stroke-width:1.5px;
```

> **THE POINT:** The core works independently; adapters are optional.

#### ◇ Diagram — Workflow
*Persist evidence at each boundary; unresolved outcomes remain visible.*

```mermaid
%%{init: {'theme':'base','themeVariables':{'background':'#0d1117','primaryColor':'#161b22','primaryBorderColor':'#00f0ff','primaryTextColor':'#e2e8f0','lineColor':'#94a3b8','fontFamily':'JetBrains Mono, monospace'}}}%%
graph TD
 N0["Request task-scoped lease"]:::hot
 N1["Policy and human approval"]:::hot
 N2["Issue provider TTL grant"]:::hot
 N3["Task closes or time expires"]:::hot
 N4["Revoke and independently check"]:::hot
 N5["Verified or unconfirmed alert"]:::hot
 N0 ==> N1
 N1 ==> N2
 N2 ==> N3
 N3 ==> N4
 N4 ==> N5

classDef hot fill:#0d1117,stroke:#00f0ff,stroke-width:2px,color:#e2e8f0;
classDef green fill:#0d1117,stroke:#10b981,stroke-width:1.5px,color:#e2e8f0;
classDef ext fill:#0d1117,stroke:#64748b,stroke-dasharray:4 3,color:#94a3b8;
linkStyle 0,1,2,3,4 stroke:#00f0ff,stroke-width:2px;
```

> **THE POINT:** Persist evidence at each boundary; unresolved outcomes remain visible.

#### ◇ Diagram — Acceptance decision
*Completion and acceptance are separate; uncertainty cannot become success.*

```mermaid
%%{init: {'theme':'base','themeVariables':{'background':'#0d1117','primaryColor':'#161b22','primaryBorderColor':'#00f0ff','primaryTextColor':'#e2e8f0','lineColor':'#94a3b8','fontFamily':'JetBrains Mono, monospace'}}}%%
graph TD
 A["Evaluate evidence"]:::hot
 B{"All required checks satisfied?"}:::hot
 C["Record accepted result"]:::green
 D["Record failed or unknown result"]:::ext
 E["Operator sees reasons and next step"]:::hot
 A ==> B
 B ==>|Yes| C
 B -->|No or uncertain| D
 D --> E

classDef hot fill:#0d1117,stroke:#00f0ff,stroke-width:2px,color:#e2e8f0;
classDef green fill:#0d1117,stroke:#10b981,stroke-width:1.5px,color:#e2e8f0;
classDef ext fill:#0d1117,stroke:#64748b,stroke-dasharray:4 3,color:#94a3b8;
linkStyle 0,1 stroke:#00f0ff,stroke-width:2px;
```

> **THE POINT:** Completion and acceptance are separate; uncertainty cannot become success.

## Proposed decisions

Select a provider with native TTL, narrow scopes and revocation verification; decide the acceptable residual-access window before a live pilot.

## Risk flags

Provider TTL and revocation semantics differ; cached access may outlive a grant. The chosen provider contract must define and test the maximum residual-access window.
