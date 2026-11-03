import jwt from 'jsonwebtoken';
import config from '../config/env.js';
import { getDatabase } from '../db/connection.js';

function resolveDbUser(decoded) {
  if (!decoded) return null;
  if (decoded.username && String(decoded.username).toLowerCase() === 'raj') {
    return null;
  }

  try {
    const db = getDatabase();
    let dbUser = null;
    if (decoded.id) {
      dbUser = db.prepare(`
        SELECT u.*,
               f.name as faculty_name, f.department_id as faculty_dept,
               s.name as section_name
        FROM users u
        LEFT JOIN faculty f ON u.faculty_id = f.id
        LEFT JOIN sections s ON u.student_id = s.id
        WHERE u.id = ?
        LIMIT 1
      `).get(decoded.id);
    }

    if (dbUser && decoded.username && dbUser.username.toLowerCase() !== String(decoded.username).toLowerCase()) {
      dbUser = null;
    }

    if (!dbUser && decoded.username) {
      dbUser = db.prepare(`
        SELECT u.*,
               f.name as faculty_name, f.department_id as faculty_dept,
               s.name as section_name
        FROM users u
        LEFT JOIN faculty f ON u.faculty_id = f.id
        LEFT JOIN sections s ON u.student_id = s.id
        WHERE LOWER(u.username) = LOWER(?)
        LIMIT 1
      `).get(String(decoded.username));
    }

    if (!dbUser) return null;

    const linkedFacultyName = dbUser.faculty_name || null;
    const resolvedFullName = linkedFacultyName || dbUser.full_name;

    return {
      ...decoded,
      id: dbUser.id,
      username: dbUser.username,
      role: dbUser.role,
      fullName: resolvedFullName,
      full_name: resolvedFullName,
      facultyName: linkedFacultyName,
      faculty_name: linkedFacultyName,
      email: dbUser.email,
      facultyId: dbUser.faculty_id,
      faculty_id: dbUser.faculty_id,
      studentId: dbUser.student_id,
      student_id: dbUser.student_id,
      facultyDept: dbUser.faculty_dept,
      sectionName: dbUser.section_name
    };
  } catch {
    return decoded;
  }
}

export function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  let bearerToken = null;
  if (authHeader) {
    if (authHeader.toLowerCase().startsWith('bearer ')) {
      bearerToken = authHeader.slice(7).trim();
    } else {
      bearerToken = authHeader.split(' ')[1] || authHeader.trim();
    }
  }

  const token = bearerToken || req.cookies?.token || req.query?.token;
  const url = req.originalUrl || (req.baseUrl + req.path);

  if (!token) {
    if (req.accepts('html') && !url.startsWith('/api/')) {
      return res.redirect('/#login');
    }
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    const hydratedUser = resolveDbUser(decoded);
    if (!hydratedUser) {
      res.clearCookie('token', { path: '/' });
      return res.status(401).json({ error: 'Invalid or expired session' });
    }
    req.user = hydratedUser;
    next();
  } catch (err) {
    res.clearCookie('token', { path: '/' });
    if (req.accepts('html') && !url.startsWith('/api/')) {
      return res.redirect('/#login');
    }
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

export function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  let bearerToken = null;
  if (authHeader) {
    if (authHeader.toLowerCase().startsWith('bearer ')) {
      bearerToken = authHeader.slice(7).trim();
    } else {
      bearerToken = authHeader.split(' ')[1] || authHeader.trim();
    }
  }

  const token = bearerToken || req.cookies?.token || req.query?.token;
  if (token) {
    try {
      const decoded = jwt.verify(token, config.jwtSecret);
      const hydratedUser = resolveDbUser(decoded);
      if (hydratedUser) {
        req.user = hydratedUser;
      }
    } catch {
      // ignore
    }
  }
  next();
}

export default requireAuth;
