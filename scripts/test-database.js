'use strict';

const { pool, testConnection, closePool } = require('../src/config/database');

async function main() {
  try {
    const connection = await testConnection();
    const [tables] = await pool.query(
      `SELECT table_name AS tableName
         FROM information_schema.tables
        WHERE table_schema = DATABASE()
        ORDER BY table_name`
    );
    const [versions] = await pool.query(
      'SELECT version, description, applied_at AS appliedAt FROM schema_migrations ORDER BY version'
    );

    console.log(`Database connection: OK`);
    console.log(`Database: ${connection.databaseName}`);
    console.log(`Server: ${connection.databaseVersion}`);
    console.log(`Tables: ${tables.length}`);
    console.log(`Schema versions: ${versions.map(row => row.version).join(', ') || 'none'}`);
  } finally {
    await closePool();
  }
}

main().catch(error => {
  console.error(`Database test failed: ${error.message}`);
  process.exitCode = 1;
});
