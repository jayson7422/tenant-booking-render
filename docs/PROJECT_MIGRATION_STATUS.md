# BayanSpaces / BayanWorkforce Migration Status

Last reviewed: September 22, 2026  
Project: `tenant-booking` / BayanSpaces / BayanWorkforce

This document records what was discovered, what was changed, what was tested,
what is currently running, and what remains before production deployment. It is
intended to be the main project handoff and recall document for the migration.

## 1. Executive summary

Checkpoints 1 through 5 are complete.

The local application has been migrated from JSON-file persistence to a shared
MariaDB database running through XAMPP. The verified server data was copied into
the local database without changing the deployed server. The local Workforce
and Tenant Booking services now read and write MariaDB, and automated API tests
confirmed authentication, authorization, tenant and room management, booking
rules, attendance, shifts, payroll, cancellation, restart persistence, and
cleanup.

The project is **not ready for Render deployment yet**. The production database
provider, database engine, Render service layout, production session strategy,
and cutover process have not been approved. The existing `render.yaml` still
describes the old JSON architecture and must not be deployed.

Current checkpoint status:

| Checkpoint | Scope | Status |
|---|---|---|
| 1 | Architecture audit and source-data identification | Complete |
| 2 | Verified backups and relational database design | Complete |
| 3 | XAMPP/MariaDB setup and migration tooling | Complete |
| 4 | Local data migration and verification | Complete |
| 5 | Application database refactor and local functional testing | Complete |
| 6 | Render and production-database architecture design | Not started |
| 7 | Production preparation, security, rollback, and approved cutover | Not started |

## 2. Current architecture

### 2.1 Runtime architecture now used locally

```text
Workforce browser
    |
    | HTTP :5177
    v
server.js (core API, authentication, and business rules)
    |
    v
src/repositories/applicationRepository.js
    |
    v
mysql2 connection pool
    |
    v
XAMPP MariaDB: bayan_spaces_dev @ 127.0.0.1:3306


Tenant/booking browser
    |
    | HTTP :6500
    v
booking-server.js (static booking UI and restricted API proxy)
    |
    | proxies approved API paths to 127.0.0.1:5177
    v
server.js -> repository -> MariaDB
```

Optional external integrations:

```text
server.js -> Google OAuth / Google Calendar API
server.js -> configured SMTP provider
```

MariaDB listens only on `127.0.0.1`. The Node services listen on their
application ports so they can be reached through the intended LAN or VPN.

### 2.2 Technology inventory

- Frontend: existing HTML, CSS, and browser JavaScript; no frontend framework.
- Core backend: Node.js using the built-in `http` module.
- Booking service: a second small Node.js HTTP server that serves booking files
  and proxies approved API paths to the core server.
- Database driver: `mysql2` promise API with connection pooling.
- Environment loading: `dotenv`.
- Local database: XAMPP MariaDB 10.4.32.
- Email: `nodemailer`, enabled only when SMTP variables exist.
- Calendar: OAuth refresh-token integration, with service-account fallback.
- Authentication: password/access-code hashes using Node.js `scrypt`.
- Sessions: random bearer tokens stored in Node process memory.

### 2.3 Current ports and URLs

| Purpose | Local URL |
|---|---|
| Workforce application | `http://localhost:5177` |
| Tenant booking portal | `http://localhost:6500` |
| Booking administration | `http://localhost:6500/admin` |
| MariaDB | `127.0.0.1:3306` |

At the time of this document update, MariaDB and both Node services were
listening on those ports.

## 3. Checkpoint 1 — audit and source-data identification

### 3.1 What was inspected

The audit covered the application entry points, npm scripts, frontend files,
API routes, authentication, authorization, persistence functions, booking
proxy, Render manifest, Google Calendar logic, SMTP logic, hardcoded
configuration, and both local and deployed data locations.

Important files included:

- `server.js`
- `booking-server.js`
- `data.json`
- `package.json` and `package-lock.json`
- `render.yaml`
- `README.md`
- `.gitignore`
- `public/app.js`
- `public/booking.js`
- `public/booking-admin.js`
- related HTML and CSS files

