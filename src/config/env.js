import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../');

const DUMMY_GROK_KEYS = new Set([
  'sk-O5H6dMXC2rhdz8eXeKslEVayje9cdm8xxTEUs3M9KfvaRcb2',
  'sk-N7N67Rdftw83QM1NgmKpCeYkbmP2KmHrVYh3Pce7q1YQzbLO',
  'sk-DNzNaHrJNawbul49deBKbBFzelBaCiNpqnMWxWa1ZKkfatca'
]);

function sanitizeGrokKey(key) {
  if (!key) return '';
  const trimmed = key.trim();
  if (
    DUMMY_GROK_KEYS.has(trimmed) ||
    trimmed.startsWith('sk-O5H6d') ||
    trimmed.startsWith('sk-N7N67') ||
    trimmed.startsWith('sk-DNzNa') ||
    trimmed.toLowerCase() === 'dummy' ||
    trimmed.toLowerCase() === 'placeholder' ||
    trimmed.toLowerCase() === 'your_grok_api_key'
  ) {
    return '';
  }
  return trimmed;
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: 3000,
  jwtSecret: process.env.JWT_SECRET || 'ctas_default_super_secret_key_change_in_production',
  dbPath: path.resolve(rootDir, process.env.DB_PATH || './data/timetable.db'),
  uploadsDir: path.resolve(rootDir, './uploads'),
  
  // AI Configuration (Gemini & Grok)
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: 'gemini-3.8-flash',
  grok: {
    apiBase: process.env.GROK_API_BASE || 'https://api.x.ai/v1',
    visionApiKey: sanitizeGrokKey(process.env.GROK_VISION_API_KEY),
    visionModel: process.env.GROK_VISION_MODEL || 'grok-2-vision-1212',
    reasoningApiKey: sanitizeGrokKey(process.env.GROK_REASONING_API_KEY),
    reasoningModel: process.env.GROK_REASONING_MODEL || 'grok-2-1212',
    decisionApiKey: sanitizeGrokKey(process.env.GROK_DECISION_API_KEY),
    decisionModel: process.env.GROK_DECISION_MODEL || 'grok-2-1212'
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
