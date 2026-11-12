import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../');

dotenv.config({ path: path.resolve(rootDir, '.env'), quiet: true });
dotenv.config({ quiet: true });


function sanitizeGrokKey(key) {
  if (!key) return '';
  const trimmed = key.trim();
  if (
    trimmed.toLowerCase() === 'dummy' ||
    trimmed.toLowerCase() === 'placeholder' ||
    trimmed.toLowerCase() === 'your_grok_api_key'
  ) {
    return '';
  }
  return trimmed;
}

function resolvePort() {
  const portArgIdx = process.argv.indexOf('--port');
  if (portArgIdx !== -1 && process.argv[portArgIdx + 1]) {
    return parseInt(process.argv[portArgIdx + 1], 10);
  }
  if (process.env.APP_PORT) {
    return parseInt(process.env.APP_PORT, 10);
  }
  return 3000;
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: resolvePort(),
  jwtSecret: process.env.JWT_SECRET || 'ctas-Q7xK2mR9vL4tZp8WnB3dYs6HfJ1aUe5C',
  dbPath: path.resolve(rootDir, process.env.DB_PATH || './data/timetable.db'),
  uploadsDir: path.resolve(rootDir, './uploads'),
  
  // Seed credentials
  adminSeedPassword: process.env.ADMIN_SEED_PASSWORD || 'sharmajii',
  facultySeedPassword: process.env.FACULTY_SEED_PASSWORD || 'man2112',
  studentSeedPassword: process.env.STUDENT_SEED_PASSWORD || 'rocky(Jg)',

  // AI Configuration (Gemini & Grok)
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: 'gemini-3.8-flash',
  grok: {
    apiBase: process.env.GROK_API_BASE || 'https://api.x.ai/v1',
    visionApiKey: sanitizeGrokKey(process.env.GROK_VISION_API_KEY),
    visionModel: process.env.GROK_VISION_MODEL || 'grok-4-fast',
    reasoningApiKey: sanitizeGrokKey(process.env.GROK_REASONING_API_KEY),
    reasoningModel: process.env.GROK_REASONING_MODEL || 'grok-4-1-fast',
    decisionApiKey: sanitizeGrokKey(process.env.GROK_DECISION_API_KEY),
    decisionModel: process.env.GROK_DECISION_MODEL || 'grok-4-fast-non-reasoning'
  }
};

export function isAiConfigured(type = 'all') {
  const hasGemini = Boolean(config.geminiApiKey);
  if (type === 'vision') return hasGemini || Boolean(config.grok.visionApiKey);
  if (type === 'reasoning') return hasGemini || Boolean(config.grok.reasoningApiKey);
  if (type === 'decision') return hasGemini || Boolean(config.grok.decisionApiKey);
  return hasGemini || Boolean(config.grok.visionApiKey || config.grok.reasoningApiKey || config.grok.decisionApiKey);
}

export default config;
