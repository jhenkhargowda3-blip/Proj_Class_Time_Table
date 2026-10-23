import { GoogleGenAI } from '@google/genai';
import config from '../../config/env.js';

let aiInstance = null;

export function getGeminiClient() {
  const apiKey = config.geminiApiKey || process.env.GEMINI_API_KEY || '';
  if (!apiKey) return null;

  if (!aiInstance) {
    aiInstance = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build'
        }
      }
    });
  }

  return aiInstance;
}

export function isGeminiActive() {
  return Boolean(config.geminiApiKey || process.env.GEMINI_API_KEY);
}

export async function generateContentWithTimeout(params, timeoutMs = 4500) {
  const client = getGeminiClient();
  if (!client) throw new Error('GEMINI_NOT_CONFIGURED');

  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('GEMINI_TIMEOUT')), timeoutMs);
  });

  try {
    const res = await Promise.race([
      client.models.generateContent(params),
      timeoutPromise
    ]);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export default {
  getGeminiClient,
  isGeminiActive,
  generateContentWithTimeout
};
