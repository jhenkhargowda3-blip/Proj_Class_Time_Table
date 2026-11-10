import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import config from '../config/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let dbInstance = null;

export function getDatabase() {
  if (dbInstance) return dbInstance;

  const dbDir = path.dirname(config.dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  dbInstance = new Database(config.dbPath);
  
  // Enforce WAL mode, busy timeout, synchronous mode, and foreign key constraints
  dbInstance.pragma('journal_mode = WAL');
  dbInstance.pragma('synchronous = NORMAL');
  dbInstance.pragma('busy_timeout = 10000');
  dbInstance.pragma('foreign_keys = ON');

  // Initialize schema if not present
  initSchema(dbInstance);

  return dbInstance;
}

export function initSchema(db) {
  const schemaPath = path.resolve(__dirname, 'schema.sql');
  if (fs.existsSync(schemaPath)) {
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    db.exec(schemaSql);
  }

  // Ensure faculty table supports extended fields from JSON import
  try {
    const facultyCols = db.prepare("PRAGMA table_info(faculty)").all().map(c => c.name);
    if (!facultyCols.includes('classes_taught')) {
      db.exec("ALTER TABLE faculty ADD COLUMN classes_taught TEXT NULL");
    }
    if (!facultyCols.includes('effective_from')) {
      db.exec("ALTER TABLE faculty ADD COLUMN effective_from TEXT NULL");
    }
    if (!facultyCols.includes('weekly_hours')) {
      db.exec("ALTER TABLE faculty ADD COLUMN weekly_hours INTEGER NULL");
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS import_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        snapshot_json TEXT NOT NULL
      )
    `);
  } catch (err) {
    // ignore migration error if already exists
  }
}

export function closeDatabase() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

export default getDatabase;
