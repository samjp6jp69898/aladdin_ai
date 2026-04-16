---
name: security-audit
description: "White-box security audit for any codebase. Use this skill whenever the user asks to audit a project for security, generate a security report, find vulnerabilities, do a code security review, or mentions 'security audit' / '安全审计'. Also trigger when the user says '审计', 'pentest', 'vulnerability scan', or wants to check a project for XSS, injection, auth bypass, or other security issues."
---

# White-Box Security Audit

A multi-round, multi-agent parallel white-box code audit that produces a comprehensive security report.

## When to use

- User asks to audit a project for security vulnerabilities
- User wants a security audit report for a codebase
- User mentions finding vulnerabilities, security review, or penetration testing at the code level

## Report Modes

Ask the user which mode they want (default: security-only):

### Mode 1: Security Only (default)
Produces one report:
- `{PROJECT_NAME}-SECURITY_AUDIT_REPORT.md` + `.pdf`

### Mode 2: Full Audit
Produces multiple reports, each with its own dedicated analysis:

| Report | File | Focus |
|---|---|---|
| Security | `{PROJECT_NAME}-SECURITY_AUDIT_REPORT.md` | Vulnerabilities, attack chains, CVSS |
| Performance | `{PROJECT_NAME}-PERFORMANCE_AUDIT_REPORT.md` | N+1 queries, missing indexes, memory leaks, bundle size, caching |
| Code Quality | `{PROJECT_NAME}-CODE_QUALITY_REPORT.md` | Dead code, duplication, coupling, error handling, test coverage |
| Infrastructure | `{PROJECT_NAME}-INFRA_AUDIT_REPORT.md` | Docker, CI/CD, env config, cloud security, logging |

### Mode 3: Custom
User specifies which reports to generate. Example: "just security and performance".

### Mode 4: Cross-System
When auditing multiple related repositories, produces individual reports per repo plus:
- `CROSS_SYSTEM_AUDIT_SUMMARY.md` — cross-repo attack chains, shared vulnerabilities, trust boundary analysis

For Mode 2/3/4, run each report type as a separate parallel agent group to maximize efficiency. All non-security reports follow the same three-round methodology (scan → trace → correlate) but with domain-specific patterns.

**Important**: Always run security audit first. Other audits can run in parallel with each other but should have access to security findings for cross-referencing (e.g., a performance fix that introduces a security regression).

## Core Methodology

The audit uses a **Source -> Propagation -> Sink** data flow analysis model across three rounds, each with increasing depth. This approach catches not just individual vulnerabilities, but how they chain together into real attack paths.

**Priority formula**: `Priority = (Attack Surface Size x Potential Impact) / Exploitation Complexity`

---

## Execution Flow

### Step 0: Reconnaissance

Before launching agents, understand the project:

1. Read `package.json`, `go.mod`, `requirements.txt`, `Cargo.toml`, or equivalent to identify the tech stack
2. Run `find . -type f | head -200` or `ls -R` to understand project structure
3. Count LOC: `find . -name '*.ts' -o -name '*.vue' -o -name '*.js' | xargs wc -l 2>/dev/null | tail -1` (adapt extensions to tech stack)
4. Identify the architecture pattern (monolith, microservices, monorepo, frontend/backend split)
5. Note the framework (Vue/React/Next.js, Express/Hono/Django/Spring, etc.) since each has framework-specific vulnerability patterns
6. **Identify the business domain** — this is critical for depth. Understand what the application does: e-commerce? finance? healthcare? SaaS? The business domain determines which security concerns matter most (financial apps need transaction integrity analysis, healthcare needs PII audit, etc.)
7. **Map all external integration points** — third-party APIs, payment gateways, OAuth providers, cloud services (Supabase, Firebase, AWS), webhooks, file storage. Each integration is a trust boundary that needs scrutiny.

Record this in the report metadata section.

**Agent scaling guideline**: Scale agent count based on project complexity. Consider all factors, not just LOC:

| Factor | Low complexity | High complexity |
|---|---|---|
| Code volume | <10K LOC | 50K+ LOC |
| Architecture | Single app, BaaS | Microservices, multi-gate |
| Business domain | Static content, CRUD | Finance, payments, multi-tenant |
| External integrations | 0-2 APIs | 5+ APIs, webhooks, queues |
| Auth complexity | Single role, third-party auth | Multi-role, multi-platform, RBAC |

Score each factor 1-3, sum them:
- **5-8 points → 8 agents** (4 scan + 2 trace + 2 correlate)
- **9-11 points → 10-12 agents** (4-6 scan + 4 trace + 2 correlate)
- **12-15 points → 14-16 agents** (6-8 scan + 4 trace + 2-4 correlate)

The extra agents in larger audits go to:
- Round 1: additional scan domains (business logic, third-party, infrastructure)
- Round 2: dedicated business logic deep-dive agent + compensating controls agent
- Round 3: additional attack chain analysis for complex multi-module interactions

### Step 1: Round 1 — Coverage Scan (Pattern Matching)

**Objective**: `max(coverage)` — cast a wide net to build a high-risk area map.

Launch **4+ parallel agents**, each scanning a different security domain:

**Agent 1 — Authentication & Authorization**:
```
Grep scan for: auth, login, logout, token, jwt, session, cookie,
permission, guard, middleware, beforeEach, isAuthenticated,
requireAuth, password, credential, OAuth, OIDC, SAML, TOTP, OTP, 2FA,
role, admin, super, bypass, anonymous, public, noAuth
```

**Agent 2 — Injection & XSS**:
```
Grep scan for: v-html, innerHTML, dangerouslySetInnerHTML, eval, exec,
Function(, setTimeout(string), document.write, $.html(, sql, query,
raw(, unsafe, serialize, deserialize, pickle, yaml.load,
template literal in SQL, ${ in query context, postMessage, iframe,
window.open, location.href, document.cookie
```

**Agent 3 — Sensitive Data & Logging**:
```
Grep scan for: password, secret, key, token, console.log, console.debug,
localStorage, sessionStorage, cookie, .env, hardcode, plaintext,
base64, encode, decode, private_key, api_key, credential,
mock, test, debug, fake, dummy, example, sample, TODO
```

**Agent 4 — Cryptography, Configuration & Infrastructure**:
```
Grep scan for: crypto, Math.random, md5, sha1, AES, RSA, iv, nonce,
TODO, FIXME, HACK, XXX, commented-out code blocks (// return, /* ... */),
cors, helmet, csp, x-frame, rate.limit, throttle, sandbox,
http://, ws://, allow-origin, Access-Control, Set-Cookie,
Dockerfile, docker-compose, nginx.conf, .env.example
```

**Agent 5 (for larger projects) — Business Logic & Data Integrity**:
```
Grep scan for: balance, amount, price, quantity, discount, coupon,
withdraw, deposit, transfer, refund, payment, order, transaction,
lock, mutex, atomic, race, concurrent, retry, idempotent,
limit, max, min, threshold, quota, expire, timeout, ttl,
verify, validate, check, confirm, approve, reject
```

**Agent 6 (for larger projects) — Third-Party & Infrastructure**:
```
Grep scan for: fetch, axios, http, request, webhook, callback,
supabase, firebase, aws, azure, gcp, s3, blob, upload, download,
redis, rabbitmq, kafka, queue, publish, subscribe,
migration, seed, schema, index, foreign_key, cascade
```

**扫描维度参考**: 参考 `references/scan-dimensions.md` 选择适用的扫描维度和关键词，根据项目类型确定优先维度。

**Important**: The grep patterns above are starting points, not exhaustive checklists. Each agent should also:
- Adapt patterns based on the tech stack discovered in Step 0 (see Framework-Specific Scan Patterns section)
- Follow interesting leads — if a grep match reveals a suspicious file or module, read surrounding code for related issues even if they don't match any keyword
- Look for **absence of expected security controls** (no rate limiting, no input validation, no output encoding, no error handling) — these won't match any grep pattern but are often the most critical findings
- **Enumerate all security domains touched** — aim for 10+ distinct security domains across all agents. If after Round 1 you have findings in fewer than 8 domains, the scan is likely incomplete. Domains include: authentication, authorization, session management, cryptography, input validation, output encoding, logging, error handling, rate limiting, CORS/CSP, file upload, data integrity, business logic, third-party integration, infrastructure configuration.

