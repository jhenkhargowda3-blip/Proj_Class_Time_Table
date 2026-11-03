import { Router } from 'express';
import { optionalAuth } from '../middleware/auth.js';
import { addClient, removeClient } from '../services/sse.js';

const router = Router();

router.get('/', optionalAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const userId = req.user?.id || 'anonymous';
  const role = req.user?.role || 'guest';
  const client = { id: Date.now(), res, userId, role };

  addClient(client);

  res.write(`data: ${JSON.stringify({ type: 'connected', message: 'SSE connection established' })}\n\n`);

  const keepAliveTimer = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {
      clearInterval(keepAliveTimer);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAliveTimer);
    removeClient(client);
  });
});

export default router;
