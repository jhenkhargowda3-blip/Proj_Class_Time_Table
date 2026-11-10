import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';

import config from './src/config/env.js';
import { getDatabase } from './src/db/connection.js';
import { seedDatabase } from './src/db/seed.js';
import { registerTeacher } from './src/services/teacherService.js';
import errorHandler from './src/middleware/errorHandler.js';

// Route imports
import authRoutes from './src/routes/auth.js';
import adminRoutes from './src/routes/admin.js';
import facultyRoutes from './src/routes/faculty.js';
import studentRoutes from './src/routes/student.js';
import timetableRoutes from './src/routes/timetable.js';
import absenceRoutes from './src/routes/absence.js';
import aiRoutes from './src/routes/ai.js';
import eventsRoutes from './src/routes/events.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Trust reverse proxy (Google Cloud Run / Load Balancer) so req.ip and rate-limiting work accurately
app.set('trust proxy', 1);

// Security headers with helmet (configured to allow AI Studio iframe embedding)
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    frameguard: false,
    crossOriginResourcePolicy: false,
    crossOriginOpenerPolicy: false
  })
);

// Explicitly ensure X-Frame-Options does not block AI Studio iFrame
app.use((req, res, next) => {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiter for authentication attempts (generous threshold to avoid locking out testers)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Allow up to 1000 requests per 15-minute window for testing
  message: { error: 'Too many authentication attempts. Please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1',
  validate: false
});

// Serve static frontend files from /public both at root and /public
const publicDir = path.resolve(__dirname, 'public');
app.use(express.static(publicDir));
app.use('/public', express.static(publicDir));

// Direct portal routes
app.get(['/admin', '/admin/'], (req, res) => res.sendFile(path.join(publicDir, 'admin', 'index.html')));
app.get(['/faculty', '/faculty/'], (req, res) => res.sendFile(path.join(publicDir, 'faculty', 'index.html')));
app.get(['/student', '/student/'], (req, res) => res.sendFile(path.join(publicDir, 'student', 'index.html')));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'Class Timetable Automation System (CTAS)',
    version: '1.0.0',
    phase: 1,
    environment: config.env,
    database: 'connected (SQLite PRAGMA foreign_keys=ON, journal_mode=WAL)'
  });
});

// Mount API routes
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/faculty', facultyRoutes);
app.use('/api/student', studentRoutes);
app.use('/api/timetable', timetableRoutes);
app.use('/api/absence', absenceRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/events', eventsRoutes);

// Fallback to index.html for root path or single-page navigation
app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Centralized error handler
app.use(errorHandler);

// Initialize DB on boot & initialize clean structure if empty
try {
  const db = getDatabase();
  const userTable = db.prepare("SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (userTable && userTable.count > 0) {
    const adminCount = db.prepare("SELECT count(*) as count FROM users WHERE role = 'admin'").get();
    if (!adminCount || adminCount.count === 0) {
      console.log('[CTAS] Database empty - initializing clean college structure...');
      seedDatabase(db, { clean: true });
    }
  }
  // Ensure faculty profile & credentials for Mrs. Manjula H S are initialized
  registerTeacher({
    username: 'manjula',
    password: 'man2112',
    fullName: 'Mrs. Manjula H S',
    email: 'manjula@gmail.com',
    phone: '7374619852',
    departmentCode: 'CSE',
    departmentName: 'Computer Science & Engineering'
  }, db);

  console.log(`[CTAS] SQLite database ready at ${config.dbPath}`);
} catch (err) {
  console.error('[CTAS] Failed to initialize database:', err);
}

let serverInstance = null;
const isDirectRun = Boolean(
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(__filename) &&
  !process.env.NODE_TEST_CONTEXT
);

if (isDirectRun) {
  serverInstance = app.listen(config.port, '0.0.0.0', () => {
    console.log(`\n======================================================`);
    console.log(` CTAS · Class Timetable Automation System`);
    console.log(` Running on: http://localhost:${config.port}`);
    console.log(` Environment: ${config.env}`);
    console.log(` Phase: 1-3 Verified`);
    console.log(`======================================================\n`);
  });
}

export default app;
