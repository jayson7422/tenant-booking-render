'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

async function main() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_ADMIN_USER || 'root',
    password: process.env.DB_ADMIN_PASSWORD || '',
    database: process.env.DB_NAME,
    multipleStatements: true
  });

  try {
    const migrationsDirectory = path.join(__dirname, '..', 'database', 'migrations');
    const files = fs.readdirSync(migrationsDirectory).filter(name => name.endsWith('.sql')).sort();
    for (const file of files) {
      const version = file.split('_')[0];
      const [installed] = await connection.execute(
        'SELECT version FROM schema_migrations WHERE version = ?', [version]
      );
      if (installed.length) {
        console.log(`SKIP ${file} (already installed)`);
        continue;
      }
      await connection.query(fs.readFileSync(path.join(migrationsDirectory, file), 'utf8'));
      console.log(`APPLIED ${file}`);
    }
  } finally {
    await connection.end();
  }
}

main()
  .catch(error => {
    console.error(`Database migration failed: ${error.message}`);
    process.exitCode = 1;
  });
