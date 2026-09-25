const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const repository = require('./src/repositories/applicationRepository');
const { testConnection, closePool } = require('./src/config/database');

const PORT = Number(process.env.PORT || 5177);
const PUBLIC = path.join(__dirname, 'public');

function sessionTokenHash(token) {
  return crypto
    .createHash('sha256')
    .update(String(token || ''))
    .digest('hex');
}
const tokenCache = { value: null, expiresAt: 0 };
const googleOAuthStates = new Map();

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');

  return `${salt}:${crypto
    .scryptSync(password, salt, 64)
    .toString('hex')}`;
}

function passwordMatches(password, encoded) {
  const [salt, digest] = String(encoded || '').split(':');

  if (!salt || !digest) {
    return false;
  }

  const candidate = crypto
    .scryptSync(password, salt, 64)
    .toString('hex');

  return crypto.timingSafeEqual(
    Buffer.from(candidate, 'hex'),
    Buffer.from(digest, 'hex')
  );
}

function weekStart(value = new Date()) {
  const d = new Date(
    typeof value === 'string'
      ? `${value}T12:00:00`
      : value
  );

  d.setDate(
    d.getDate() -
    ((d.getDay() + 6) % 7)
  );

  return d.toISOString().slice(0, 10);
}

function addDays(iso, count) {
  const d = new Date(`${iso}T12:00:00`);

  d.setDate(
    d.getDate() + count
  );

  return d.toISOString().slice(0, 10);
}

function id(prefix) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function body(req) {
  return new Promise((resolve, reject) => {
    let raw = '';

    req.on('data', chunk => {
      raw += chunk;
    });

    req.on('end', () => {
      try {
        resolve(
          raw
            ? JSON.parse(raw)
            : {}
        );
      } catch {
        reject(
          new Error('Invalid JSON')
        );
      }
    });
  });
}

function send(res, status, value) {
  res.writeHead(
    status,
    {
      'Content-Type': 'application/json'
    }
  );

  res.end(
    JSON.stringify(value)
  );
}

async function userFrom(req, data) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();

  if (!token) {
    return null;
  }

  const session = await repository.sessions.findUserSession(
    sessionTokenHash(token)
  );

  if (!session) {
    return null;
  }

  return data.users.find(
    user => user.id === session.userId
  ) || null;
}

function allow(user, roles) {
  return user &&
    roles.includes(user.role);
}

function publicUser(user, data) {
  const employee = data.employees.find(
    item => item.id === user.employeeId
  );

  return {
    id: user.id,
    username: user.username,
    role: user.role,
    employee
  };
}

function money(value) {
  return Math.round(
    (Number(value) || 0) * 100
  ) / 100;
}

function msc(salary) {
  return Math.min(
    35000,
    Math.max(
      5000,
      Math.round(
        Number(salary || 0) / 500
      ) * 500
    )
  );
}

function contributions(
  monthlySalary,
  frequency
) {
  const divisor =
    frequency === 'monthly'
      ? 1
      : 2;

  const base = msc(monthlySalary);

  const regular = Math.min(
    base,
    20000
  );

  const mpf = Math.max(
    0,
    base - 20000
  );

  const sssEmployee = money(
    (
      regular * 0.05 +
      mpf * 0.01
    ) / divisor
  );

  const sssEmployer = money(
    (
      regular * 0.10 +
      mpf * 0.02 +
      (
        base <= 14500
          ? 10
          : 30
      )
    ) / divisor
  );

  const philTotal = Math.min(
    5000,
    Math.max(
      500,
      Number(monthlySalary || 0) * 0.05
    )
  );

  const philEmployee = money(
    philTotal / 2 / divisor
  );

  const philEmployer =
    philEmployee;

  const pagibigBase = Math.min(
    5000,
    Number(monthlySalary || 0)
  );

  const pagibigEmployee = money(
    pagibigBase *
    (
      monthlySalary <= 1500
        ? 0.01
        : 0.02
    ) /
    divisor
  );

  const pagibigEmployer = money(
    pagibigBase *
    0.02 /
    divisor
  );

  return {
    sssEmployee,
    sssEmployer,
    philEmployee,
    philEmployer,
    pagibigEmployee,
    pagibigEmployer
  };
}

function withholdingTax(taxable) {
  const annual =
    taxable * 12;

  let tax = 0;

  if (annual > 8000000) {
    tax =
      2410000 +
      (
        annual - 8000000
      ) * 0.35;
  } else if (annual > 2000000) {
    tax =
      490000 +
      (
        annual - 2000000
      ) * 0.32;
  } else if (annual > 800000) {
    tax =
      130000 +
      (
        annual - 800000
      ) * 0.30;
  } else if (annual > 400000) {
    tax =
      22500 +
      (
        annual - 400000
      ) * 0.25;
  } else if (annual > 250000) {
    tax =
      (
        annual - 250000
      ) * 0.20;
  }

  return money(
    tax / 12
  );
}

function calculatePayroll(
  employee,
  input,
  frequency
) {
  const divisor =
    frequency === 'monthly'
      ? 1
      : 2;

  const basePay = money(
    employee.monthlySalary /
    divisor
  );

  const overtimePay = money(
    Number(
      input.overtimeHours || 0
    ) *
    (
      employee.monthlySalary /
      22 /
      8
    ) *
    1.25
  );

  const allowances = money(
    input.allowances
  );

  const absences = money(
    input.absenceDeduction
  );

  const grossPay = money(
    basePay +
    overtimePay +
    allowances -
    absences
  );

  const c = contributions(
    employee.monthlySalary,
    frequency
  );

  const taxable = Math.max(
    0,
    grossPay -
    c.sssEmployee -
    c.philEmployee -
    c.pagibigEmployee
  );

  const withholding = money(
    withholdingTax(
      taxable * divisor
    ) / divisor
  );

  const totalDeduction = money(
    c.sssEmployee +
    c.philEmployee +
    c.pagibigEmployee +
    withholding +
    Number(
      input.otherDeductions || 0
    )
  );

  return {
    basePay,
    overtimePay,
    allowances,
    absenceDeduction: absences,
    grossPay,
    ...c,
    withholding,
    totalDeduction,

    netPay: money(
      grossPay -
      totalDeduction
    ),

    employerCost: money(
      grossPay +
      c.sssEmployer +
      c.philEmployer +
      c.pagibigEmployer
    )
  };
}

async function tenantFrom(req, data) {
  const token = String(req.headers['x-tenant-token'] || '').trim();

  if (!token) {
    return null;
  }

  const session = await repository.sessions.findTenantSession(
    sessionTokenHash(token)
  );

  if (!session) {
    return null;
  }

  return data.tenants.find(
    tenant =>
      tenant.id === session.tenantId &&
      tenant.status === 'Active'
  ) || null;
}

function cleanTenant(tenant) {
  return {
    id: tenant.id,
    fullName: tenant.fullName,
    companyName: tenant.companyName,
    email: tenant.email,
    location: tenant.location,

    allottedHours: Number(
      tenant.allottedHours || 0
    ),

    status: tenant.status
  };
}

function bookingHours(
  startTime,
  endTime
) {
  const toMinutes = value => {
    const match =
      /^(\d{2}):(\d{2})$/.exec(
        value || ''
      );

    return match
      ? Number(match[1]) * 60 +
        Number(match[2])
      : NaN;
  };

  const hours =
    (
      toMinutes(endTime) -
      toMinutes(startTime)
    ) / 60;

  return (
    Number.isFinite(hours) &&
    hours > 0 &&
    hours <= 24
  )
    ? money(hours)
    : 0;
}

function bookedHours(
  data,
  tenantId
) {
  return money(
    data.bookings
      .filter(
        booking =>
          booking.tenantId ===
            tenantId &&
          booking.status ===
            'Confirmed'
      )
      .reduce(
        (
          total,
          booking
        ) =>
          total +
          Number(
            booking.hours || 0
          ),
        0
      )
  );
}

function tenantRemaining(
  data,
  tenant
) {
  return money(
    Number(
      tenant.allottedHours || 0
    ) -
    bookedHours(
      data,
      tenant.id
    )
  );
}

