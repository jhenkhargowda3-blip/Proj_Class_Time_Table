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

    let effectiveStudentId = dbUser.student_id;
    let effectiveSectionName = dbUser.section_name;
    let resolvedFullName = dbUser.full_name;

    if (dbUser.role === 'student') {
      if (!resolvedFullName || resolvedFullName === 'Student Account') {
        resolvedFullName = 'Jhenkhar Gowda';
      }
      if (!effectiveStudentId) {
        const sec5B = db.prepare(`
          SELECT id, name FROM sections 
          WHERE name = 'CSE-5B' 
             OR (semester = 5 AND name LIKE '%B%')
          ORDER BY CASE WHEN name = 'CSE-5B' THEN 0 ELSE 1 END, id ASC 
          LIMIT 1
        `).get();
        if (sec5B) {
          effectiveStudentId = sec5B.id;
          effectiveSectionName = sec5B.name;
          try {
            db.prepare("UPDATE users SET student_id = ?, full_name = ? WHERE id = ?").run(sec5B.id, resolvedFullName, dbUser.id);
          } catch (e) {}
        }
      }
    }

    let effectiveFacultyId = dbUser.faculty_id;
    let linkedFacultyName = dbUser.faculty_name || null;
    let effectiveFacultyDept = dbUser.faculty_dept || null;

    if (dbUser.role === 'faculty') {
      if (!effectiveFacultyId || !linkedFacultyName) {
        const fac = db.prepare("SELECT id, name, department_id FROM faculty WHERE user_id = ? OR LOWER(email) = LOWER(?) LIMIT 1").get(dbUser.id, dbUser.email);
        if (fac) {
          effectiveFacultyId = fac.id;
          linkedFacultyName = fac.name;
          effectiveFacultyDept = fac.department_id;
          try {
            db.prepare("UPDATE users SET faculty_id = ? WHERE id = ?").run(fac.id, dbUser.id);
            db.prepare("UPDATE faculty SET user_id = ? WHERE id = ?").run(dbUser.id, fac.id);
          } catch (e) {}
        }
      }
      if (linkedFacultyName) {
        resolvedFullName = linkedFacultyName;
      }
    }

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
      facultyId: effectiveFacultyId,
      faculty_id: effectiveFacultyId,
      studentId: effectiveStudentId,
      student_id: effectiveStudentId,
      facultyDept: effectiveFacultyDept,
      sectionName: effectiveSectionName
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
