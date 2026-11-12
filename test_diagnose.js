import { getDatabase } from './src/db/connection.js';
import { evaluateTimetableConflicts } from './public/js/timetableValidator.js';
import { validateTimetable } from './src/services/validator.js';
import { getProjectedTimetableEntries } from './src/services/referenceDataService.js';

const db = getDatabase();

const masterData = {
  departments: db.prepare('SELECT * FROM departments ORDER BY name ASC').all(),
  faculty: db.prepare('SELECT f.*, d.name as department_name, d.code as department_code, u.username FROM faculty f LEFT JOIN departments d ON f.department_id = d.id LEFT JOIN users u ON f.user_id = u.id ORDER BY f.name ASC').all(),
  subjects: db.prepare('SELECT s.*, d.name as department_name, d.code as department_code FROM subjects s JOIN departments d ON s.department_id = d.id ORDER BY s.semester, s.code ASC').all(),
  sections: db.prepare('SELECT sec.*, d.name as department_name, d.code as department_code FROM sections sec JOIN departments d ON sec.department_id = d.id ORDER BY sec.name ASC').all(),
  rooms: db.prepare('SELECT * FROM rooms ORDER BY type, name ASC').all(),
  workingDays: db.prepare('SELECT * FROM working_days ORDER BY day_index ASC').all(),
  timeSlots: db.prepare('SELECT * FROM time_slots ORDER BY slot_no ASC').all(),
  holidays: db.prepare('SELECT * FROM holidays ORDER BY date ASC').all(),
  facultyAvailability: db.prepare('SELECT faculty_id, day_id, slot_id, is_available FROM faculty_availability').all(),
  sectionSubjects: db.prepare('SELECT ss.*, s.name as subject_name, s.code as subject_code, s.weekly_periods, s.type as subject_type, s.lab_block_length FROM section_subjects ss JOIN subjects s ON ss.subject_id = s.id').all(),
  facultySubjects: db.prepare('SELECT * FROM faculty_subjects').all()
};

const ver = db.prepare("SELECT * FROM timetable_versions WHERE status = 'active'").get() || db.prepare("SELECT * FROM timetable_versions ORDER BY id DESC LIMIT 1").get();
let entries = db.prepare(`
  SELECT te.*, s.name as subject_name, s.code as subject_code, s.type as subject_type,
         sec.name as section_name, sec.semester,
         f.name as faculty_name, f.email as faculty_email,
         r.name as room_name, r.type as room_type, r.capacity as room_capacity,
         wd.day_name, wd.day_index,
         ts.slot_no, ts.start_time, ts.end_time, ts.is_break, ts.label as slot_label
  FROM timetable_entries te
  JOIN subjects s ON te.subject_id = s.id
  JOIN sections sec ON te.section_id = sec.id
  JOIN faculty f ON te.faculty_id = f.id
  JOIN rooms r ON te.room_id = r.id
  JOIN working_days wd ON te.day_id = wd.id
  JOIN time_slots ts ON te.slot_id = ts.id
  WHERE te.version_id = ?
  ORDER BY wd.day_index, ts.slot_no
`).all(ver.id);

if (entries.length === 0) {
  entries = getProjectedTimetableEntries(db, ver.id);
}

console.log('Total entries evaluated:', entries.length);

const res = evaluateTimetableConflicts(entries, masterData);
console.log('\n=== evaluateTimetableConflicts (default) ===');
console.log('errorCount:', res.errorCount, 'warningCount:', res.warningCount);
const counts = {};
for (const c of res.conflicts) {
  counts[c.type + ' [' + c.severity + ']'] = (counts[c.type + ' [' + c.severity + ']'] || 0) + 1;
}
console.log('Counts:', counts);

const resOpt = evaluateTimetableConflicts(entries, masterData, { isGeneratingOrEditing: true });
console.log('\n=== evaluateTimetableConflicts (isGeneratingOrEditing: true) ===');
console.log('errorCount:', resOpt.errorCount, 'warningCount:', resOpt.warningCount);
const countsOpt = {};
for (const c of resOpt.conflicts) {
  countsOpt[c.type + ' [' + c.severity + ']'] = (countsOpt[c.type + ' [' + c.severity + ']'] || 0) + 1;
}
console.log('Counts:', countsOpt);

const backRes = validateTimetable(entries);
console.log('\n=== Backend validateTimetable ===');
console.log('errorCount:', backRes.errorCount, 'warningCount:', backRes.warningCount);
const backCounts = {};
for (const c of backRes.violations) {
  backCounts[c.code + ' [' + c.severity + ']'] = (backCounts[c.code + ' [' + c.severity + ']'] || 0) + 1;
}
console.log('Counts:', backCounts);