### 3.2 Application roles discovered

`server.js` is the core system. It implements the Workforce APIs, tenant and
room administration, tenant authentication, bookings, payroll, attendance,
shifts, email, Calendar integration, and static Workforce UI.

`booking-server.js` is not an independent data backend. It serves the booking
UI on port 6500 and proxies booking-related API calls to the core server on port
5177.

This means the two processes represent two entry points into one logical
application, not two unrelated databases.

### 3.3 Original persistence architecture

The original core server used synchronous filesystem calls around `data.json`:

```text
HTTP route -> readData() -> in-memory object -> save() -> data.json
```

This created several risks:

- concurrent writes could overwrite each other;
- the entire dataset was rewritten for small changes;
- relational constraints did not exist;
- production filesystem persistence depended on deployment-specific storage;
- automatic starter-data behavior could accidentally create or overwrite data;
- local and server instances could silently point to different files.

### 3.4 Two distinct data sources confirmed

The deployed booking instance and local development instance did **not** use the
same data file.

| Environment | Data source |
|---|---|
| Deployed server | `D:\AppLike ConnecTeam\data.json` |
| Local development | repository-local `data.json` or its configured `DATA_FILE` |

The deployed server file was verified from the backend/server environment. The
browser display was not used as the only proof.

The deployed server data was selected as the source of truth for the local
migration because it contained the legitimate tenant, rooms, booking, user,
and integration records that had to be preserved.

### 3.5 Architecture recommendation made

The local design uses one shared relational database because Workforce and
Tenant Booking are one logical system with shared users, employees, tenants,
rooms, bookings, and integrations.

The two Node entry points were kept for local compatibility:

- port 5177 remains the core application and API;
- port 6500 remains the restricted booking UI/proxy.

Whether Render should run one service or two services was deliberately left for
Checkpoint 6. No production architecture was chosen silently.

## 4. Checkpoint 2 — backups and relational design

### 4.1 Backups created

The server and local JSON datasets were backed up separately and labeled:

- `backups/server-data-before-mysql-20260921-212020.json`
- `backups/local-data-before-mysql-20260921-211836.json`
- `backups/deployed-code-before-mysql-20260921-212020.zip`

The deployed code archive was extracted under the ignored backup inspection
directory so the newer Google OAuth behavior could be reviewed later.

The server source backup SHA-256 is:

```text
C01BBBF4F1031CD52EC4CF3E9CE74FE08A991808368DEA7CFCA9FCB3F47F89A2
```

That hash was rechecked after migration and after the application refactor. It
did not change.

The whole `backups/` directory is ignored by Git so data files, tokens, SQL
dumps, and inspection copies are not accidentally committed.

### 4.2 Verified pre-migration server counts

| Entity | Count |
|---|---:|
| Users | 4 |
| Employees | 4 |
| Attendance | 0 |
| Payrolls | 0 |
| Shifts | 3 |
| Tenants | 1 |
| Rooms | 3 |
| Bookings | 1 |

No plaintext user passwords or tenant access codes were found. Existing hashes
were retained so credentials would continue to work.

The deployed JSON also contained an encrypted Google OAuth refresh token and a
Calendar event ID. Both needed to survive migration.

### 4.3 Relational schema created

`database/schema.sql` defines 13 InnoDB tables:

1. `schema_migrations`
2. `companies`
3. `employees`
4. `users`
5. `attendance`
6. `payrolls`
7. `shifts`
8. `tenants`
9. `rooms`
10. `bookings`
11. `booking_settings`
12. `google_oauth_credentials`
13. `migration_runs`

The design includes:

- preserved string IDs;
- foreign keys and relationship rules;
- unique usernames, employee codes, tenant emails, and room names;
- indexed booking-conflict lookup fields;
- decimal monetary and hour fields;
- proper `DATE`, `TIME`, and `DATETIME(3)` columns;
- status constraints;
- encrypted integration-token storage;
- migration source hashes and completion status.

Booking duration is stored canonically as integer minutes. The API converts
minutes to hours for compatibility with the existing frontend.