function bookingConflict(
  data,
  roomId,
  date,
  startTime,
  endTime,
  exceptId
) {
  const start =
    `${date}T${startTime}`;

  const end =
    `${date}T${endTime}`;

  return data.bookings.find(
    booking =>
      booking.id !== exceptId &&
      booking.roomId === roomId &&
      booking.date === date &&
      booking.status === 'Confirmed' &&
      `${booking.date}T${booking.startTime}` <
        end &&
      `${booking.date}T${booking.endTime}` >
        start
  );
}

function timeToMinutes(time) {
  const match =
    /^(\d{2}):(\d{2})$/.exec(
      time || ''
    );

  return match
    ? Number(match[1]) * 60 +
      Number(match[2])
    : NaN;
}

function minutesToTime(minutes) {
  return `${
    String(
      Math.floor(
        minutes / 60
      )
    ).padStart(2, '0')
  }:${
    String(
      minutes % 60
    ).padStart(2, '0')
  }`;
}

function bookingDateAfter(
  date,
  days
) {
  const value = new Date(
    `${date}T12:00:00+08:00`
  );

  value.setUTCDate(
    value.getUTCDate() +
    days
  );

  return value
    .toISOString()
    .slice(0, 10);
}

function overlapsGoogleBusy(
  date,
  startTime,
  endTime,
  busy
) {
  const start = new Date(
    bookingDateTime(
      date,
      startTime
    )
  ).getTime();

  const end = new Date(
    bookingDateTime(
      date,
      endTime
    )
  ).getTime();

  return busy.some(
    period =>
      new Date(
        period.start
      ).getTime() < end &&
      new Date(
        period.end
      ).getTime() > start
  );
}

function oauthEncryptionKey() {
  const secret =
    process.env
      .GOOGLE_TOKEN_ENCRYPTION_KEY;

  return secret
    ? crypto
      .createHash('sha256')
      .update(secret)
      .digest()
    : null;
}

function encryptOAuthToken(token) {
  const key =
    oauthEncryptionKey();

  if (!key) {
    throw Error(
      'Google OAuth needs GOOGLE_TOKEN_ENCRYPTION_KEY'
    );
  }

  const iv =
    crypto.randomBytes(12);

  const cipher =
    crypto.createCipheriv(
      'aes-256-gcm',
      key,
      iv
    );

  const encrypted =
    Buffer.concat([
      cipher.update(
        token,
        'utf8'
      ),
      cipher.final()
    ]);

  const tag =
    cipher.getAuthTag();

  return `${
    iv.toString('base64url')
  }.${
    tag.toString('base64url')
  }.${
    encrypted.toString(
      'base64url'
    )
  }`;
}

function decryptOAuthToken(value) {
  try {
    const key =
      oauthEncryptionKey();

    const parts =
      String(value || '')
        .split('.');

    if (
      !key ||
      parts.length !== 3
    ) {
      return null;
    }

    const [
      iv,
      tag,
      encrypted
    ] = parts.map(
      value =>
        Buffer.from(
          value,
          'base64url'
        )
    );

    const decipher =
      crypto.createDecipheriv(
        'aes-256-gcm',
        key,
        iv
      );

    decipher.setAuthTag(tag);

    return Buffer.concat([
      decipher.update(
        encrypted
      ),
      decipher.final()
    ]).toString('utf8');

  } catch {
    return null;
  }
}

function googleOAuthSettings() {
  const clientId =
    process.env
      .GOOGLE_OAUTH_CLIENT_ID;

  const clientSecret =
    process.env
      .GOOGLE_OAUTH_CLIENT_SECRET;

  const redirectUri =
    process.env
      .GOOGLE_OAUTH_REDIRECT_URI;

  return (
    clientId &&
    clientSecret &&
    redirectUri
  )
    ? {
      clientId,
      clientSecret,
      redirectUri
    }
    : null;
}

function googleConfiguration(
  data,
  room
) {
  const calendarId =
    room?.calendarId ||
    process.env.GOOGLE_CALENDAR_ID ||
    'primary';

  const oauth =
    googleOAuthSettings();

  const refreshToken =
    oauth &&
    decryptOAuthToken(
      data.googleOAuth
        ?.refreshTokenEncrypted
    );

  if (
    oauth &&
    refreshToken
  ) {
    return {
      provider: 'oauth',
      ...oauth,
      refreshToken,
      calendarId
    };
  }

  let serviceAccount;

  try {
    const raw =
      process.env
        .GOOGLE_SERVICE_ACCOUNT_JSON ||
      (
        process.env
          .GOOGLE_SERVICE_ACCOUNT_FILE &&
        fs.readFileSync(
          process.env
            .GOOGLE_SERVICE_ACCOUNT_FILE,
          'utf8'
        )
      );

    serviceAccount =
      raw &&
      JSON.parse(raw);

  } catch {
    serviceAccount = null;
  }

  return (
    serviceAccount?.client_email &&
    serviceAccount?.private_key &&
    calendarId
  )
    ? {
      provider:
        'service-account',
      serviceAccount,
      calendarId
    }
    : null;
}

function googleOAuthStatus(data) {
  const settings =
    googleOAuthSettings();

  const connected =
    Boolean(
      settings &&
      decryptOAuthToken(
        data.googleOAuth
          ?.refreshTokenEncrypted
      )
    );

  return {
    configured:
      Boolean(
        settings &&
        oauthEncryptionKey()
      ),

    connected,

    provider:
      connected
        ? 'oauth'
        : (
          googleConfiguration(data)
            ? 'service-account'
            : null
        )
  };
}

function googleOAuthAuthorizationUrl() {
  const settings =
    googleOAuthSettings();

  if (
    !settings ||
    !oauthEncryptionKey()
  ) {
    throw Error(
      'Google OAuth is not configured. Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URI, and GOOGLE_TOKEN_ENCRYPTION_KEY.'
    );
  }

  const state =
    crypto
      .randomBytes(32)
      .toString('base64url');

  googleOAuthStates.set(
    state,
    Date.now() +
    10 * 60 * 1000
  );

  for (
    const [
      key,
      expiresAt
    ] of googleOAuthStates
  ) {
    if (
      expiresAt <
      Date.now()
    ) {
      googleOAuthStates.delete(
        key
      );
    }
  }

  const query =
    new URLSearchParams({
      client_id:
        settings.clientId,

      redirect_uri:
        settings.redirectUri,

      response_type: 'code',

      scope:
        'https://www.googleapis.com/auth/calendar',

      access_type:
        'offline',

      prompt:
        'consent',

      state
    });

  return (
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    query
  );
}

async function completeGoogleOAuth(
  code,
  state
) {
  const expiresAt =
    googleOAuthStates.get(
      state
    );

  googleOAuthStates.delete(
    state
  );

  if (
    !expiresAt ||
    expiresAt <
    Date.now()
  ) {
    throw Error(
      'Google authorization expired. Start the connection again from Booking administration.'
    );
  }

  const settings =
    googleOAuthSettings();

  if (
    !settings ||
    !oauthEncryptionKey()
  ) {
    throw Error(
      'Google OAuth is not configured.'
    );
  }

  const response =
    await fetch(
      'https://oauth2.googleapis.com/token',
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/x-www-form-urlencoded'
        },

        body:
          new URLSearchParams({
            code,

            client_id:
              settings.clientId,

            client_secret:
              settings.clientSecret,

            redirect_uri:
              settings.redirectUri,

            grant_type:
              'authorization_code'
          })
      }
    );

  if (!response.ok) {
    throw Error(
      'Google Calendar authorization could not be completed.'
    );
  }

  const result =
    await response.json();

  if (
    !result.refresh_token
  ) {
    throw Error(
      'Google did not return a refresh token. Reconnect and approve access again.'
    );
  }

  await repository
    .integrations
    .saveGoogleOAuth(
      encryptOAuthToken(
        result.refresh_token
      ),
      new Date()
        .toISOString()
    );

  tokenCache.value =
    null;

  tokenCache.expiresAt =
    0;
}

function b64(value) {
  return Buffer
    .from(
      typeof value === 'string'
        ? value
        : JSON.stringify(
          value
        )
    )
    .toString(
      'base64url'
    );
}