Each agent should record for every finding:
- File path and line number
- Code snippet (3-5 lines of context)
- Preliminary CWE classification
- Initial severity estimate (Critical/High/Medium/Low)

**Round 1 output**: A combined suspect list, grouped by domain.

### Step 1.5: Hot-Zone Identification & Deep Drilling

After Round 1, before proceeding to Round 2, identify **hot zones** — security domains where Round 1 found 3+ suspects. These warrant exhaustive deep drilling because a cluster of findings in one domain usually indicates systemic weakness, not isolated bugs.

**For each hot zone, launch a dedicated drilling agent** that:

1. **Enumerates every instance** in that domain, not just grep hits. For example, if the hot zone is "authorization":
   - List ALL route definitions / page components / API endpoints in the project
   - For each one, check: does it have a permission check? Is the check hardcoded `true`? Is the check a TODO?
   - Record: `[route/component] → [permission check status: present/missing/hardcoded/TODO]`
   - This is how Abu-Pro found 14+ authorization issues — not by grep, but by enumerating every route and checking each one

2. **Map the complete surface area** of the domain:
   - Authorization: every route × every permission check = complete matrix
   - XSS: every v-html/innerHTML × every data source = complete matrix
   - Sensitive data: every console.log/localStorage write × every data type = complete matrix

3. **Look for patterns of incomplete implementation**:
   - `canEdit = true; // TODO` suggests the developer intended to add checks but didn't — search for ALL similar TODOs
   - One commented-out security check suggests others may be commented out too — search for ALL commented `return` statements
   - One `hasPermission('')` (empty string) call means empty permission = always true — search for ALL empty-string permissions

**Example 1 — Authorization drilling** (Abu-Pro): Round 1 found `canEdit = true` in one file. The drilling agent enumerated ALL permission checks across the project and found: 7 hardcoded `true` in UserList.vue, 6 missing in UserDetailBasic.vue, 14+ empty-permission routes in menu.ts, and 1 TODO in WithdrawOrderList.vue — totaling 28+ authorization findings from a single hot zone.

**Example 2 — XSS exhaustive listing** (Lago-Pro): Round 1 found v-html in a few files. The drilling agent then searched ALL 7 sub-projects for every v-html instance and produced a **46-row complete inventory table**: each row listing project, file path, line number, binding expression, and data source. This became a directly actionable work order for the dev team. This is the "industry-grade exhaustive analysis" standard — the report should contain a complete list, not just "we found v-html in several files".

**When to produce an exhaustive inventory table**: If a hot zone contains 5+ instances of the same pattern (v-html, permission checks, console.log with sensitive data, TODO security checks), produce a complete numbered table listing every single instance. This table is one of the most valuable deliverables in the entire report.

This step is what separates a 9-finding report from a 34-finding report.

### Step 2: Round 2 — Depth Analysis (Data Flow Tracing)

**Objective**: `max(depth)` — confirm or eliminate each suspect from Round 1 (and Step 1.5).

Launch **2-4 parallel agents**, splitting the suspect list by severity:

**Agent — High-severity suspects** (potential Critical/High):
- For each suspect, trace the **complete data flow**: Source -> Propagation -> Sink
- Read the actual code line-by-line (not just grep matches)
- Determine: Is user input actually reachable at this sink? What filtering/validation exists along the path?
- Assign CVSS score based on confirmed exploitability
- **While reading code, actively hunt for code-level logic bugs** that grep cannot find. These are often the highest-severity findings in a report. Specific patterns to watch for:

  **API Misuse**: Is the code calling the right function? Example: `Error.isError(x)` checks if x is an Error instance, but `ErrorCode.isError(x)` checks a numeric error code — using the wrong one means error checks silently pass.

  **Missing return/throw after error handling**: When code calls an error-returning function but doesn't `return` or `throw`, execution continues past the error check. Search for: `returnError(` / `sendError(` / `reject(` without a preceding `return`.

  **Wrong field/variable references**: A field named `expireHour` being used as `wageringMultiplier` — the code runs without error but the business logic is completely wrong. When reading financial/business logic code, verify that each variable is semantically correct for its context.

  **Syntax bugs in strings**: SQL queries, regex patterns, URL templates assembled as strings can contain typos (`FROM FROM`, `< =` instead of `<=`) that make the query always fail silently. Read string-assembled queries character by character.

  **Hardcoded success/bypass**: `return success` or `status = "success"` in TODO/stub implementations that were never completed. These are often hidden behind comments like `// TODO 先架空` or `// 暂时不检查`.

  **Commented-out security checks** — This deserves its own systematic scan. Run a dedicated grep for patterns like:
  ```
  // return.*error
  // return.*reject
  /* ... */ (multi-line comments containing return/throw/error)
  // TODO.*check
  // TODO.*验证
  // TODO.*权限
  ```
  Every commented-out security check is a potential Critical finding. In Agrabah-Pro, 5 separate commented-out checks (JWT expiry, Telegram expiry, wagering check, withdrawal callback, password policy) each became independent Critical/High findings.

**Agent — Medium/Low-severity suspects**:
- Same data flow tracing methodology
- Also check for false positives: is the code dead? Is there a compensating control?
- **Additionally, review business-critical paths** (payment, withdrawal, rewards, user registration) end-to-end, even for code sections that had no Round 1 hits. Business logic flaws (double-spend, race conditions, validation bypass) rarely contain suspicious keywords.
- Downgrade or eliminate findings that don't hold up under scrutiny

**Agent — Business Logic Deep Dive** (for projects with financial/transactional features):
This agent focuses purely on business logic security, independent of Round 1 findings:
- **Transaction integrity**: Are financial operations atomic? Can they be interrupted mid-way leaving inconsistent state?
- **Race conditions**: Are check-then-act patterns protected by locks? Are the locks atomic (SET NX) or vulnerable (EXISTS then SET)?
- **Double-spend / double-claim**: Can rewards, bonuses, or refunds be claimed multiple times through concurrent requests?
- **Validation chain completeness**: For multi-step operations (e.g., order -> payment -> fulfillment), is every step validated? Can steps be skipped or reordered?
- **Error handling in financial flows**: When a step fails mid-transaction, is the state properly rolled back? Are error checks actually effective (check correct API, check correct return type)?
- **Quota/limit bypass**: Can limits (withdrawal limits, daily caps, rate limits) be bypassed through concurrency, parameter manipulation, or logic errors?

**Agent — Compensating Controls Verification & Cross-Layer Penetration**:
For every confirmed vulnerability, systematically verify compensating controls. This is one of the most critical agents — the difference between "frontend is vulnerable but backend compensates" and "frontend AND backend are both vulnerable" is the difference between Medium and Critical.

**Do not assume — read the actual code**:
- If frontend has a vulnerability, open the backend source code and read the specific handler. Example from Abu-Pro: frontend JWT expiry unchecked → opened agrabah-pro `jwt_manager.ts` → found expiry check also commented out → confirmed both layers fail simultaneously.
- If a security check exists, verify it actually works. Read the function implementation. Does `returnError()` actually `return`? Does `isError()` check the right type? Does the validation run before or after the critical operation?

**Cross-layer verification checklist** (do ALL that apply):
- Frontend renders user content unsafely (v-html) → Does backend sanitize before storing? Search backend for `sanitize|DOMPurify|escapeHtml|strip_tags`. Zero matches = confirmed "dual-layer absence".
- Frontend skips auth check → Does backend enforce auth on the same API endpoint? Read the specific route handler, not just the middleware config.
- Frontend has hardcoded credentials → Does backend validate these credentials or accept anything?
- Frontend does client-side validation only → Does backend re-validate? Read the specific handler, not just "backend should validate".

**For cross-system projects** (frontend + backend in same or related repos):
When the audit scope includes both frontend and backend code, launch a dedicated cross-penetration agent that traces data flows across the boundary. For each frontend vulnerability, follow the data into the backend. For each backend vulnerability, check if the frontend exposes or mitigates it. Document findings as: `[Frontend: file:line] → [API call] → [Backend: file:line] → [Result: compensated/not compensated]`.

