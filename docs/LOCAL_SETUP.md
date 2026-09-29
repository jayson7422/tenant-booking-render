# Local MariaDB setup

This project uses XAMPP MariaDB for local database development. XAMPP and its
database are not used by Render and must never be exposed to the public
internet.

## Prerequisites

- Node.js 20 or newer
- XAMPP with MariaDB/MySQL running on `127.0.0.1:3306`
- A local `.env` copied from `.env.example`

## Database provisioning

The approved local database is `bayan_spaces_dev`. The application connects as
the restricted `bayan_spaces_app` account, not as MariaDB root.

Keep XAMPP MariaDB local to this computer. In `C:\xampp\mysql\bin\my.ini`, the
`[mysqld]` section must contain:

```ini
bind-address="127.0.0.1"
```

Restart MariaDB after changing this setting and confirm that port 3306 is not
listening on `0.0.0.0` or a LAN/VPN address.

First create the empty database and local-only account from an administrator
PowerShell session. Replace the example password and use the same value in
`.env`:

```powershell
& 'C:\xampp\mysql\bin\mysql.exe' --user=root --execute="CREATE DATABASE bayan_spaces_dev CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; CREATE USER 'bayan_spaces_app'@'localhost' IDENTIFIED BY 'REPLACE_WITH_LOCAL_PASSWORD';"
```

The schema is imported by an administrator:

```powershell
Get-Content -Raw .\database\schema.sql |
  & 'C:\xampp\mysql\bin\mysql.exe' --user=root bayan_spaces_dev
```

Grant only data access after the tables exist. Schema changes continue to run
through an administrator account; the application account receives no global,
create, alter, or drop privileges:

```powershell
$mysql = 'C:\xampp\mysql\bin\mysql.exe'
$tables = @(
  'companies', 'employees', 'users',
  'tenants', 'rooms', 'bookings', 'booking_settings',
  'google_oauth_credentials', 'booking_audit_log'
)
$grants = ($tables | ForEach-Object {
  "GRANT SELECT, INSERT, UPDATE, DELETE ON bayan_spaces_dev.$_ TO 'bayan_spaces_app'@'localhost'"
}) -join '; '
$grants += "; GRANT SELECT ON bayan_spaces_dev.schema_migrations TO 'bayan_spaces_app'@'localhost'"
$grants += "; GRANT SELECT, INSERT, UPDATE ON bayan_spaces_dev.migration_runs TO 'bayan_spaces_app'@'localhost'"
& $mysql --user=root --execute=$grants
```

Test the restricted application connection:

```powershell
npm.cmd run db:test
```

Apply any schema upgrades after pulling application changes. This command uses
the separate local administrator credentials and never runs during normal app
startup:

```powershell
npm.cmd run db:migrate
```

## Running the existing application

The application now requires MariaDB. It does not read, seed, or write
`data.json` during startup or API requests. Keep the verified JSON backups for
rollback and audit purposes.

```powershell
npm.cmd start
```

In a second terminal, for the LAN booking-only proxy:

```powershell
npm.cmd run start:booking
```

The core service checks the database before it starts. If MariaDB is stopped,
the schema is missing, or `.env` is incorrect, startup fails without falling
back to JSON.