async function googleToken(
  config
) {
  if (
    tokenCache.value &&
    tokenCache.expiresAt >
      Date.now() + 60000
  ) {
    return tokenCache.value;
  }

  let response;

  if (
    config.provider === 'oauth'
  ) {
    response =
      await fetch(
        'https://oauth2.googleapis.com/token',
        {
          method: 'POST',

          headers: {
            'Content-Type':
              'application/x-www-form-urlencoded'
          },

          body:
            new URLSearchParams({
              client_id:
                config.clientId,

              client_secret:
                config.clientSecret,

              refresh_token:
                config.refreshToken,

              grant_type:
                'refresh_token'
            })
        }
      );

    if (!response.ok) {
      throw Error(
        'Google Calendar authorization has expired. Reconnect Google Calendar in Booking administration.'
      );
    }

  } else {
    const now =
      Math.floor(
        Date.now() / 1000
      );

    const account =
      config.serviceAccount;

    const payload = {
      iss:
        account.client_email,

      scope:
        'https://www.googleapis.com/auth/calendar',

      aud:
        account.token_uri ||
        'https://oauth2.googleapis.com/token',

      iat:
        now,

      exp:
        now + 3600
    };

    const unsigned =
      `${b64({
        alg: 'RS256',
        typ: 'JWT'
      })}.${b64(payload)}`;

    const signer =
      crypto.createSign(
        'RSA-SHA256'
      );

    signer.update(unsigned);

    const assertion =
      `${unsigned}.${
        signer.sign(
          account.private_key,
          'base64url'
        )
      }`;

    response =
      await fetch(
        payload.aud,
        {
          method: 'POST',

          headers: {
            'Content-Type':
              'application/x-www-form-urlencoded'
          },

          body:
            new URLSearchParams({
              grant_type:
                'urn:ietf:params:oauth:grant-type:jwt-bearer',

              assertion
            })
        }
      );

    if (!response.ok) {
      throw Error(
        'Google Calendar authentication failed'
      );
    }
  }

  const result =
    await response.json();

  tokenCache.value =
    result.access_token;

  tokenCache.expiresAt =
    Date.now() +
    (
      Number(
        result.expires_in ||
        3600
      ) *
      1000
    );

  return tokenCache.value;
}

function bookingDateTime(
  date,
  time
) {
  return `${date}T${time}:00+08:00`;
}

async function googleBusyPeriods(
  data,
  room,
  date,
  startTime,
  endTime
) {
  const config =
    googleConfiguration(
      data,
      room
    );

  if (!config) {
    return {
      enabled: false,
      busy: []
    };
  }

  const token =
    await googleToken(
      config
    );

  const response =
    await fetch(
      'https://www.googleapis.com/calendar/v3/freeBusy',
      {
        method: 'POST',

        headers: {
          Authorization:
            `Bearer ${token}`,

          'Content-Type':
            'application/json'
        },

        body:
          JSON.stringify({
            timeMin:
              new Date(
                bookingDateTime(
                  date,
                  startTime
                )
              ).toISOString(),

            timeMax:
              new Date(
                bookingDateTime(
                  date,
                  endTime
                )
              ).toISOString(),

            items: [
              {
                id:
                  config.calendarId
              }
            ]
          })
      }
    );

  if (!response.ok) {
    throw Error(
      'Google Calendar availability check failed'
    );
  }

  const payload =
    await response.json();

  const calendar =
    payload.calendars
      ?.[config.calendarId];

  if (
    !calendar ||
    calendar.errors?.length
  ) {
    throw Error(
      'Google Calendar cannot access this room calendar. Check the configured Calendar ID.'
    );
  }

  return {
    enabled: true,
    busy:
      calendar.busy || []
  };
}

async function googleAvailability(
  data,
  room,
  booking
) {
  const calendar =
    await googleBusyPeriods(
      data,
      room,
      booking.date,
      booking.startTime,
      booking.endTime
    );

  return {
    enabled:
      calendar.enabled,

    busy:
      calendar.busy.length > 0
  };
}

async function availabilitySuggestions(
  data,
  room,
  booking
) {
  const duration =
    timeToMinutes(
      booking.endTime
    ) -
    timeToMinutes(
      booking.startTime
    );

  const suggestions = [];

  if (
    !Number.isFinite(duration) ||
    duration <= 0
  ) {
    return suggestions;
  }

  for (
    let dayOffset = 0;
    dayOffset < 3 &&
    suggestions.length < 3;
    dayOffset++
  ) {
    const date =
      bookingDateAfter(
        booking.date,
        dayOffset
      );

    const calendar =
      await googleBusyPeriods(
        data,
        room,
        date,
        '08:00',
        '18:00'
      );

    const firstMinute =
      dayOffset === 0
        ? Math.max(
          8 * 60,
          timeToMinutes(
            booking.endTime
          )
        )
        : 8 * 60;

    for (
      let start =
        Math.ceil(
          firstMinute / 30
        ) * 30;

      start + duration <=
        18 * 60 &&
      suggestions.length < 3;

      start += 30
    ) {
      const startTime =
        minutesToTime(
          start
        );

      const endTime =
        minutesToTime(
          start + duration
        );

      if (
        bookingConflict(
          data,
          room.id,
          date,
          startTime,
          endTime
        ) ||
        overlapsGoogleBusy(
          date,
          startTime,
          endTime,
          calendar.busy
        )
      ) {
        continue;
      }

      suggestions.push({
        date,
        startTime,
        endTime
      });
    }
  }

  return suggestions;
}

async function createCalendarEvent(
  data,
  room,
  tenant,
  booking,
  timezone
) {
  const config =
    googleConfiguration(
      data,
      room
    );

  if (!config) {
    return null;
  }

  const token =
    await googleToken(
      config
    );

  const response =
    await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${
        encodeURIComponent(
          config.calendarId
        )
      }/events`,
      {
        method: 'POST',

        headers: {
          Authorization:
            `Bearer ${token}`,

          'Content-Type':
            'application/json'
        },

        body:
          JSON.stringify({
            summary:
              `${
                room.name
              } — ${
                tenant.companyName ||
                tenant.fullName
              }`,

            description:
              `Tenant: ${tenant.fullName}\n` +
              `Company: ${tenant.companyName || '—'}\n` +
              `Email: ${tenant.email}\n` +
              `Location: ${tenant.location}`,

            start: {
              dateTime:
                bookingDateTime(
                  booking.date,
                  booking.startTime
                ),

              timeZone:
                timezone
            },

            end: {
              dateTime:
                bookingDateTime(
                  booking.date,
                  booking.endTime
                ),

              timeZone:
                timezone
            }
          })
      }
    );

  if (!response.ok) {
    throw Error(
      'Google Calendar event could not be created'
    );
  }

  return (
    await response.json()
  ).id;
}

async function deleteCalendarEvent(
  data,
  room,
  eventId
) {
  const config =
    googleConfiguration(
      data,
      room
    );

  if (
    !config ||
    !eventId
  ) {
    return;
  }

  const token =
    await googleToken(
      config
    );

  const response =
    await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${
        encodeURIComponent(
          config.calendarId
        )
      }/events/${
        encodeURIComponent(
          eventId
        )
      }`,
      {
        method: 'DELETE',

        headers: {
          Authorization:
            `Bearer ${token}`
        }
      }
    );

  if (
    !response.ok &&
    response.status !== 404
  ) {
    throw Error(
      'Google Calendar event could not be deleted'
    );
  }
}

