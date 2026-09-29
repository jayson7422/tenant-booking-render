'use strict';

const BUSINESS_TIME_ZONE = 'Asia/Manila';

const businessPartsFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: BUSINESS_TIME_ZONE,
  calendar: 'gregory',
  numberingSystem: 'latn',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});

function formattedParts(value) {
  return Object.fromEntries(
    businessPartsFormatter
      .formatToParts(value)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value])
  );
}

function businessDateTime(value = new Date()) {
  const parts = formattedParts(value);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    seconds: parts.second,
    value: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
  };
}

function validWallClock(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^\d{2}:\d{2}$/.test(time || '')) {
    return false;
  }

  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute));

  return check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day &&
    check.getUTCHours() === hour &&
    check.getUTCMinutes() === minute;
}

function isBookingStartInPast(date, time, now = new Date()) {
  if (!validWallClock(date, time)) return false;

  return `${date}T${time}` <= businessDateTime(now).value;
}

function businessTimeZoneOffsetMs(value) {
  const parts = formattedParts(value);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );

  return asUtc - value.getTime();
}

function wallClockToInstant(date, time) {
  if (!validWallClock(date, time)) {
    throw new RangeError('Invalid business date/time');
  }

  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const wallClockAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  let instant = wallClockAsUtc;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    instant = wallClockAsUtc - businessTimeZoneOffsetMs(new Date(instant));
  }

  return new Date(instant);
}

function businessDateTimeIso(date, time) {
  return wallClockToInstant(date, time).toISOString();
}

module.exports = {
  BUSINESS_TIME_ZONE,
  businessDateTime,
  businessDateTimeIso,
  isBookingStartInPast,
  validWallClock
};
