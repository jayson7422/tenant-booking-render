const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const repository = require('./src/repositories/applicationRepository');
const { testConnection, closePool } = require('./src/config/database');
const {
  BUSINESS_TIME_ZONE,
  businessDateTime,
  businessDateTimeIso,
  isBookingStartInPast,
  validWallClock
} = require('./src/time/businessTime');

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

const BOOKING_TIME_IN_PAST =
  'This time has already passed. Please select a future booking time.';

function sendBookingTimeInPast(res) {
  return send(
    res,
    409,
    {
      success: false,
      code: 'BOOKING_TIME_IN_PAST',
      error: BOOKING_TIME_IN_PAST,
      message: BOOKING_TIME_IN_PAST
    }
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
  return {
    id: user.id,
    username: user.username,
    role: user.role
  };
}

function money(value) {
  return Math.round(
    (Number(value) || 0) * 100
  ) / 100;
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

function validBookingWindow(
  date,
  startTime,
  endTime
) {
  return validWallClock(date, startTime) &&
    validWallClock(date, endTime) &&
    Boolean(
      bookingHours(
        startTime,
        endTime
      )
    );
}

function adminBookingState(
  booking,
  now = businessDateTime()
) {
  if (booking.status === 'Cancelled') return 'Cancelled';
  const start = `${booking.date}T${booking.startTime}`;
  const end = `${booking.date}T${booking.endTime}`;
  if (end <= now.value) return 'Completed';
  if (start <= now.value) return 'Ongoing';
  return 'Upcoming';
}

function adminBookingReview(
  data,
  booking
) {
  const reasons = [];
  const tenant = data.tenants.find(item => item.id === booking.tenantId);
  const room = data.rooms.find(item => item.id === booking.roomId);

  if (!tenant) reasons.push('The tenant relationship is missing.');
  if (!room) reasons.push('The workspace relationship is missing.');
  if (!validBookingWindow(booking.date, booking.startTime, booking.endTime)) {
    reasons.push('The booking date or time range is invalid.');
  }
  if (booking.status === 'Confirmed' && data.bookings.some(other =>
    other.id !== booking.id &&
    other.status === 'Confirmed' &&
    other.roomId === booking.roomId &&
    other.date === booking.date &&
    other.startTime < booking.endTime &&
    other.endTime > booking.startTime
  )) {
    reasons.push('This booking overlaps another confirmed booking.');
  }

  return {
    needsReview: reasons.length > 0,
    reviewReason: reasons.join(' ')
  };
}

function bookingAuditValues(booking) {
  return {
    roomId: booking.roomId,
    roomName: booking.roomName,
    date: booking.date,
    startTime: booking.startTime,
    endTime: booking.endTime,
    hours: Number(booking.hours),
    status: booking.status
  };
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

async function bookingConflict(
  data,
  roomId,
  date,
  startTime,
  endTime,
  exceptId
) {
  return repository.bookings.findConflict(
    roomId,
    date,
    startTime,
    endTime,
    exceptId
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
  return businessDateTimeIso(
    date,
    time
  );
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
  booking,
  ignoredEventId = null
) {
  if (ignoredEventId) {
    const config = googleConfiguration(data, room);

    if (!config) {
      return {
        enabled: false,
        busy: false
      };
    }

    const token = await googleToken(config);
    const timeMin = new Date(
      bookingDateTime(
        booking.date,
        booking.startTime
      )
    ).toISOString();
    const timeMax = new Date(
      bookingDateTime(
        booking.date,
        booking.endTime
      )
    ).toISOString();
    const query = new URLSearchParams({
      timeMin,
      timeMax,
      singleEvents: 'true',
      showDeleted: 'false',
      orderBy: 'startTime',
      maxResults: '2500'
    });
    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
        config.calendarId
      )}/events?${query.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    if (!response.ok) {
      throw Error(
        'Google Calendar availability check failed'
      );
    }

    const payload = await response.json();
    const requestedStart = new Date(timeMin).getTime();
    const requestedEnd = new Date(timeMax).getTime();
    const busy = (payload.items || []).some(event => {
      if (
        event.id === ignoredEventId ||
        event.status === 'cancelled' ||
        event.transparency === 'transparent'
      ) {
        return false;
      }

      const startValue =
        event.start?.dateTime ||
        event.start?.date;
      const endValue =
        event.end?.dateTime ||
        event.end?.date;

      if (!startValue || !endValue) {
        return false;
      }

      const eventStart = event.start?.dateTime
        ? new Date(startValue).getTime()
        : new Date(
          businessDateTimeIso(
            startValue,
            '00:00'
          )
        ).getTime();
      const eventEnd = event.end?.dateTime
        ? new Date(endValue).getTime()
        : new Date(
          businessDateTimeIso(
            endValue,
            '00:00'
          )
        ).getTime();

      return eventStart < requestedEnd &&
        eventEnd > requestedStart;
    });

    return {
      enabled: true,
      busy
    };
  }

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
        await bookingConflict(
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
                  : 'launchpad-tenant',

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
              !validBookingWindow(
                booking.date,
                booking.startTime,
                booking.endTime
              )
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
              isBookingStartInPast(
                booking.date,
                booking.startTime
              )
            ) {
              return send(
                res,
                200,
                {
                  success: false,
                  available: false,
                  code: 'BOOKING_TIME_IN_PAST',
                  error: BOOKING_TIME_IN_PAST,
                  message: BOOKING_TIME_IN_PAST,
                  reason: BOOKING_TIME_IN_PAST,
                  remainingHours: tenantRemaining(
                    data,
                    tenant
                  ),
                  hours,
                  suggestions: [],
                  calendarChecked: false
                }
              );
            }

            const conflict =
              await bookingConflict(
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
              !validBookingWindow(
                input.date,
                input.startTime,
                input.endTime
              )
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
              isBookingStartInPast(
                input.date,
                input.startTime
              )
            ) {
              return sendBookingTimeInPast(res);
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
              await bookingConflict(
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
                  BUSINESS_TIME_ZONE
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
          if (
            /^\/api\/(dashboard|employees(?:\/|$)|schedule(?:\/|$)|shifts(?:\/|$)|attendance(?:\/|$)|payrolls(?:\/|$))/.test(
              url.pathname
            )
          ) {
            return send(
              res,
              410,
              {
                error:
                  'Attendance, payroll, employee, and scheduling features have been discontinued.'
              }
            );
          }

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
                          ),

                        bookingState:
                          adminBookingState(
                            booking
                          ),

                        ...adminBookingReview(
                          data,
                          booking
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

          const bookingCancelMatch =
            url.pathname.match(
              /^\/api\/bookings\/([^/]+)\/cancel$/
            );

          if (
            bookingMatch &&
            req.method ===
              'GET'
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
                    'Only admins can view booking details'
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

            const tenant =
              data.tenants.find(
                item =>
                  item.id ===
                  booking.tenantId
              );

            const room =
              data.rooms.find(
                item =>
                  item.id ===
                  booking.roomId
              );

            return send(
              res,
              200,
              {
                booking: {
                  ...booking,
                  tenant: tenant
                    ? cleanTenant(tenant)
                    : null,
                  room: room || null,
                  bookingState:
                    adminBookingState(
                      booking
                    ),
                  ...adminBookingReview(
                    data,
                    booking
                  )
                },
                audit:
                  await repository.audit.listForBooking(
                    booking.id
                  )
              }
            );
          }

          if (
            bookingMatch &&
            req.method ===
              'PATCH'
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
                    'Only admins can edit bookings'
                }
              );
            }

            const current =
              data.bookings.find(
                item =>
                  item.id ===
                  bookingMatch[1]
              );

            if (!current) {
              return send(
                res,
                404,
                {
                  error:
                    'Booking not found'
                }
              );
            }

            if (current.status !== 'Confirmed') {
              return send(
                res,
                409,
                {
                  error:
                    'Only confirmed bookings can be edited'
                }
              );
            }

            const input =
              await body(req);
            const roomId =
              String(
                input.roomId ||
                current.roomId
              );
            const date =
              String(
                input.date ||
                ''
              );
            const startTime =
              String(
                input.startTime ||
                ''
              );
            const endTime =
              String(
                input.endTime ||
                ''
              );
            const hours =
              bookingHours(
                startTime,
                endTime
              );
            const room =
              data.rooms.find(
                item =>
                  item.id ===
                  roomId
              );

            if (
              !room ||
              !validBookingWindow(
                date,
                startTime,
                endTime
              )
            ) {
              return send(
                res,
                400,
                {
                  error:
                    'Choose a workspace, valid date, and valid start/end times'
                }
              );
            }

            const tenant =
              data.tenants.find(
                item =>
                  item.id ===
                  current.tenantId
              );
            if (!tenant) {
              return send(
                res,
                409,
                {
                  error:
                    'This booking has no active tenant relationship and cannot be edited'
                }
              );
            }

            const updated = {
              ...current,
              roomId,
              roomName: room.name,
              date,
              startTime,
              endTime,
              hours,
              calendarEventId: null
            };
            const reason =
              String(
                input.reason ||
                ''
              ).trim();
            if (!reason) {
              return send(
                res,
                400,
                {
                  error:
                    'A reason is required when an admin edits a booking'
                }
              );
            }
            let newCalendarEventId = null;

            const google =
              await googleAvailability(
                data,
                room,
                updated,
                current.calendarEventId
              );
            if (google.busy) {
              return send(
                res,
                409,
                {
                  error:
                    'This time is busy in Google Calendar. Please choose another time.'
                }
              );
            }

            try {
              if (
                google.enabled
              ) {
                newCalendarEventId =
                  await createCalendarEvent(
                    data,
                    room,
                    tenant,
                    updated,
                    data.bookingSettings
                      .timezone ||
                    BUSINESS_TIME_ZONE
                  );
              }
              updated.calendarEventId =
                newCalendarEventId;

              await repository
                .bookings
                .updateConfirmedByAdmin(
                  current,
                  updated,
                  {
                    bookingId:
                      current.id,
                    adminUserId:
                      user.id,
                    adminUsername:
                      user.username,
                    action:
                      'BOOKING_UPDATED_BY_ADMIN',
                    reason,
                    previousValues:
                      bookingAuditValues(
                        current
                      ),
                    newValues:
                      bookingAuditValues(
                        updated
                      )
                  }
                );
            } catch (error) {
              if (
                newCalendarEventId
              ) {
                await deleteCalendarEvent(
                  data,
                  room,
                  newCalendarEventId
                ).catch(() => {});
              }
              throw error;
            }

            if (
              current.calendarEventId &&
              current.calendarEventId !==
                newCalendarEventId
            ) {
              await deleteCalendarEvent(
                data,
                data.rooms.find(
                  item =>
                    item.id ===
                    current.roomId
                ),
                current.calendarEventId
              ).catch(error =>
                console.error(
                  `Old Google Calendar event cleanup failed: ${error.message}`
                )
              );
            }

            return send(
              res,
              200,
              {
                booking: {
                  ...updated,
                  tenant:
                    cleanTenant(
                      tenant
                    ),
                  room,
                  bookingState:
                    adminBookingState(
                      updated
                    ),
                  needsReview: false,
                  reviewReason: ''
                },
                calendarSynced:
                  Boolean(
                    newCalendarEventId
                  )
              }
            );
          }

          if (
            bookingCancelMatch &&
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
                    'Only admins can cancel bookings'
                }
              );
            }

            const booking =
              data.bookings.find(
                item =>
                  item.id ===
                  bookingCancelMatch[1]
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

            const input =
              await body(req);
            const remark =
              String(
                input.remark ||
                ''
              ).trim();
            if (!remark) {
              return send(
                res,
                400,
                {
                  error:
                    'A cancellation reason is required'
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
              .cancelByAdmin(
                booking.id,
                remark,
                {
                  bookingId:
                    booking.id,
                  adminUserId:
                    user.id,
                  adminUsername:
                    user.username,
                  action:
                    'BOOKING_CANCELLED_BY_ADMIN',
                  reason: remark,
                  previousValues:
                    bookingAuditValues(
                      booking
                    ),
                  newValues:
                    bookingAuditValues({
                      ...booking,
                      status:
                        'Cancelled',
                      calendarEventId:
                        null
                    })
                },
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
                  bookingState:
                    'Cancelled',
                  room
                }
              }
            );
          }

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

            return send(
              res,
              410,
              {
                error:
                  'Permanent booking deletion is disabled. Cancel the booking to preserve its history.'
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
        `Launchpad Tenant is running on http://0.0.0.0:${PORT} with MariaDB ${database.databaseVersion}`
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