function usageReport(
  data,
  tenant
) {
  const bookings =
    data.bookings
      .filter(
        booking =>
          booking.tenantId ===
            tenant.id &&
          booking.status ===
            'Confirmed'
      )
      .sort(
        (left, right) =>
          `${
            left.date
          }${
            left.startTime
          }`.localeCompare(
            `${
              right.date
            }${
              right.startTime
            }`
          )
      );

  const lines =
    bookings.map(
      booking => {
        const room =
          data.rooms.find(
            item =>
              item.id ===
              booking.roomId
          );

        return (
          `• ${booking.date}, ` +
          `${booking.startTime}–${booking.endTime} — ` +
          `${room?.name || 'Room'} ` +
          `(${Number(booking.hours).toFixed(1)} h)`
        );
      }
    );

  return {
    subject:
      `Your room usage report — ${data.company.name}`,

    text:
      `Hello ${tenant.fullName},\n\n` +
      `Company: ${tenant.companyName || '—'}\n` +
      `Allotted hours: ${Number(tenant.allottedHours).toFixed(1)}\n` +
      `Hours used: ${bookedHours(data, tenant.id).toFixed(1)}\n` +
      `Hours remaining: ${tenantRemaining(data, tenant).toFixed(1)}\n\n` +
      `Bookings:\n` +
      `${lines.join('\n') || 'No confirmed bookings yet.'}\n\n` +
      `${data.company.name}`
  };
}

async function sendUsageEmail(
  data,
  tenant
) {
  if (
    !process.env.SMTP_HOST ||
    !process.env.SMTP_USER ||
    !process.env.SMTP_PASS ||
    !process.env.SMTP_FROM
  ) {
    throw Error(
      'SMTP is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS, and SMTP_FROM on the server.'
    );
  }

  const report =
    usageReport(
      data,
      tenant
    );

  const transport =
    nodemailer.createTransport({
      host:
        process.env.SMTP_HOST,

      port:
        Number(
          process.env.SMTP_PORT ||
          465
        ),

      secure:
        process.env.SMTP_SECURE !==
        'false',

      auth: {
        user:
          process.env.SMTP_USER,

        pass:
          process.env.SMTP_PASS
      }
    });

  await transport.sendMail({
    from:
      process.env.SMTP_FROM,

    to:
      tenant.email,

    subject:
      report.subject,

    text:
      report.text
  });

  return report;
}

function serveFile(
  res,
  pathname
) {
  const bookingFiles = {
    '/':
      'booking.html',

    '/booking':
      'booking.html',

    '/admin':
      'booking-admin.html',

    '/booking.css':
      'booking.css',

    '/booking.js':
      'booking.js',

    '/booking-admin.css':
      'booking-admin.css',

    '/booking-admin.js':
      'booking-admin.js',

    '/google-oauth.js':
      'google-oauth.js'
  };

  let file;

  if (
    process.env.BOOKING_ONLY ===
    'true'
  ) {
    file =
      bookingFiles[pathname];

  } else if (
    pathname === '/booking'
  ) {
    file =
      'booking.html';

  } else if (
    pathname === '/admin'
  ) {
    file =
      'booking-admin.html';

  } else {
    file =
      pathname === '/'
        ? 'index.html'
        : pathname.slice(1);
  }

  if (!file) {
    return send(
      res,
      404,
      {
        error:
          'Not found'
      }
    );
  }

  file =
    path
      .normalize(file)
      .replace(
        /^([.][.][\\/])+/,
        ''
      );

  const target =
    path.join(
      PUBLIC,
      file
    );

  if (
    !target.startsWith(
      PUBLIC
    ) ||
    !fs.existsSync(
      target
    )
  ) {
    return send(
      res,
      404,
      {
        error:
          'Not found'
      }
    );
  }

  const ext =
    path.extname(
      target
    );

  const types = {
    '.html':
      'text/html',

    '.js':
      'text/javascript',

    '.css':
      'text/css'
  };

  res.writeHead(
    200,
    {
      'Content-Type':
        types[ext] ||
        'application/octet-stream'
    }
  );

  fs
    .createReadStream(
      target
    )
    .pipe(res);
}

