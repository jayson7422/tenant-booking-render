# Launchpad Tenant

Launchpad Tenant provides two booking features:

- Tenant self-booking: tenants sign in with the email and access code provided by an administrator, then book available rooms and manage their booking history.
- Booking administration: administrators manage tenants, access codes, rooms, bookings, Google Calendar integration, and usage reports.

The former attendance, payroll, employee, and scheduling workspace has been discontinued and is no longer part of the application.

## Local startup

Run the core application and tenant service in separate PowerShell windows:

```powershell
npm start
npm run start:booking
```

The default application URL opens the tenant self-booking login. The dedicated tenant service is available at `http://localhost:6500`; booking administration is available at `/admin`.

Accounts and tenant records are loaded from MariaDB/MySQL. Tenant access codes are stored as secure hashes.

## Google Calendar

Calendar integration is optional. Configure the following server-side values before using **Connect Google Calendar** in booking administration:

```powershell
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_OAUTH_REDIRECT_URI=http://localhost:6500/api/google/callback
GOOGLE_TOKEN_ENCRYPTION_KEY=...
```

## Usage-report email

Usage reports require SMTP configuration:

```powershell
$env:SMTP_HOST = 'smtp.office365.com'
$env:SMTP_PORT = '465'
$env:SMTP_SECURE = 'true'
$env:SMTP_USER = 'bookings@yourcompany.com'
$env:SMTP_PASS = 'your-smtp-password-or-app-password'
$env:SMTP_FROM = 'bookings@yourcompany.com'
npm start
```