**Key questions each agent must answer for every finding**:
1. What is the **Source** (user-controllable input)?
2. What **transformations/filters** does the data pass through?
3. What is the **Sink** (dangerous operation)?
4. Are there **compensating controls** (backend validation, WAF, framework protections)?
5. **What specific failure scenarios can occur?** — For every Critical/High finding, create a **failure scenario table**. This is mandatory, not optional. Example:

   **Bad** (vague):
   > Impact: unauthorized access to sensitive operations

   **Good** (specific, from Abu-Pro C-05):
   > | Permission | Operation | Risk |
   > |---|---|---|
   > | `canEdit = true` | Edit any user profile | Data tampering |
   > | `canRecycleBalance = true` | Force-collect all vendor balances | Direct financial loss |
   > | `canAddWithdrawTimes = true` | Modify withdrawal limits | Compliance violation |
   > | `canCallPhone = true` | Call any user's phone | Privacy violation |
   > | `canSendMessage = true` | Send messages as platform | Social engineering |
   > | `canKickThirdPartyGame = true` | Forcibly disconnect game sessions | Service disruption |
   > | `canEditAgentRate = true` | Modify commission rates | Financial manipulation |

   For **business logic vulnerabilities**, enumerate what happens when each step fails:
   > | Failure scenario | Consequence |
   > |---|---|
   > | DB update fails but code continues | Record stays unclaimed, user can claim again |
   > | Lock check is non-atomic | Concurrent requests both pass, double payout |
   > | Error check uses wrong API | Error is never detected, flow continues as if success |

**Round 2 output**: Confirmed vulnerability list with complete data flows and failure scenario tables, plus a list of eliminated false positives with reasons.

### Step 3: Round 3 — Cross-Module Correlation

**Objective**: `max(correlation)` — find attack chains and cross-boundary vulnerabilities.

Launch **2 parallel agents**:

**Agent — Attack Chain Construction**:
- Take all confirmed vulnerabilities and look for combinations that amplify impact
- **Build both technical chains AND business logic chains**:
  - Technical chain example: XSS + insecure token storage = credential theft
  - Business logic chain example: missing validation + race condition + no rollback = infinite money
- Map each chain as: Step 1 (vulnerability A) -> Step 2 (vulnerability B) -> ... -> Final Impact
- Assess: What are the preconditions? What is the final business impact?
- **Aim for at least 3-5 attack chains** — if you find fewer, look harder at vulnerability combinations. Even 2-vulnerability combinations often create chains.
- **Include at least one business logic chain** if the application handles transactions, user data, or any stateful operations.

**Agent — Boundary Verification & Systematic Gap Analysis**:
- For frontend projects: verify if the backend sanitizes data that the frontend renders unsafely
- For backend projects: verify if the frontend sends data that the backend trusts without validation
- Check: Are there security controls that only exist on one side but are assumed on both?
- Verify compensating controls actually work (not just "backend should handle it")
- **Systematic gap analysis**: After all findings are collected, review the full list against the OWASP Top 10 and the security domains list from Step 1. Are there domains with zero findings? If so, either the project is secure in that domain (document as positive finding) or the scan missed it (add targeted scans).

**Round 3 output**: Confirmed attack chains with full flow diagrams, and cross-boundary findings.

### Step 4: Termination Check

After each round, answer these three questions:

1. **Q1: Are there uncovered areas?** — If YES, add targeted scans
2. **Q2: Have all entry points been traced to sinks?** — If NO, trace remaining paths
3. **Q3: Are cross-module associations between high-risk findings verified?** — If NO, investigate

**Additional quality gates before proceeding to report**:
- Are there findings across **8+ distinct security domains**? If not, coverage may be insufficient.
- Does every Critical/High finding have a **complete data flow with code snippets**?
- Does every finding have **specific failure scenario enumeration** (not just generic impact)?
- Are there at least **3 attack chains** identified?
- Are **false positives documented with systematic root cause analysis** (not just per-item reasons)?
- Have **positive security designs** been documented (aim for 5+ items)?