const server =
  http.createServer(
    async (
      req,
      res
    ) => {
      const url =
        new URL(
          req.url,
          `http://${req.headers.host}`
        );

      try {
        if (
          req.method ===
            'GET' &&
          url.pathname ===
            '/health'
        ) {
          return send(
            res,
            200,
            {
              ok: true,

              service:
                process.env
                  .BOOKING_ONLY ===
                'true'
                  ? 'tenant-booking'
                  : 'bayan-workforce',

              persistence:
                'mariadb'
            }
          );
        }

        if (
          req.method ===
            'GET' &&
          url.pathname ===
            '/api/google/callback'
        ) {
          const error =
            url.searchParams.get(
              'error'
            );

          const code =
            url.searchParams.get(
              'code'
            );

          const state =
            url.searchParams.get(
              'state'
            );

          if (error) {
            throw Error(
              `Google authorization was not completed: ${error}`
            );
          }

          if (
            !code ||
            !state
          ) {
            throw Error(
              'Google authorization response is incomplete.'
            );
          }

          await completeGoogleOAuth(
            code,
            state
          );

          res.writeHead(
            302,
            {
              Location:
                '/admin?google=connected'
            }
          );

          return res.end();
        }

        const data =
          await repository
            .getSnapshot();

        if (
          req.method ===
            'POST' &&
          url.pathname ===
            '/api/login'
        ) {
          const input =
            await body(req);

          const user =
            data.users.find(
              item =>
                item.username ===
                  input.username &&
                passwordMatches(
                  input.password,
                  item.passwordHash
                )
            );

          if (!user) {
            return send(
              res,
              401,
              {
                error:
                  'Incorrect username or password'
              }
            );
          }

        const token = crypto.randomUUID();

        const expiresAt = new Date(
          Date.now() + 8 * 60 * 60 * 1000
        );

        await repository.sessions.createUserSession(
          sessionTokenHash(token),
          user.id,
          expiresAt.toISOString()
        );

        return send(
          res,
          200,
          {
            token,
            user: publicUser(user, data)
          }
        );
        }

        if (
          req.method ===
            'POST' &&
          url.pathname ===
            '/api/tenant/login'
        ) {
          const input =
            await body(req);

          const tenant =
            data.tenants.find(
              item =>
                item.status ===
                  'Active' &&

                item.email
                  .toLowerCase() ===
                  String(
                    input.email ||
                    ''
                  )
                    .trim()
                    .toLowerCase() &&

                passwordMatches(
                  String(
                    input.accessCode ||
                    ''
                  ),

                  item.accessCodeHash
                )
            );

          if (!tenant) {
            return send(
              res,
              401,
              {
                error:
                  'Email or access code is incorrect'
              }
            );
          }

          const token = crypto.randomUUID();

          const expiresAt = new Date(
            Date.now() + 8 * 60 * 60 * 1000
          );

          await repository.sessions.createTenantSession(
            sessionTokenHash(token),
            tenant.id,
            expiresAt.toISOString()
          );

          return send(
            res,
            200,
            {
              token,

              tenant: {
                ...cleanTenant(
                  tenant
                ),

                remainingHours:
                  tenantRemaining(
                    data,
                    tenant
                  )
              }
            }
          );
        }

        if (
          url.pathname
            .startsWith(
              '/api/tenant/'
            )
        ) {
          const tenant = await tenantFrom(
            req,
            data
          );
          if (!tenant) {
            return send(
              res,
              401,
              {
                error:
                  'Please sign in to the tenant portal'
              }
            );
          }

          const enriched =
            data.bookings
              .filter(
                booking =>
                  booking.tenantId ===
                  tenant.id
              )
              .sort(
                (
                  left,
                  right
                ) =>
                  `${
                    right.date
                  }${
                    right.startTime
                  }`
                    .localeCompare(
                      `${
                        left.date
                      }${
                        left.startTime
                      }`
                    )
              )
              .map(
                booking => ({
                  ...booking,

                  room:
                    data.rooms.find(
                      room =>
                        room.id ===
                        booking.roomId
                    )
                })
              );

          if (
            req.method ===
              'GET' &&
            url.pathname ===
              '/api/tenant/me'
          ) {
            return send(
              res,
              200,
              {
                tenant: {
                  ...cleanTenant(
                    tenant
                  ),

                  remainingHours:
                    tenantRemaining(
                      data,
                      tenant
                    )
                },

                rooms:
                  data.rooms,

                bookings:
                  enriched,

                calendarConnected:
                  Boolean(
                    googleConfiguration(
                      data
                    )
                  )
              }
            );
          }

          if (
            req.method ===
              'GET' &&
            url.pathname ===
              '/api/tenant/availability'
          ) {
            const room =
              data.rooms.find(
                item =>
                  item.id ===
                  url.searchParams.get(
                    'roomId'
                  )
              );

            const booking = {
              date:
                url.searchParams.get(
                  'date'
                ),

              startTime:
                url.searchParams.get(
                  'startTime'
                ),

              endTime:
                url.searchParams.get(
                  'endTime'
                )
            };

            const hours =
              bookingHours(
                booking.startTime,
                booking.endTime
              );

            if (
              !room ||
              !/^\d{4}-\d{2}-\d{2}$/
                .test(
                  booking.date ||
                  ''
                ) ||
              !hours
            ) {
              return send(
                res,
                400,
                {
                  error:
                    'Choose a room, valid date, and valid start/end times'
                }
              );
            }

            const conflict =
              bookingConflict(
                data,
                room.id,
                booking.date,
                booking.startTime,
                booking.endTime
              );

            if (conflict) {
              const suggestions =
                await availabilitySuggestions(
                  data,
                  room,
                  booking
                );

              return send(
                res,
                200,
                {
                  available:
                    false,

                  reason:
                    'This room already has a booking during the selected time.',

                  remainingHours:
                    tenantRemaining(
                      data,
                      tenant
                    ),

                  hours,

                  suggestions,

                  calendarChecked:
                    Boolean(
                      googleConfiguration(
                        data,
                        room
                      )
                    )
                }
              );
            }

            const google =
              await googleAvailability(
                data,
                room,
                booking
              );

            const suggestions =
              google.busy
                ? await availabilitySuggestions(
                  data,
                  room,
                  booking
                )
                : [];

            return send(
              res,
              200,
              {
                available:
                  !google.busy,

                reason:
                  google.busy
                    ? 'This room is busy in Google Calendar.'
                    : undefined,

                remainingHours:
                  tenantRemaining(
                    data,
                    tenant
                  ),

                hours,

                calendarChecked:
                  google.enabled,

                suggestions
              }
            );
          }

          const cancellationMatch =
            url.pathname.match(
              /^\/api\/tenant\/bookings\/([^/]+)\/cancel$/
            );

          if (
            cancellationMatch &&
            req.method ===
              'POST'
          ) {
            const booking =
              data.bookings.find(
                item =>
                  item.id ===
                    cancellationMatch[1] &&
                  item.tenantId ===
                    tenant.id
              );

            if (!booking) {
              return send(
                res,
                404,
                {
                  error:
                    'Booking not found'
                }
              );
            }

            if (
              booking.status !==
              'Confirmed'
            ) {
              return send(
                res,
                409,
                {
                  error:
                    'Only confirmed bookings can be cancelled'
                }
              );
            }

            const details =
              await body(req);

            const remark =
              String(
                details.remark ||
                ''
              ).trim();

            if (!remark) {
              return send(
                res,
                400,
                {
                  error:
                    'Please provide a cancellation remark'
                }
              );
            }

            const room =
              data.rooms.find(
                item =>
                  item.id ===
                  booking.roomId
              );

            await deleteCalendarEvent(
              data,
              room,
              booking.calendarEventId
            );

            await repository
              .bookings
              .cancel(
                booking.id,
                tenant.id,
                remark,
                new Date()
                  .toISOString()
              );

            return send(
              res,
              200,
              {
                booking: {
                  ...booking,

                  status:
                    'Cancelled',

                  cancellationRemark:
                    remark,

                  calendarEventId:
                    null,

                  room
                },

                remainingHours:
                  money(
                    tenantRemaining(
                      data,
                      tenant
                    ) +
                    Number(
                      booking.hours
                    )
                  )
              }
            );
          }

          if (
            req.method ===
              'POST' &&
            url.pathname ===
              '/api/tenant/bookings'
          ) {
            const input =
              await body(req);

            const room =
              data.rooms.find(
                item =>
                  item.id ===
                  input.roomId
              );

            const hours =
              bookingHours(
                input.startTime,
                input.endTime
              );

            if (
              !room ||
              !/^\d{4}-\d{2}-\d{2}$/
                .test(
                  input.date ||
                  ''
                ) ||
              !hours
            ) {
              return send(
                res,
                400,
                {
                  error:
                    'Choose a room, valid date, and valid start/end times'
                }
              );
            }

            if (
              tenantRemaining(
                data,
                tenant
              ) < hours
            ) {
              return send(
                res,
                400,
                {
                  error:
                    `Only ${
                      tenantRemaining(
                        data,
                        tenant
                      ).toFixed(1)
                    } allotted hours remain.`
                }
              );
            }

            if (
              bookingConflict(
                data,
                room.id,
                input.date,
                input.startTime,
                input.endTime
              )
            ) {
              return send(
                res,
                409,
                {
                  error:
                    'This room has just been booked for that time. Please choose another time.'
                }
              );
            }

            const booking = {
              id:
                id('b'),

              tenantId:
                tenant.id,

              tenantName:
                tenant.fullName,

              companyName:
                tenant.companyName,

              roomId:
                room.id,

              roomName:
                room.name,

              date:
                input.date,

              startTime:
                input.startTime,

              endTime:
                input.endTime,

              hours,

              status:
                'Confirmed',

              createdAt:
                new Date()
                  .toISOString(),

              calendarEventId:
                null
            };

            const google =
              await googleAvailability(
                data,
                room,
                booking
              );

            if (google.busy) {
              return send(
                res,
                409,
                {
                  error:
                    'This room is busy in Google Calendar. Please choose another time.'
                }
              );
            }

            const result =
              await repository
                .bookings
                .createConfirmed(
                  booking
                );

            try {
              booking.calendarEventId =
                await createCalendarEvent(
                  data,
                  room,
                  tenant,
                  booking,
                  data.bookingSettings
                    .timezone ||
                  'Asia/Manila'
                );

              if (
                booking.calendarEventId
              ) {
                await repository
                  .bookings
                  .setCalendarEvent(
                    booking.id,
                    booking.calendarEventId
                  );
              }

            } catch (error) {
              await repository
                .bookings
                .remove(
                  booking.id
                );

              throw error;
            }

            return send(
              res,
              201,
              {
                booking: {
                  ...booking,
                  room
                },

                remainingHours:
                  result.remainingHours,

                calendarSynced:
                  Boolean(
                    booking.calendarEventId
                  )
              }
            );
          }

          return send(
            res,
            404,
            {
              error:
                'Tenant portal route not found'
            }
          );
        }

        if (
          url.pathname
            .startsWith('/api/')
        ) {
        const user = await userFrom(
          req,
          data
        );

          if (!user) {
            return send(
              res,
              401,
              {
                error:
                  'Please sign in'
              }
            );
          }

          if (
            req.method ===
              'GET' &&
            url.pathname ===
              '/api/google/status'
          ) {
            if (
              !allow(
                user,
                ['admin']
              )
            ) {
              return send(
                res,
                403,
                {
                  error:
                    'Only admins can manage Google Calendar'
                }
              );
            }

            return send(
              res,
              200,
              googleOAuthStatus(
                data
              )
            );
          }

          if (
            req.method ===
              'POST' &&
            url.pathname ===
              '/api/google/authorize'
          ) {
            if (
              !allow(
                user,
                ['admin']
              )
            ) {
              return send(
                res,
                403,
                {
                  error:
                    'Only admins can manage Google Calendar'
                }
              );
            }

            return send(
              res,
              200,
              {
                url:
                  googleOAuthAuthorizationUrl()
              }
            );
          }

          if (
            req.method ===
              'GET' &&
            url.pathname ===
              '/api/me'
          ) {
            return send(
              res,
              200,
              publicUser(
                user,
                data
              )
            );
          }

          if (
            req.method ===
              'GET' &&
            url.pathname ===
              '/api/dashboard'
          ) {
            const own =
              data.attendance.filter(
                record =>
                  record.employeeId ===
                  user.employeeId
              );

            return send(
              res,
              200,
              {
                employees:
                  data.employees
                    .filter(
                      employee =>
                        employee.status ===
                        'Active'
                    )
                    .length,

                present:
                  data.attendance
                    .filter(
                      record =>
                        record.date ===
                          new Date()
                            .toISOString()
                            .slice(0, 10) &&
                        record.timeIn
                    )
                    .length,

                ownAttendance:
                  own
                    .slice(-8)
                    .reverse(),

                ownPayrolls:
                  data.payrolls
                    .filter(
                      payroll =>
                        payroll.employeeId ===
                        user.employeeId
                    )
                    .slice(-5)
                    .reverse(),

                recentPayrolls:
                  data.payrolls
                    .slice(-5)
                    .reverse()
              }
            );
          }

          if (
            req.method ===
              'GET' &&
            url.pathname ===
              '/api/booking-admin'
          ) {
            if (
              !allow(
                user,
                ['admin']
              )
            ) {
              return send(
                res,
                403,
                {
                  error:
                    'Only admins can manage tenant bookings'
                }
              );
            }

            return send(
              res,
              200,
              {
                tenants:
                  data.tenants.map(
                    tenant => ({
                      ...cleanTenant(
                        tenant
                      ),

                      usedHours:
                        bookedHours(
                          data,
                          tenant.id
                        ),

                      remainingHours:
                        tenantRemaining(
                          data,
                          tenant
                        )
                    })
                  ),

                rooms:
                  data.rooms,

                bookings:
                  data.bookings
                    .map(
                      booking => ({
                        ...booking,

                        tenant:
                          data.tenants.find(
                            tenant =>
                              tenant.id ===
                              booking.tenantId
                          )
                            ? cleanTenant(
                              data.tenants.find(
                                tenant =>
                                  tenant.id ===
                                  booking.tenantId
                              )
                            )
                            : null,

                        room:
                          data.rooms.find(
                            room =>
                              room.id ===
                              booking.roomId
                          )
                      })
                    )
                    .sort(
                      (
                        left,
                        right
                      ) =>
                        `${
                          right.date
                        }${
                          right.startTime
                        }`
                          .localeCompare(
                            `${
                              left.date
                            }${
                              left.startTime
                            }`
                          )
                    ),

                calendarConnected:
                  Boolean(
                    googleConfiguration(
                      data
                    )
                  ),

                emailConfigured:
                  Boolean(
                    process.env
                      .SMTP_HOST &&
                    process.env
                      .SMTP_USER &&
                    process.env
                      .SMTP_PASS &&
                    process.env
                      .SMTP_FROM
                  )
              }
            );
          }

          if (
            req.method ===
              'POST' &&
            url.pathname ===
              '/api/tenants'
          ) {
            if (
              !allow(
                user,
                ['admin']
              )
            ) {
              return send(
                res,
                403,
                {
                  error:
                    'Only admins can add tenants'
                }
              );
            }

            const input =
              await body(req);

            if (
              !input.fullName ||
              !input.email ||
              !input.location ||
              !input.accessCode ||
              Number(
                input.allottedHours
              ) < 0
            ) {
              return send(
                res,
                400,
                {
                  error:
                    'Full name, email, location, allotted hours, and access code are required'
                }
              );
            }

            if (
              data.tenants.some(
                tenant =>
                  tenant.email
                    .toLowerCase() ===
                  String(
                    input.email
                  ).toLowerCase()
              )
            ) {
              return send(
                res,
                409,
                {
                  error:
                    'A tenant with this email already exists'
                }
              );
            }

            const tenant = {
              id:
                id('t'),

              fullName:
                input.fullName,

              companyName:
                input.companyName ||
                '',

              email:
                String(
                  input.email
                ).trim(),

              location:
                input.location,

              allottedHours:
                money(
                  input.allottedHours
                ),

              accessCodeHash:
                hashPassword(
                  String(
                    input.accessCode
                  )
                ),

              status:
                input.status ||
                'Active',

              createdAt:
                new Date()
                  .toISOString()
            };

            await repository
              .tenants
              .create(
                tenant
              );

            return send(
              res,
              201,
              cleanTenant(
                tenant
              )
            );
          }

          const tenantMatch =
            url.pathname.match(
              /^\/api\/tenants\/([^/]+)$/
            );

          if (
            tenantMatch &&
            ['PUT', 'DELETE']
              .includes(
                req.method
              )
          ) {
            if (
              !allow(
                user,
                ['admin']
              )
            ) {
              return send(
                res,
                403,
                {
                  error:
                    'Only admins can manage tenants'
                }
              );
            }

            const current =
              data.tenants.find(
                tenant =>
                  tenant.id ===
                  tenantMatch[1]
              );

            if (!current) {
              return send(
                res,
                404,
                {
                  error:
                    'Tenant not found'
                }
              );
            }

            if (
              req.method ===
              'DELETE'
            ) {
              await repository
                .tenants
                .remove(
                  current.id
                );

              return send(
                res,
                200,
                {
                  ok: true
                }
              );
            }

            const input =
              await body(req);

            const tenant = {
              ...current,
              ...input,

              id:
                current.id,

              allottedHours:
                money(
                  input.allottedHours
                ),

              accessCodeHash:
                current.accessCodeHash
            };

            if (
              input.accessCode
            ) {
              tenant.accessCodeHash =
                hashPassword(
                  String(
                    input.accessCode
                  )
                );
            }

            await repository
              .tenants
              .update(
                tenant
              );

            return send(
              res,
              200,
              cleanTenant(
                tenant
              )
            );
          }

          if (
            req.method ===
              'POST' &&
            url.pathname ===
              '/api/rooms'
          ) {
            if (
              !allow(
                user,
                ['admin']
              )
            ) {
              return send(
                res,
                403,
                {
                  error:
                    'Only admins can add rooms'
                }
              );
            }

            const input =
              await body(req);

            if (
              !input.name ||
              !input.location
            ) {
              return send(
                res,
                400,
                {
                  error:
                    'Room name and location are required'
                }
              );
            }

            const room = {
              id:
                id('r'),

              name:
                input.name,

              location:
                input.location,

              capacity:
                Number(
                  input.capacity ||
                  0
                ),

              calendarId:
                input.calendarId ||
                ''
            };

            await repository
              .rooms
              .create(
                room
              );

            return send(
              res,
              201,
              room
            );
          }

          const roomMatch =
            url.pathname.match(
              /^\/api\/rooms\/([^/]+)$/
            );

          if (
            roomMatch &&
            ['PUT', 'DELETE']
              .includes(
                req.method
              )
          ) {
            if (
              !allow(
                user,
                ['admin']
              )
            ) {
              return send(
                res,
                403,
                {
                  error:
                    'Only admins can manage rooms'
                }
              );
            }

            const current =
              data.rooms.find(
                room =>
                  room.id ===
                  roomMatch[1]
              );

            if (!current) {
              return send(
                res,
                404,
                {
                  error:
                    'Room not found'
                }
              );
            }

            if (
              req.method ===
              'DELETE'
            ) {
              if (
                data.bookings.some(
                  booking =>
                    booking.roomId ===
                    current.id
                )
              ) {
                return send(
                  res,
                  400,
                  {
                    error:
                      'This room has booking history and cannot be deleted'
                  }
                );
              }

              await repository
                .rooms
                .remove(
                  current.id
                );

              return send(
                res,
                200,
                {
                  ok: true
                }
              );
            }

            const input =
              await body(req);

            const room = {
              ...current,
              ...input,

              id:
                current.id,

              capacity:
                Number(
                  input.capacity ||
                  0
                )
            };

            await repository
              .rooms
              .update(
                room
              );

            return send(
              res,
              200,
              room
            );
          }

          const bookingMatch =
            url.pathname.match(
              /^\/api\/bookings\/([^/]+)$/
            );

          if (
            bookingMatch &&
            req.method ===
              'DELETE'
          ) {
            if (
              !allow(
                user,
                ['admin']
              )
            ) {
              return send(
                res,
                403,
                {
                  error:
                    'Only admins can delete bookings'
                }
              );
            }

            const booking =
              data.bookings.find(
                item =>
                  item.id ===
                  bookingMatch[1]
              );

            if (!booking) {
              return send(
                res,
                404,
                {
                  error:
                    'Booking not found'
                }
              );
            }

            const room =
              data.rooms.find(
                item =>
                  item.id ===
                  booking.roomId
              );

            await deleteCalendarEvent(
              data,
              room,
              booking.calendarEventId
            );

            await repository
              .bookings
              .remove(
                booking.id
              );

            return send(
              res,
              200,
              {
                ok: true
              }
            );
          }

          const reportMatch =
            url.pathname.match(
              /^\/api\/tenant-reports\/([^/]+)\/send$/
            );

          if (
            reportMatch &&
            req.method ===
              'POST'
          ) {
            if (
              !allow(
                user,
                ['admin']
              )
            ) {
              return send(
                res,
                403,
                {
                  error:
                    'Only admins can send reports'
                }
              );
            }

            const tenant =
              data.tenants.find(
                item =>
                  item.id ===
                  reportMatch[1]
              );

            if (!tenant) {
              return send(
                res,
                404,
                {
                  error:
                    'Tenant not found'
                }
              );
            }

            const report =
              await sendUsageEmail(
                data,
                tenant
              );

            return send(
              res,
              200,
              {
                ok: true,
                to:
                  tenant.email,
                subject:
                  report.subject
              }
            );
          }

          if (
            req.method ===
              'GET' &&
            url.pathname ===
              '/api/schedule'
          ) {
            const start =
              weekStart(
                url.searchParams.get(
                  'week'
                ) ||
                new Date()
              );

            const end =
              addDays(
                start,
                6
              );

            const all =
              allow(
                user,
                [
                  'admin',
                  'manager'
                ]
              );

            const employees =
              (
                all
                  ? data.employees
                  : data.employees.filter(
                    employee =>
                      employee.id ===
                      user.employeeId
                  )
              )
                .filter(
                  employee =>
                    employee.status ===
                    'Active'
                );

            const shifts =
              data.shifts
                .filter(
                  shift =>
                    shift.date >=
                      start &&
                    shift.date <=
                      end &&
                    (
                      all ||
                      shift.employeeId ===
                        user.employeeId
                    )
                )
                .map(
                  shift => ({
                    ...shift,

                    employee:
                      data.employees.find(
                        employee =>
                          employee.id ===
                          shift.employeeId
                      )
                  })
                );

            return send(
              res,
              200,
              {
                weekStart:
                  start,

                weekEnd:
                  end,

                employees,

                shifts
              }
            );
          }

          if (
            req.method ===
              'POST' &&
            url.pathname ===
              '/api/shifts'
          ) {
            if (
              !allow(
                user,
                [
                  'admin',
                  'manager'
                ]
              )
            ) {
              return send(
                res,
                403,
                {
                  error:
                    'Only managers and admins can create shifts'
                }
              );
            }

            const input =
              await body(req);

            if (
              !data.employees.some(
                employee =>
                  employee.id ===
                  input.employeeId
              ) ||
              !input.date ||
              !input.startTime ||
              !input.endTime
            ) {
              return send(
                res,
                400,
                {
                  error:
                    'Employee, date, start time, and end time are required'
                }
              );
            }

            const shift = {
              id:
                id('s'),

              employeeId:
                input.employeeId,

              date:
                input.date,

              startTime:
                input.startTime,

              endTime:
                input.endTime,

              jobSite:
                input.jobSite ||
                'Main Office',

              roleLabel:
                input.roleLabel ||
                'Regular shift',

              color:
                [
                  'teal',
                  'blue',
                  'purple',
                  'orange'
                ].includes(
                  input.color
                )
                  ? input.color
                  : 'teal',

              status:
                input.status ||
                'Published'
            };

            await repository
              .shifts
              .create(
                shift
              );

            return send(
              res,
              201,
              shift
            );
          }

          const shiftMatch =
            url.pathname.match(
              /^\/api\/shifts\/([^/]+)$/
            );

          if (
            shiftMatch &&
            ['PUT', 'DELETE']
              .includes(
                req.method
              )
          ) {
            if (
              !allow(
                user,
                [
                  'admin',
                  'manager'
                ]
              )
            ) {
              return send(
                res,
                403,
                {
                  error:
                    'Only managers and admins can manage shifts'
                }
              );
            }

            const current =
              data.shifts.find(
                shift =>
                  shift.id ===
                  shiftMatch[1]
              );

            if (!current) {
              return send(
                res,
                404,
                {
                  error:
                    'Shift not found'
                }
              );
            }

            if (
              req.method ===
              'DELETE'
            ) {
              await repository
                .shifts
                .remove(
                  current.id
                );

              return send(
                res,
                200,
                {
                  ok: true
                }
              );
            }

            const input =
              await body(req);

            const shift = {
              ...current,
              ...input,

              id:
                current.id,

              employeeId:
                input.employeeId ||
                current.employeeId
            };

            await repository
              .shifts
              .update(
                shift
              );

            return send(
              res,
              200,
              shift
            );
          }

          if (
            req.method ===
              'POST' &&
            url.pathname ===
              '/api/schedule/copy-previous-week'
          ) {
            if (
              !allow(
                user,
                [
                  'admin',
                  'manager'
                ]
              )
            ) {
              return send(
                res,
                403,
                {
                  error:
                    'Only managers and admins can copy schedules'
                }
              );
            }

            const input =
              await body(req);

            const target =
              weekStart(
                input.week
              );

            const source =
              addDays(
                target,
                -7
              );

            const sourceShifts =
              data.shifts.filter(
                shift =>
                  shift.date >=
                    source &&
                  shift.date <=
                    addDays(
                      source,
                      6
                    )
              );

            const copies = [];

            for (
              const shift of
              sourceShifts
            ) {
              const copied = {
                ...shift,

                id:
                  id('s'),

                date:
                  addDays(
                    shift.date,
                    7
                  )
              };

              if (
                !data.shifts.some(
                  item =>
                    item.employeeId ===
                      copied.employeeId &&
                    item.date ===
                      copied.date &&
                    item.startTime ===
                      copied.startTime
                )
              ) {
                copies.push(
                  copied
                );
              }
            }

            await repository
              .shifts
              .createMany(
                copies
              );

            return send(
              res,
              200,
              {
                created:
                  copies.length
              }
            );
          }

          if (
            req.method ===
              'GET' &&
            url.pathname ===
              '/api/employees'
          ) {
            if (
              !allow(
                user,
                [
                  'admin',
                  'manager'
                ]
              )
            ) {
              return send(
                res,
                403,
                {
                  error:
                    'Insufficient permission'
                }
              );
            }

            return send(
              res,
              200,
              data.employees
            );
          }

          if (
            url.pathname ===
              '/api/employees' &&
            req.method ===
              'POST'
          ) {
            if (
              !allow(
                user,
                ['admin']
              )
            ) {
              return send(
                res,
                403,
                {
                  error:
                    'Only admins can add employees'
                }
              );
            }

            const input =
              await body(req);

            const employee = {
              id:
                id('e'),

              code:
                input.code,

              firstName:
                input.firstName,

              lastName:
                input.lastName,

              department:
                input.department,

              position:
                input.position,

              role:
                input.role ||
                'employee',

              monthlySalary:
                Number(
                  input.monthlySalary ||
                  0
                ),

              status:
                input.status ||
                'Active',

              startDate:
                input.startDate ||
                null,

              sss:
                input.sss ||
                null,

              philhealth:
                input.philhealth ||
                null,

              pagibig:
                input.pagibig ||
                null
            };

            const username =
              (
                input.username ||
                `${input.firstName}.${input.lastName}`
              )
                .toLowerCase()
                .replace(
                  /\s/g,
                  ''
                );

            const account = {
              id:
                id('u'),

              username,

              passwordHash:
                hashPassword(
                  input.password ||
                  'welcome123'
                ),

              employeeId:
                employee.id,

              role:
                employee.role
            };

            await repository
              .employees
              .createWithUser(
                employee,
                account
              );

            return send(
              res,
              201,
              employee
            );
          }

          const employeeMatch =
            url.pathname.match(
              /^\/api\/employees\/([^/]+)$/
            );

          if (
            employeeMatch &&
            ['PUT', 'DELETE']
              .includes(
                req.method
              )
          ) {
            if (
              !allow(
                user,
                ['admin']
              )
            ) {
              return send(
                res,
                403,
                {
                  error:
                    'Only admins can edit employees'
                }
              );
            }

            const current =
              data.employees.find(
                employee =>
                  employee.id ===
                  employeeMatch[1]
              );

            if (!current) {
              return send(
                res,
                404,
                {
                  error:
                    'Employee not found'
                }
              );
            }

            if (
              req.method ===
              'DELETE'
            ) {
              await repository
                .employees
                .removeWithUser(
                  current.id
                );

              return send(
                res,
                200,
                {
                  ok: true
                }
              );
            }

            const input =
              await body(req);

            const employee = {
              ...current,
              ...input,

              id:
                current.id,

              monthlySalary:
                Number(
                  input.monthlySalary ||
                  0
                )
            };

            delete employee.password;
            delete employee.username;

            const account =
              data.users.find(
                item =>
                  item.employeeId ===
                  current.id
              );

            if (account) {
              account.role =
                employee.role ||
                account.role;

              if (
                input.password
              ) {
                account.passwordHash =
                  hashPassword(
                    input.password
                  );
              }
            }

            await repository
              .employees
              .updateWithUser(
                employee,
                account
              );

            return send(
              res,
              200,
              employee
            );
          }

          if (
            req.method ===
              'GET' &&
            url.pathname ===
              '/api/attendance'
          ) {
            const all =
              allow(
                user,
                [
                  'admin',
                  'manager'
                ]
              );

            const list =
              all
                ? data.attendance
                : data.attendance.filter(
                  record =>
                    record.employeeId ===
                    user.employeeId
                );

            return send(
              res,
              200,
              list.map(
                record => ({
                  ...record,

                  employee:
                    data.employees.find(
                      employee =>
                        employee.id ===
                        record.employeeId
                    )
                })
              )
            );
          }

          if (
            req.method ===
              'POST' &&
            url.pathname ===
              '/api/attendance/clock'
          ) {
            const input =
              await body(req);

            const today =
              input.date ||
              new Date()
                .toISOString()
                .slice(0, 10);

            const employeeId =
              allow(
                user,
                [
                  'admin',
                  'manager'
                ]
              ) &&
              input.employeeId
                ? input.employeeId
                : user.employeeId;

            let record =
              data.attendance.find(
                item =>
                  item.employeeId ===
                    employeeId &&
                  item.date ===
                    today
              );

            const now =
              new Date()
                .toLocaleTimeString(
                  'en-PH',
                  {
                    hour:
                      '2-digit',

                    minute:
                      '2-digit',

                    hour12:
                      false
                  }
                );

            if (!record) {
              record = {
                id:
                  id('a'),

                employeeId,

                date:
                  today,

                timeIn:
                  now,

                timeOut:
                  null,

                status:
                  'Present',

                overtimeHours:
                  0
              };

              await repository
                .attendance
                .create(
                  record
                );

            } else if (
              !record.timeOut
            ) {
              record = {
                ...record,
                timeOut:
                  now
              };

              await repository
                .attendance
                .update(
                  record
                );

            } else {
              return send(
                res,
                400,
                {
                  error:
                    'Attendance already completed for today'
                }
              );
            }

            return send(
              res,
              200,
              record
            );
          }

          if (
            req.method ===
              'POST' &&
            url.pathname ===
              '/api/attendance'
          ) {
            if (
              !allow(
                user,
                [
                  'admin',
                  'manager'
                ]
              )
            ) {
              return send(
                res,
                403,
                {
                  error:
                    'Insufficient permission'
                }
              );
            }

            const input =
              await body(req);

            const record = {
              ...input,

              id:
                id('a'),

              overtimeHours:
                Number(
                  input.overtimeHours ||
                  0
                )
            };

            await repository
              .attendance
              .create(
                record
              );

            return send(
              res,
              201,
              record
            );
          }

          const attendanceMatch =
            url.pathname.match(
              /^\/api\/attendance\/([^/]+)$/
            );

          if (
            attendanceMatch &&
            ['PUT', 'DELETE']
              .includes(
                req.method
              )
          ) {
            if (
              !allow(
                user,
                [
                  'admin',
                  'manager'
                ]
              )
            ) {
              return send(
                res,
                403,
                {
                  error:
                    'Insufficient permission'
                }
              );
            }

            const current =
              data.attendance.find(
                record =>
                  record.id ===
                  attendanceMatch[1]
              );

            if (!current) {
              return send(
                res,
                404,
                {
                  error:
                    'Record not found'
                }
              );
            }

            if (
              req.method ===
              'DELETE'
            ) {
              await repository
                .attendance
                .remove(
                  current.id
                );

              return send(
                res,
                200,
                {
                  ok: true
                }
              );
            }

            const record = {
              ...current,
              ...(await body(req)),

              id:
                current.id
            };

            await repository
              .attendance
              .update(
                record
              );

            return send(
              res,
              200,
              record
            );
          }

          if (
            req.method ===
              'GET' &&
            url.pathname ===
              '/api/payrolls'
          ) {
            const list =
              allow(
                user,
                [
                  'admin',
                  'manager'
                ]
              )
                ? data.payrolls
                : data.payrolls.filter(
                  payroll =>
                    payroll.employeeId ===
                    user.employeeId
                );

            return send(
              res,
              200,
              list.map(
                payroll => ({
                  ...payroll,

                  employee:
                    data.employees.find(
                      employee =>
                        employee.id ===
                        payroll.employeeId
                    )
                })
              )
            );
          }

          if (
            req.method ===
              'POST' &&
            url.pathname ===
              '/api/payrolls'
          ) {
            if (
              !allow(
                user,
                ['admin']
              )
            ) {
              return send(
                res,
                403,
                {
                  error:
                    'Only admins can run payroll'
                }
              );
            }

            const input =
              await body(req);

            const employee =
              data.employees.find(
                item =>
                  item.id ===
                  input.employeeId
              );

            if (!employee) {
              return send(
                res,
                404,
                {
                  error:
                    'Employee not found'
                }
              );
            }

            const calc =
              calculatePayroll(
                employee,
                input,
                data.company
                  .payFrequency
              );

            const payroll = {
              ...input,
              ...calc,

              id:
                id('p'),

              employeeId:
                employee.id,

              period:
                input.period ||
                new Date()
                  .toISOString()
                  .slice(0, 7),

              createdAt:
                new Date()
                  .toISOString()
            };

            await repository
              .payrolls
              .create(
                payroll
              );

            return send(
              res,
              201,
              payroll
            );
          }

          const payrollMatch =
            url.pathname.match(
              /^\/api\/payrolls\/([^/]+)$/
            );

          if (
            payrollMatch &&
            req.method ===
              'DELETE'
          ) {
            if (
              !allow(
                user,
                ['admin']
              )
            ) {
              return send(
                res,
                403,
                {
                  error:
                    'Only admins can delete payroll'
                }
              );
            }

            await repository
              .payrolls
              .remove(
                payrollMatch[1]
              );

            return send(
              res,
              200,
              {
                ok: true
              }
            );
          }

          return send(
            res,
            404,
            {
              error:
                'API route not found'
            }
          );
        }

        serveFile(
          res,
          url.pathname
        );

      } catch (error) {
        const status =
          Number(
            error.statusCode
          ) ||
          500;

        if (
          status === 500
        ) {
          console.error(
            error
          );
        }

        send(
          res,
          status,
          {
            error:
              error.message ||
              'Server error'
          }
        );
      }
    }
  );

async function start() {
  const database =
    await testConnection();

  await repository
    .getSnapshot();

  server.listen(
    PORT,
    '0.0.0.0',
    () => {
      console.log(
        `Bayan Workforce is running on http://0.0.0.0:${PORT} with MariaDB ${database.databaseVersion}`
      );
    }
  );
}

async function shutdown() {
  server.close(
    async () => {
      await closePool();
      process.exit(0);
    }
  );
}

process.once(
  'SIGINT',
  shutdown
);

process.once(
  'SIGTERM',
  shutdown
);

start().catch(
  async error => {
    console.error(
      `Startup failed: ${error.message}`
    );

    await closePool();

    process.exitCode = 1;
  }
);