Booking snapshot columns retain the tenant name, tenant-company name, and room
name as they appeared when the booking was made. This protects historical
display even when master records later change.

## 5. Checkpoint 3 — XAMPP setup and migration tooling

### 5.1 Local database provisioning

The local database is:

```text
bayan_spaces_dev
```

The application connects with the restricted account:

```text
bayan_spaces_app@localhost
```

The Node application does not connect as MariaDB root. Application credentials
are loaded from the ignored `.env` file. Safe placeholders and all supported
configuration keys are documented in `.env.example`.

### 5.2 Database connection layer

`src/config/database.js` provides:

- required environment-variable validation;
- a promise-based `mysql2` connection pool;
- connection limits;
- UTF-8 configuration;
- UTC-oriented date handling;
- connection testing;
- explicit pool shutdown.

The command below verifies the database, version, table count, and installed
schema versions:

```powershell
npm.cmd run db:test
```

### 5.3 Migration tooling

`scripts/migrate-json-to-mysql.js` was created with several safety gates:

- requires an explicit `--source` path;
- requires an explicit source environment;
- validates JSON before connecting or writing;
- rejects plaintext credential fields;
- checks unique IDs and business keys;
- checks relationships and hash formats;
- checks that booking hours match start/end times;
- reports the exact source SHA-256;
- runs read-only unless `--apply` is present;
- requires the caller to repeat the exact SHA-256 for apply mode;
- refuses a non-empty target database;
- inserts parents before dependent records;
- uses a transaction;
- preserves IDs and hashes;
- records completion in `migration_runs`;
- prevents a successful source hash from being imported twice;
- never deletes or modifies the source JSON.

`scripts/verify-json-migration.js` independently compares the source and
database after import. It checks every migrated field, including sensitive
hashes and ciphertext, without printing their values.

### 5.4 XAMPP privilege-table issue discovered

XAMPP MariaDB has an existing problem in its system privilege tables. A
database-wide `GRANT ... ON bayan_spaces_dev.*` caused MariaDB 10.4 to crash in
its grant-handling code. Logs also indicated a previously crashed `mysql.db`
table.

No aggressive system-table repair was attempted because it was outside the
approved scope and could create additional risk.

The verified workaround grants permissions per table through the application
account. The account has data-level access but no global, create, alter, or drop
privileges. `schema_migrations` is read-only for the app; `migration_runs` has
only the access required by the migration tool.

This XAMPP issue remains a known local-environment risk.

## 6. Checkpoint 4 — local migration and verification

### 6.1 MariaDB network hardening

Before importing the real server snapshot, the XAMPP `my.ini` file was backed
up and changed to:

```ini
bind-address="127.0.0.1"
```

Network inspection confirmed that MariaDB listens only on localhost, not on
`0.0.0.0`, the LAN address, or the VPN address.

### 6.2 Transactional import

The target database was confirmed empty and schema version `001` was confirmed
installed. The verified server backup and exact SHA-256 were then supplied to
the guarded migration command.

Migration result:

| Entity | Source | Database | Result |
|---|---:|---:|---|
| Users | 4 | 4 | Match |
| Employees | 4 | 4 | Match |
| Attendance | 0 | 0 | Match |
| Payrolls | 0 | 0 | Match |
| Shifts | 3 | 3 | Match |
| Tenants | 1 | 1 | Match |
| Rooms | 3 | 3 | Match |
| Bookings | 1 | 1 | Match |

Additional singleton records were imported for the company, booking settings,
and encrypted Google OAuth credential.

### 6.3 Business-data verification

Direct SQL and the independent verifier confirmed:

- Jayson exists;
- FiveTwenty IT Services is preserved;
- allotted hours are `10.00`;
- confirmed usage is `0.97` hours;
- remaining time is `9.03` hours;
- Astra 1, Astra 2, and Rocket Room exist;
- the Rocket Room booking exists on September 17, 2026;
- its time is 12:01–12:59;
- its canonical duration is 58 minutes;
- status is Confirmed;
- its Calendar event ID is preserved;
- there are no overlapping confirmed bookings;
- all four users remain active with the correct roles;
- password and access-code hashes match the source;
- there are no relationship orphans;
- the OAuth ciphertext matches the source.

