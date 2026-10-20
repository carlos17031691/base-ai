---
id: database
description: >-
  Design schemas, queries, transactions and zero-downtime migrations for SQL,
  NoSQL and cache stores. Use when modeling data, writing migrations, tuning
  queries or handling concurrency.
targets: all
---

# Database design, persistence & migrations

Guide data modeling, query safety and schema evolution:

1. **Data ownership & engine selection:**
   - Each service in `src/<name>` owns its database/schema exclusively; never share tables across services.
   - Pick the right store for the access pattern (relational ACID for core transactions, document/key-value for high-throughput lookups, cache with explicit TTL and invalidation strategy) and record the choice in an ADR (`adr` skill).

2. **Schema & integrity:**
   - Enforce constraints in both domain and database (`NOT NULL`, `UNIQUE`, foreign keys, check constraints).
   - Use exact numeric types (`BIGINT` minor units or `DECIMAL`) for money/quantities — never `float`/`double`.
   - Include audit timestamps (`created_at`, `updated_at` in UTC) and tenant/owner scoping where applicable.

3. **Transactions, concurrency & performance:**
   - Keep transactions short; never perform network/API calls inside an open DB transaction.
   - Prevent race conditions using optimistic locking (version column) or deterministic pessimistic locking (`SELECT ... FOR UPDATE`).
   - Index foreign keys and frequent filter/sort columns; eliminate N+1 queries; use bounded pagination (`cursor` or `limit/offset`) on every list query; configure connection pooling.

4. **Zero-downtime migrations (Expand & Contract):**
   - **Expand:** add nullable columns, new tables or concurrent indexes backward-compatibly so current code keeps working.
   - **Migrate & deploy:** deploy code that writes to both / reads with fallback, then backfill data in batches.
   - **Contract:** remove legacy columns or constraints only in a subsequent release.
   - Every migration must be versioned, repeatable and accompanied by a rollback strategy.

5. **Security & data lifecycle:**
   - Use parameterized queries exclusively (zero string concatenation).
   - Encrypt sensitive data at rest, apply least-privilege DB credentials, define retention/archival policies and verify backup restoration in the service `runbook`.
