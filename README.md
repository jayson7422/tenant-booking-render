# Bayan Workforce

LAN attendance and payroll starter application for Philippine employers. It has admin, manager, and employee dashboards; editable employee records; a weekly employee schedule; attendance clock-in/out; and payroll calculation with statutory SSS, PhilHealth, Pag-IBIG and indicative withholding-tax deductions.

## Weekly schedule

The **Schedule** screen uses a people-by-week layout. Admins and managers can add, edit, delete, and copy shifts from the prior week; employees can view only their own published schedule. Each shift captures the date, start/end time, role, work site, status, and a visual card color.

## Tenant room booking

The tenant portal runs as a separate LAN service. Start these in **two separate PowerShell windows**:

```powershell
npm start
npm run start:booking
```

Tenants use `http://192.168.200.15:6500` and sign in with their email and access code. Port 6500 exposes only the tenant booking portal; the attendance application remains on port 5177.

Booking administrators use `http://192.168.200.15:6500/admin`. Sign in with a system **admin** account to manage tenants, rooms, allotted hours, bookings, and usage reports.

If other devices cannot open the portal, run this once in an **Administrator PowerShell** window to allow Private-network access:

```powershell
New-NetFirewallRule -DisplayName 'Bayan Spaces Tenant Booking (TCP 6500)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 6500 -Profile Private
```

The portal validates each room/date/time interval, shows remaining allotted hours before confirmation, and deducts confirmed booking time automatically. It also preserves an auditable booking history.

### Google Calendar setup

The app works locally immediately. To check and create events in your company Google Calendar, create a Google Cloud service account with the Calendar API enabled, share the calendar with that service-account email, then start the server with these environment variables:

```powershell
$env:GOOGLE_SERVICE_ACCOUNT_FILE = 'C:\secure\company-calendar-service-account.json'
$env:GOOGLE_CALENDAR_ID = 'your-company-calendar-id@group.calendar.google.com'
npm start
```

You may enter a different Google Calendar ID on a room record to give that room its own calendar. When configured, the app checks Google Calendar availability before confirmation and creates/deletes the corresponding calendar event.

### Usage-report email setup

To enable **Email report**, configure an SMTP account before starting the server:

```powershell
$env:SMTP_HOST = 'smtp.office365.com'
$env:SMTP_PORT = '465'
$env:SMTP_SECURE = 'true'
$env:SMTP_USER = 'bookings@yourcompany.com'
$env:SMTP_PASS = 'your-smtp-password-or-app-password'
$env:SMTP_FROM = 'bookings@yourcompany.com'
npm start
```

Use your mail provider’s approved SMTP port/security combination. The report is only sent when an administrator selects **Email report** for a tenant.

## Render deployment

`render.yaml` deploys the tenant booking application as a standalone Render web service. It uses `BOOKING_ONLY=true`, so the public service shows the tenant portal at `/` and booking administration at `/admin`—the attendance application is not exposed.

The Blueprint attaches a 1 GB persistent disk at `/var/data`; this is required because Render's normal filesystem is ephemeral. During the Blueprint setup, provide secure values for `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `GOOGLE_CALENDAR_ID`, and `GOOGLE_SERVICE_ACCOUNT_JSON`. Add SMTP variables only if usage-report email is needed.

## Start on the server computer

```powershell
npm start
```

Open `http://localhost:5177` on the server. Other devices on the same LAN use `http://SERVER-IP:5177` (for example `http://192.168.1.20:5177`). Allow Node.js through Windows Firewall on Private networks if prompted.

Seed accounts: `admin / admin123`, `manager / manager123`, `employee / employee123`. Change these before using real records.

## Payroll basis

The default model uses 2025 contribution baselines: SSS 15% (employee 5%, employer 10%) with MPF sharing above P20,000 MSC to P35,000; PhilHealth 5% split equally with P10,000–P100,000 bounds; and Pag-IBIG employee 1%/2% and employer 2%, capped at P5,000. Withholding uses an indicative TRAIN annual-bracket calculation and needs accountant review before production remittance.

Official references: [SSS](https://www.sss.gov.ph/pay-contribution/), [PhilHealth](https://www.philhealth.gov.ph/advisories/2025/PA2025-0002.pdf), [Pag-IBIG](https://www.pagibigfund.gov.ph/document/pdf/circulars/provident/HDMF%20Circular%20No.%20274%20-%20Revised%20Guidelines%20on%20Pag-IBIG%20Fund%20Membership.pdf).