### 6.4 Restart and repeat-safety verification

MariaDB was shut down normally and restarted. The complete comparison passed
again, proving that the records persisted across a database restart.

A migration-ledger edge case was found during review: a refused repeat import
could have relabeled the existing completed audit row as failed. The tool was
corrected so preflight rejection does not alter the completed audit entry.

A deliberate second import was then rejected, no records were duplicated, and
the original migration remained marked completed.

## 7. Checkpoint 5 — application database refactor and testing

### 7.1 Database access layer

`src/repositories/applicationRepository.js` now contains the SQL used by the
application. Routes do not contain ad hoc SQL statements.

The repository provides:

- a database-to-API snapshot reader;
- tenant create, update, and delete operations;
- room create, update, and delete operations;
- transactional booking creation;
- booking cancellation and Calendar-event updates;
- shift create, update, delete, and batch copy;
- employee/user transactional creation and updates;
- attendance operations;
- payroll operations;
- encrypted Google OAuth credential storage;
- translation of database constraint errors into API-friendly conflicts.

### 7.2 Removal of JSON runtime persistence

The following runtime behaviors were removed from `server.js`:

- `DATA_FILE` selection;
- `readData()`;
- whole-file `save()` calls;
- automatic starter records;
- automatic database fallback to JSON;
- automatic seeding when the database is empty.

Every API request now obtains data through the repository. Every mutation uses
an explicit repository operation. The core service tests its database
connection and required migrated company record before opening its HTTP port.

If MariaDB is unavailable or uninitialized, startup fails instead of creating
replacement data.

### 7.3 Booking concurrency protection

Confirmed booking creation now uses a database transaction. It locks the
relevant tenant and room rows, then rechecks:

- that the tenant is still active;
- that the room still exists;
- confirmed used minutes versus allotted minutes;
- overlapping confirmed bookings.

Only then is the booking inserted. This closes the most important race that
existed when two requests could read the same JSON state and both save.

If Calendar event creation fails after reservation, the new database booking is
removed so the system does not leave an apparently confirmed unsynchronized
booking.

### 7.4 Schema version 002

The deployed server snapshot had a newer tenant-cancellation workflow. Schema
migration `002_booking_cancellations.sql` adds:

- `bookings.cancellation_remark`
- `bookings.cancelled_at`

The migration is explicit and repeat-safe. It is applied with:

```powershell
npm.cmd run db:migrate
```

Schema migrations never run silently during normal application startup.

### 7.5 Google Calendar reconciliation

The newer deployed OAuth behavior was reconciled with the local refactor:

- OAuth client settings remain environment variables;
- refresh tokens are encrypted using AES-256-GCM before storage;
- encrypted tokens are stored in `google_oauth_credentials`;
- the OAuth callback persists through the repository;
- the booking-admin UI includes Calendar connection status and authorization;
- OAuth refresh-token access is preferred when configured;
- service-account access remains a fallback;
- per-room Calendar IDs remain supported;
- availability checks and event create/delete behavior remain supported.

The migrated encrypted token is preserved. It cannot be proven usable locally
without the matching encryption key and OAuth client secrets, which were
correctly not copied into source control.

### 7.6 Frontend parity and security adjustments

- The booking proxy now forwards OAuth routes and serves `google-oauth.js`.
- The tenant portal exposes cancellation with a required audit remark.
- The tenant portal displays suggested alternative times after a conflict.
- The Workforce login screen no longer pre-fills or advertises demo
  credentials.
- Existing endpoint shapes were retained so a frontend rewrite was unnecessary.

### 7.7 Local functional test coverage

`scripts/test-local-application.js` creates records prefixed with `TEST_`, tests
them, restarts both Node services, verifies persistence, then deletes the test
records in dependency-safe order.

The following passed:

- admin login;
- manager login;
- employee login;
- invalid-password rejection;
- admin/manager/employee authorization boundaries;
- test employee creation and authentication;
- tenant creation and editing;
- room creation and editing;
- booking availability;
- booking creation;
- conflict rejection;
- allotted, used, and remaining hour calculations;
- booking cancellation and remark persistence;
- attendance creation;
- manager-created shift;
- payroll calculation and persistence;
- OAuth status endpoint behavior;
- booking proxy routing;
- Node service restart;
- post-restart authentication and record persistence;
- complete cleanup of test records;
- preservation of all legitimate records.

Final `TEST_` record count was zero.

The original source-to-database verifier also passed again after the
application tests and schema upgrade.

## 8. Current database status

Installed schema versions:

- `001` — initial BayanSpaces/BayanWorkforce relational schema
- `002` — booking cancellation audit fields

Current legitimate record counts:

| Entity | Count |
|---|---:|
| Companies | 1 |
| Users | 4 |
| Employees | 4 |
| Attendance | 0 |
| Payrolls | 0 |
| Shifts | 3 |
| Tenants | 1 |
| Rooms | 3 |
| Bookings | 1 |
| Booking settings | 1 |
| Google OAuth credentials | 1 |

## 9. Commands currently available

| Command | Purpose |
|---|---|
| `npm.cmd start` | Start the MariaDB-backed core application on port 5177 |
| `npm.cmd run start:booking` | Start the booking UI/proxy on port 6500 |
| `npm.cmd run db:test` | Test DB connectivity and show schema versions |
| `npm.cmd run db:migrate` | Explicitly apply pending relational schema migrations |
| `npm.cmd run migrate -- ...` | Validate or apply an explicit JSON-to-DB import |
| `npm.cmd run verify:migration -- ...` | Compare an approved JSON source with the DB |
| `npm.cmd run test:local -- --phase=create` | Create and test isolated QA records |
| `npm.cmd run test:local -- --phase=verify-cleanup` | Verify after restart and remove QA records |

Detailed local setup instructions are in [LOCAL_SETUP.md](LOCAL_SETUP.md).

## 10. Important decisions already made

These decisions should be treated as the current baseline unless deliberately
revisited:

1. The server dataset, not the different localhost JSON file, was the source
   for the local migration.
2. Workforce and Tenant Booking share one relational database.
3. Existing record IDs and credential hashes are preserved.
4. Booking duration is stored in integer minutes.
5. Historical names are retained as booking snapshots.
6. MariaDB/XAMPP is for local development only.
7. The application account is restricted and does not perform schema changes.
8. Schema changes are explicit migrations, not automatic startup behavior.
9. An empty database is not automatically seeded.
10. JSON backups are retained and ignored by Git.
11. The deployed server remains untouched until an approved production
    cutover.
12. No production database engine or provider has been selected.
13. No one-service or two-service Render decision has been finalized.

## 11. Known risks and incomplete areas

### 11.1 Production architecture is not defined

There is no approved persistent production database, network connection,
service topology, migration pipeline, or final Render manifest.

`render.yaml` still contains the legacy `DATA_FILE` and persistent-disk design.
It is intentionally not being treated as deployable configuration.

### 11.2 The live server can continue changing

The September 21 backup is a verified historical snapshot and was correct for
the local migration. It must not automatically be treated as the final
production cutover dataset.

If users continue using `192.168.200.15`, the live JSON can gain new or changed
records. Immediately before production migration, the process must:

1. identify the still-active source file again;
2. create a fresh timestamped backup;
3. calculate a fresh hash and counts;
4. compare it with the September 21 snapshot;
5. migrate the latest approved snapshot or reconcile the delta;
6. control writes during final cutover so nothing is lost.

Until the production cutover succeeds, the deployed server remains the live
source of truth for any records entered there.

### 11.3 XAMPP administrative risks

- The local MariaDB root account currently has no password.
- MariaDB is mitigated by listening only on `127.0.0.1`.
- The XAMPP `mysql.db`/database-wide grant issue has not been repaired.
- Table-level grants work and are the current safe workaround.
- A system-table repair should have its own backup and approval.

### 11.4 Authentication and sessions

- Existing migrated passwords still work and some may be known defaults.
- Those credentials must be rotated before production.
- Bearer sessions live only in Node memory.
- Restarting the core service logs users out.
- Multiple Render instances would not share those sessions.
- Login rate limiting, lockout policy, token expiration, and production session
  storage need formal review.

