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

const config = {
  host: required('DB_HOST'),
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
