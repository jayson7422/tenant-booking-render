'use strict';

const path = require('path');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');

dotenv.config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function validateProductionDatabaseHost(host) {
  if (process.env.NODE_ENV !== 'production') {
    return;
  }

  const normalizedHost = String(host).trim().toLowerCase();

  const localHosts = new Set([
    'localhost',
    '127.0.0.1',
    '::1'
  ]);

  if (localHosts.has(normalizedHost)) {
    throw new Error(
      'Production cannot use a localhost database. Configure DB_HOST with the production MariaDB/MySQL host.'
    );
  }
}

const dbHost = required('DB_HOST');

validateProductionDatabaseHost(dbHost);

const config = {
  host: dbHost,
  port: positiveInteger('DB_PORT', 3306),
  database: required('DB_NAME'),
  user: required('DB_USER'),
  password: required('DB_PASSWORD'),
  waitForConnections: true,
  connectionLimit: positiveInteger('DB_CONNECTION_LIMIT', 10),
  queueLimit: 0,
  charset: 'utf8mb4',
  timezone: 'Z',
  dateStrings: true,
  decimalNumbers: false,
  supportBigNumbers: true
};

const pool = mysql.createPool(config);

async function testConnection() {
  const [rows] = await pool.query(
    'SELECT DATABASE() AS databaseName, VERSION() AS databaseVersion, CURRENT_TIMESTAMP(3) AS serverTime'
  );
  return rows[0];
}

async function closePool() {
  await pool.end();
}

module.exports = { pool, testConnection, closePool };