### 11.5 Integration testing

- Google OAuth code and encrypted DB storage are implemented.
- A live local OAuth test requires the matching client credentials,
  encryption key, redirect URI, and Calendar access.
- SMTP is currently unconfigured, so no real email was sent.
- Production redirect URIs and secrets must be created only after the final
  service/domain design is chosen.

### 11.6 Security hardening still required

The original project requested a complete pre-production review covering:

- authentication and authorization;
- known/default credentials;
- request body limits;
- login rate limiting;
- input validation;
- session expiration and revocation;
- localStorage bearer-token implications;
- CORS and CSRF assumptions;
- error-message exposure;
- secure headers;
- HTTPS/proxy trust;
- SQL injection defenses;
- admin-only routes;
- secret management;
- dependency review and audit logging.

Parameterized repository queries already reduce SQL-injection risk, and role
checks remain in place, but the full production security gate is not complete.

### 11.7 Testing boundaries

Automated API and persistence tests passed. A final manual browser walkthrough
on the intended desktop/mobile browsers and a VPN/LAN client is still useful
before production.

Live Google Calendar and SMTP delivery were not tested because their secrets
were not configured locally.

### 11.8 Version-control state

The migration work from the completed checkpoints is present in the working
tree and has not been committed by this process. Existing user-owned files,
including `cmd start.txt`, were preserved.

Before production work, the user should review the diff and create a clear
local commit or branch checkpoint. No commit should be made automatically
without the user's request.

## 12. Remaining Checkpoint 6 — architecture design only

Checkpoint 6 should make and document the production architecture decision. It
should not migrate real production data.

### 12.1 Production database options to evaluate

The options must be compared using current provider documentation and pricing
at the time of the checkpoint:

1. A managed MySQL-compatible database for maximum local/production schema
   consistency.
2. A managed MariaDB-compatible database if a reliable supported provider is
   available.
3. Managed PostgreSQL if its operational advantages justify converting the
   schema, SQL, driver, and migration scripts.
4. Self-hosted database infrastructure, which should be considered only if the
   operational burden is explicitly accepted.

The comparison must cover:

- compatibility with the existing MariaDB schema;
- provider availability and reliability;
- private versus public networking;
- TLS requirements;
- backups and point-in-time recovery;
- storage limits and scaling;
- connection limits and pooling;
- maintenance burden;
- cost;
- data residency requirements;
- export and disaster-recovery options.

No database-engine switch should happen without explicit approval.

### 12.2 Render service topology decision

Two approaches need a formal decision.

#### Option A — one Render web service

Potential benefits:

- one public origin;
- simpler OAuth callback and environment configuration;
- no internal HTTP dependency between services;
- potentially lower cost and operational complexity;
- one health check and deployment unit.

Questions to resolve:

- how Workforce and Booking routes should share one public port;
- whether the Workforce UI should be publicly exposed;
- whether route isolation is sufficient for booking-only access.

#### Option B — two Render web services

Potential benefits:

- separate public exposure and scaling;
- booking service can remain narrowly scoped;
- Workforce can remain private or independently protected.

Questions to resolve:

- how the booking proxy reaches the core API securely;
- whether two services justify added cost and operational complexity;
- how OAuth callbacks, CORS, cookies/tokens, and internal URLs work;
- how deployments are coordinated.

### 12.3 Other Checkpoint 6 design work

Checkpoint 6 should also define:

- production `PORT` handling;
- `APP_BASE_URL`, booking URL, API URL, and OAuth callback variables;
- whether `booking-server.js` remains necessary;
- production database TLS configuration;
- connection-pool sizing;
- session design for one or multiple instances;
- health and readiness checks;
- schema-migration ownership during deploys;
- Google OAuth local and production redirect URIs;
- SMTP production configuration;
- logging, monitoring, and alerting;
- staging/test environment strategy;
- expected monthly cost and operational owner.

### 12.4 Checkpoint 6 deliverables

Expected outputs:

- an options comparison;
- a recommended production database and provider category;
- a recommended one-service or two-service layout;
- a proposed architecture diagram;
- required environment variables and secret locations;
- networking and TLS design;
- a session/authentication recommendation;
- a production migration outline;
- identified code and schema changes;
- explicit approval request before implementation.

Checkpoint 6 must stop after design and approval discussion.

## 13. Remaining Checkpoint 7 — production preparation and cutover

Checkpoint 7 begins only after the Checkpoint 6 architecture is approved.

It should be separated into preparation and an explicit go-live gate.

### 13.1 Preparation work

Depending on the approved architecture, preparation may include:

- adapting the database layer if the engine changes;
- creating production-compatible schema migrations;
- replacing the legacy `render.yaml`;
- configuring Render's runtime-assigned port;
- configuring public and internal base URLs;
- adding database TLS options;
- implementing the approved session strategy;
- adding production health/readiness behavior;
- hardening validation and error handling;
- adding rate limiting and security headers;
- removing or rotating known/default credentials;
- documenting every production secret without committing values;
- creating staging resources;
- running clean-database schema tests;
- running migration rehearsals with copied data;
- completing dependency and security review;
- testing OAuth and SMTP with approved non-production credentials.

### 13.2 Fresh production-data capture

Before real migration:

1. confirm the exact live source file and process configuration again;
2. establish a write-free maintenance window or another safe delta strategy;
3. create a new server data backup and deployed-code backup;
4. parse and validate the backup;
5. calculate and record its SHA-256;
6. record pre-migration counts;
7. compare the new data with the prior snapshot;
8. obtain explicit approval for that exact source hash and destination.

The current local MariaDB database must not silently overwrite or replace newer
server records.

### 13.3 Explicit production approval gate

No real production import or traffic cutover should occur until the user
approves all of the following:

- production database provider and database identity;
- fresh source backup path and SHA-256;
- pre-migration record counts;
- maintenance/downtime plan;
- rollback backup locations;
- deployed application version;
- environment variables and OAuth redirect URI;
- verification checklist;
- responsible person and cutover time.

### 13.4 Production migration and deployment

After explicit approval:

- create the production schema;
- test the restricted application connection;
- import the exact approved source in a transaction where supported;
- verify counts, IDs, relationships, hashes, hours, and integrations;
- deploy the approved application version;
- test health and authentication;
- test role permissions;
- test tenant and room reads;
- create and remove only `TEST_` production QA records;
- test conflict handling and hour calculations;
- verify data after application restart/redeploy;
- test Google Calendar and SMTP;
- switch user traffic only after the acceptance checks pass.

### 13.5 Rollback plan to finish before go-live

The rollback document must cover:

- database import failure;
- application deployment failure;
- login or authorization failure;
- incorrect tenant hours or booking history;
- Google Calendar failure;
- SMTP failure;
- database connectivity failure;
- rollback to the existing server process and JSON file;
- restoration of the last verified production database backup;
- DNS/domain or service-routing rollback;
- post-rollback verification and incident notes.

The existing server must remain recoverable until production acceptance is
complete.

### 13.6 Documentation still to finish

The following project documents should be created or finalized during the
remaining work:

- `docs/ARCHITECTURE.md`
- `docs/DATABASE_MIGRATION.md`
- `docs/RENDER_DEPLOYMENT.md`
- `docs/ROLLBACK.md`
- final production sections in `README.md`
- final production environment-variable reference in `.env.example`

This status document and `LOCAL_SETUP.md` already cover the completed local
migration and operation.

## 14. Recommended review before proceeding

Before approving Checkpoint 6, review:

1. this entire status document;
2. [LOCAL_SETUP.md](LOCAL_SETUP.md);
3. `database/schema.sql` and migration `002`;
4. `src/repositories/applicationRepository.js`;
5. the `server.js` route/refactor diff;
6. the current UI manually at ports 5177 and 6500;
7. the working-tree diff and backup inventory.

After review, the next safe instruction is to approve **Checkpoint 6 design
only**. Checkpoint 6 will compare production options and return for another
decision; it will not deploy or migrate production data.

