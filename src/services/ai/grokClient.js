import config from '../../config/env.js';

export async function callGrok({ apiKey, model, messages, temperature = 0.2, responseFormat = null }) {
  if (!apiKey || apiKey.startsWith('sk-O5H6d')) {
    throw new Error('GROK_API_KEY_NOT_CONFIGURED');
  }

  const payload = {
    model: model || config.grok.reasoningModel,
    messages,
    temperature
  };

  if (responseFormat) {
    payload.response_format = responseFormat;
  }

  try {
    const response = await fetch(`${config.grok.apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Grok API error (${response.status}): ${errorText}`);
    }

    const result = await response.json();
    return result.choices?.[0]?.message?.content || '';
  } catch (err) {
    throw err;
  }
}

export default {
  callGrok
};