Only proceed to report generation when all checks pass.

### Step 5: Report Generation

Compile all findings into the final report. Read `references/report-template.md` for the exact structure and formatting conventions.

**Report quality requirements**:

1. **Vulnerability detail depth** — every Critical/High finding must include:
   - Exact code snippet with file:line reference
   - Complete Source -> Propagation -> Sink data flow
   - Specific failure scenario table (when X fails, consequence is Y)
   - Runnable fix code (not just descriptions)
   - Preventive measures (ESLint rules, CI checks, architectural changes)

2. **Business impact quantification** — go beyond "data leak" or "unauthorized access":
   - Bad: "Impact: unauthorized access to user data"
   - Good: "Impact: attacker can query any user's wallet balance and transaction history by changing the userId parameter (IDOR). Verified: methodGetTransactions uses request parameter userId instead of context.userId. Affects all N users on the platform."
   - For financial operations, enumerate each failure mode in a table:
     | Failure scenario | Consequence |
     |---|---|
     | DB update fails but code continues | Record stays unclaimed, user can claim again |
     | Lock is non-atomic | Concurrent requests both pass, double payout |

3. **False positive analysis** — group eliminated findings by root cause:
   - Bad: listing each false positive with individual reasons
   - Good: "6 SQL injection suspects were eliminated. Root cause: the project uses binary Protobuf (protobufjs 8.0.0) for RPC serialization. `decode(Uint8Array)` returns JavaScript number types for enum/integer fields, which cannot contain SQL metacharacters."

4. **Positive findings** — document at least 5 good security designs. This helps developers understand what patterns to replicate and builds trust in the report's objectivity.

5. **Fix quality** — every P0/P1 fix must include:
   - Actual runnable code (not pseudocode)
   - Preventive measure to stop recurrence (ESLint rule, type constraint, CI check)
   - Migration notes if the fix requires data migration

Save the report with a descriptive filename that includes the project name, e.g.:
- `AGRABAH-{PROJECT_NAME}-SECURITY_AUDIT_REPORT.md` for a project named "agrabah-pro"
- `LAND-{PROJECT_NAME}-SECURITY_AUDIT_REPORT.md` for a project named "land"

Format: `{PROJECT_NAME}-{PROJECT_NAME}-SECURITY_AUDIT_REPORT.md` (uppercase, hyphens, no spaces). If the user specifies a filename, use that instead.

### Step 6: PDF Export

After generating the markdown report, convert it to PDF:

```bash
# Option 1: pandoc (preferred if available)
pandoc {PROJECT_NAME}-SECURITY_AUDIT_REPORT.md \
  -o SECURITY_AUDIT_REPORT.pdf \
  --pdf-engine=weasyprint \
  --metadata title="Security Audit Report" \
  -V mainfont="PingFang SC" \
  -V monofont="Menlo" \
  -V geometry:margin=2cm

# Option 2: pandoc with default engine
pandoc {PROJECT_NAME}-SECURITY_AUDIT_REPORT.md \
  -o SECURITY_AUDIT_REPORT.pdf \
  --pdf-engine=xelatex \
  -V mainfont="PingFang SC" \
  -V monofont="Menlo" \
  -V geometry:margin=2cm \
  -V CJKmainfont="PingFang SC"

# Option 3: weasyprint directly
weasyprint <(python3 -c "
import markdown2
md = open('{PROJECT_NAME}-SECURITY_AUDIT_REPORT.md').read()
html = markdown2.markdown(md, extras=['tables','fenced-code-blocks'])
print(f'<html><head><meta charset=\"utf-8\"><style>body{{font-family:PingFang SC,sans-serif;margin:2cm}}code,pre{{font-family:Menlo,monospace;background:#f5f5f5;padding:2px 6px}}pre{{padding:12px}}table{{border-collapse:collapse;width:100%}}th,td{{border:1px solid #ddd;padding:8px;text-align:left}}th{{background:#f0f0f0}}</style></head><body>{html}</body></html>')
") SECURITY_AUDIT_REPORT.pdf
```

Try Option 1 first. If it fails, fall through to Option 2, then Option 3. If all fail, inform the user that the markdown report is ready and suggest they install the needed tool.

