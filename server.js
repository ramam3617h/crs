// server.js - Node.js Express Backend with MySQL
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const bodyParser = require('body-parser');

//require('dotenv').config();
if (process.env.NODE_ENV !== 'production' )
{ require('dotenv').config(); }
const app = express();
const PORT = 5000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// MySQL Connection Pool
const pool = mysql.createPool({
  host: process.env.CDB_HOST,
  user: process.env.CDB_USER,
  password: process.env.CDB_PASSWORD,
  database: process.env.CDB_NAME,
  waitForConnections: true,
  connectionLimit: process.env.CDB_CONNECTION_LIMIT,
  queueLimit: 0
});
// MySQL Connection Pool
/*const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: 'your_password',
  database: 'candidate_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});
*/
// Test database connection
pool.getConnection()
  .then(connection => {
    console.log('✅ Database connected successfully');
    connection.release();
  })
  .catch(err => {
    console.error('❌ Database connection failed:', err);
  });

// ==================== API ROUTES ====================

// Get all candidates with optional filters
app.get('/api/candidates', async (req, res) => {
  try {
    const { status, search } = req.query;
    let query = 'SELECT * FROM candidates WHERE 1=1';
    const params = [];

    if (status && status !== 'all') {
      query += ' AND status = ?';
      params.push(status);
    }

    if (search) {
      query += ' AND (name LIKE ? OR email LIKE ? OR position LIKE ?)';
      const searchPattern = `%${search}%`;
      params.push(searchPattern, searchPattern, searchPattern);
    }

    query += ' ORDER BY created_at DESC';

    const [rows] = await pool.execute(query, params);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching candidates:', error);
    res.status(500).json({ error: 'Failed to fetch candidates' });
  }
});

// Get single candidate by ID
app.get('/api/candidates/:id', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM candidates WHERE id = ?',
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Candidate not found' });
    }

    res.json(rows[0]);
  } catch (error) {
    console.error('Error fetching candidate:', error);
    res.status(500).json({ error: 'Failed to fetch candidate' });
  }
});

// Create new candidate
app.post('/api/candidates', async (req, res) => {
  try {
    const { name, email, phone, position, resume, coverLetter } = req.body;

    // Validation
    if (!name || !email || !phone || !position) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Check if email already exists
    const [existing] = await pool.execute(
      'SELECT id FROM candidates WHERE email = ?',
      [email]
    );

    if (existing.length > 0) {
      return res.status(409).json({ error: 'Email already exists' });
    }

    // Insert candidate
    const [result] = await pool.execute(
      `INSERT INTO candidates (name, email, phone, position, resume, cover_letter, applied_date) 
       VALUES (?, ?, ?, ?, ?, ?, CURDATE())`,
      [name, email, phone, position, resume || null, coverLetter || null]
    );

    // Create notification
    await pool.execute(
      `INSERT INTO notifications (candidate_id, message) 
       VALUES (?, ?)`,
      [result.insertId, `New candidate registered: ${name} for ${position}`]
    );

    // Get the created candidate
    const [newCandidate] = await pool.execute(
      'SELECT * FROM candidates WHERE id = ?',
      [result.insertId]
    );

    res.status(201).json(newCandidate[0]);
  } catch (error) {
    console.error('Error creating candidate:', error);
    res.status(500).json({ error: 'Failed to create candidate' });
  }
});

// Update candidate status
app.patch('/api/candidates/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const candidateId = req.params.id;

    if (!['pending', 'approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    // Get candidate info
    const [candidate] = await pool.execute(
      'SELECT name, position FROM candidates WHERE id = ?',
      [candidateId]
    );

    if (candidate.length === 0) {
      return res.status(404).json({ error: 'Candidate not found' });
    }

    // Update status
    await pool.execute(
      'UPDATE candidates SET status = ? WHERE id = ?',
      [status, candidateId]
    );

    // Create history record
    await pool.execute(
      `INSERT INTO application_history (candidate_id, status, changed_by, notes) 
       VALUES (?, ?, ?, ?)`,
      [candidateId, status, 'System Admin', `Status changed to ${status}`]
    );

    // Create notification
    const message = `Application ${status} for ${candidate[0].name} - ${candidate[0].position}`;
    await pool.execute(
      `INSERT INTO notifications (candidate_id, message) 
       VALUES (?, ?)`,
      [candidateId, message]
    );

    res.json({ success: true, status });
  } catch (error) {
    console.error('Error updating status:', error);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// Delete candidate
app.delete('/api/candidates/:id', async (req, res) => {
  try {
    const [result] = await pool.execute(
      'DELETE FROM candidates WHERE id = ?',
      [req.params.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Candidate not found' });
    }

    res.json({ success: true, message: 'Candidate deleted' });
  } catch (error) {
    console.error('Error deleting candidate:', error);
    res.status(500).json({ error: 'Failed to delete candidate' });
  }
});

// Get all notifications
app.get('/api/notifications', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT n.*, c.name as candidate_name 
       FROM notifications n
       LEFT JOIN candidates c ON n.candidate_id = c.id
       ORDER BY n.created_at DESC
       LIMIT 50`
    );

    // Format timestamps
    const formatted = rows.map(row => ({
      ...row,
      time: formatTimeAgo(new Date(row.created_at))
    }));

    res.json(formatted);
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// Mark notification as read
app.patch('/api/notifications/:id/read', async (req, res) => {
  try {
    await pool.execute(
      'UPDATE notifications SET is_read = TRUE WHERE id = ?',
      [req.params.id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating notification:', error);
    res.status(500).json({ error: 'Failed to update notification' });
  }
});

// Get dashboard statistics
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const [stats] = await pool.execute(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected
      FROM candidates
    `);

    res.json(stats[0]);
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// Get application history for a candidate
app.get('/api/candidates/:id/history', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT * FROM application_history 
       WHERE candidate_id = ? 
       ORDER BY created_at DESC`,
      [req.params.id]
    );

    res.json(rows);
  } catch (error) {
    console.error('Error fetching history:', error);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// Get all positions
app.get('/api/positions', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM positions WHERE is_active = TRUE ORDER BY title'
    );

    res.json(rows);
  } catch (error) {
    console.error('Error fetching positions:', error);
    res.status(500).json({ error: 'Failed to fetch positions' });
  }
});

// Helper function to format time ago
function formatTimeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);
  
  let interval = Math.floor(seconds / 31536000);
  if (interval > 1) return interval + ' years ago';
  if (interval === 1) return '1 year ago';
  
  interval = Math.floor(seconds / 2592000);
  if (interval > 1) return interval + ' months ago';
  if (interval === 1) return '1 month ago';
  
  interval = Math.floor(seconds / 86400);
  if (interval > 1) return interval + ' days ago';
  if (interval === 1) return '1 day ago';
  
  interval = Math.floor(seconds / 3600);
  if (interval > 1) return interval + ' hours ago';
  if (interval === 1) return '1 hour ago';
  
  interval = Math.floor(seconds / 60);
  if (interval > 1) return interval + ' minutes ago';
  if (interval === 1) return '1 minute ago';
  
  return 'just now';
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