Both `.md` and `.pdf` files should be delivered.

---

## Framework-Specific Scan Patterns

The Round 1 agents should include framework-specific patterns based on the tech stack identified in Step 0:

**Vue.js**: `v-html`, `v-bind:href`, `$refs.*innerHTML`, router guards (`beforeEach`), Pinia/Vuex state exposure
**React**: `dangerouslySetInnerHTML`, `ref.current.innerHTML`, `href={userInput}`, missing auth in route components
**Next.js/Nuxt.js**: `getServerSideProps` data leaking to client, API route auth, SSR injection
**Express/Hono/Fastify**: middleware ordering, `res.send(unsanitized)`, missing helmet/cors, route parameter injection
**Django/Flask**: `|safe` template filter, `mark_safe()`, raw SQL, `DEBUG=True`, CSRF exemptions
**Spring**: SpEL injection, mass assignment (`@ModelAttribute`), actuator endpoints, CSRF config
**Go**: `template.HTML()`, SQL string concat, goroutine race conditions, `net/http` without timeouts
**Rust/Actix/Axum**: `unsafe` blocks, `.unwrap()` in request handlers, missing CORS

**BaaS-Specific Patterns** (Supabase, Firebase, Appwrite):
- RLS (Row Level Security) policies: are they enabled on all tables? Are policies correct?
- Service role key exposure: is the service_role key used in frontend code?
- Direct table access: can users bypass API and query tables directly?
- Storage bucket policies: are uploaded files publicly accessible?
- Edge functions: do they validate auth independently?
- Realtime subscriptions: can users subscribe to other users' data?

**Cloud/Infrastructure Patterns**:
- Environment variables: are secrets in `.env` committed? Are `.env.example` files exposing real values?
- CORS configuration: `Access-Control-Allow-Origin: *` with credentials?
- Cookie security: missing `Secure`, `HttpOnly`, `SameSite` flags?
- CSP headers: missing or overly permissive `Content-Security-Policy`?
- SSL/TLS: hardcoded `http://` URLs in production code?

---

## Severity Classification

| Level | CVSS | Criteria |
|-------|------|----------|
| Critical | 9.0-10.0 | Direct system compromise, credential theft, financial loss, no auth required |
| High | 7.0-8.9 | Significant damage possible, may require auth or specific conditions |
| Medium | 4.0-6.9 | Limited damage, requires multiple preconditions |
| Low | 0.1-3.9 | Hardening recommendations, defense-in-depth improvements |

---

## Important Guidelines

- **Always trace data flows**: A grep match is a suspect, not a vulnerability. Confirm with line-by-line code reading.
- **Record false positives with root cause analysis**: Group eliminated findings by their common root cause (e.g., "all eliminated due to Protobuf type safety"). This prevents re-investigation and demonstrates analytical rigor.
- **Note positive findings generously**: Aim for 5+ positive findings. Good security designs deserve recognition. This builds trust in the report and helps developers understand what to replicate. Look for: proper parameterized queries, correct use of crypto APIs, effective input validation, atomic operations, proper error handling, secure defaults.
- **Estimate fix hours precisely**: Every P0/P1 item should have a realistic time estimate (down to 5min/30min granularity) so teams can plan sprints.
- **Use CWE codes**: Every finding must reference at least one CWE for standardized classification.
- **Include code snippets**: Every finding must include the actual vulnerable code with file path and line numbers.
- **Write in the user's language**: If the project or user communicates in Chinese, write the report in Chinese. Match the user's language.
- **Quantify business impact specifically**: "Users can steal tokens" is insufficient. "Any user with XSS can extract the JWT from localStorage (key: `lt`), which never expires (CWE-613), enabling permanent account takeover of any user who views the compromised page" is the standard.
- **Provide runnable fix code**: Every P0 fix should include actual code that developers can copy-paste, not just descriptions. Include preventive measures (ESLint rules, CI checks) to stop recurrence.
- **Enumerate failure scenarios for complex findings**: For business logic vulnerabilities, create a failure scenario table showing what happens when each step fails, rather than only describing the happy-path exploit.
