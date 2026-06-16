import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { OAuth2Client } from 'google-auth-library';
import pool from '../database/connection.js';

const router = express.Router();

// Initialize Google OAuth client
const googleClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);

// Register
router.post('/register', async (req, res) => {
  let connection;
  try {
    console.log('📝 Register request received');
    
    const { email, password, full_name, date_of_birth } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Validate password length
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long' });
    }

    // Get connection from pool
    connection = await pool.getConnection();

    // Check if user exists
    const [existingUsers] = await connection.execute(
      'SELECT id FROM users WHERE email = ?',
      [email]
    );

    if (existingUsers.length > 0) {
      connection.release();
      return res.status(400).json({ error: 'User with this email already exists' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user
    const userId = uuidv4();
    
    // Validate and format date_of_birth if provided
    let formattedDateOfBirth = null;
    if (date_of_birth) {
      try {
        // Ensure date is in YYYY-MM-DD format
        const dateObj = new Date(date_of_birth);
        if (isNaN(dateObj.getTime())) {
          throw new Error('Invalid date format');
        }
        // Check if date is valid (not in future, reasonable range)
        const today = new Date();
        const minDate = new Date('1900-01-01');
        if (dateObj > today || dateObj < minDate) {
          throw new Error('Date out of valid range');
        }
        formattedDateOfBirth = dateObj.toISOString().split('T')[0];
      } catch (dateError) {
        console.warn('Invalid date_of_birth format, setting to null:', date_of_birth);
        formattedDateOfBirth = null;
      }
    }

    // Insert user with connection
    // Try with date_of_birth first, fallback to without it if column doesn't exist
    try {
      // First, check if date_of_birth column exists
      const [columns] = await connection.execute(`
        SELECT COLUMN_NAME 
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'users' 
        AND COLUMN_NAME = 'date_of_birth'
      `);
      
      const hasDateOfBirthColumn = columns.length > 0;
      
      if (hasDateOfBirthColumn) {
        // Insert with date_of_birth
        await connection.execute(
          'INSERT INTO users (id, email, password_hash, full_name, date_of_birth, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
          [userId, email.toLowerCase().trim(), passwordHash, full_name ? full_name.trim() : null, formattedDateOfBirth]
        );
        console.log('✅ User created successfully with date_of_birth:', userId);
      } else {
        // Insert without date_of_birth (column doesn't exist)
        console.warn('⚠️ date_of_birth column not found, inserting without it');
        await connection.execute(
          'INSERT INTO users (id, email, password_hash, full_name, created_at) VALUES (?, ?, ?, ?, NOW())',
          [userId, email.toLowerCase().trim(), passwordHash, full_name ? full_name.trim() : null]
        );
        console.log('✅ User created successfully (without date_of_birth):', userId);
      }
    } catch (insertError) {
      console.error('❌ INSERT error details:', {
        code: insertError.code,
        errno: insertError.errno,
        sqlMessage: insertError.sqlMessage,
        sqlState: insertError.sqlState
      });
      
      // Handle specific SQL errors
      if (insertError.code === 'ER_NO_SUCH_TABLE') {
        connection.release();
        return res.status(500).json({ 
          error: 'Database table does not exist',
          message: 'Please run: npm run init-db to initialize the database'
        });
      }
      
      if (insertError.code === 'ER_DUP_ENTRY') {
        connection.release();
        return res.status(400).json({ error: 'User with this email already exists' });
      }
      
      if (insertError.code === 'ER_BAD_FIELD_ERROR' && insertError.sqlMessage?.includes('date_of_birth')) {
        // If date_of_birth column doesn't exist, try without it
        try {
          await connection.execute(
            'INSERT INTO users (id, email, password_hash, full_name, created_at) VALUES (?, ?, ?, ?, NOW())',
            [userId, email.toLowerCase().trim(), passwordHash, full_name ? full_name.trim() : null]
          );
          console.log('✅ User created successfully (retry without date_of_birth):', userId);
        } catch (retryError) {
          connection.release();
          return res.status(500).json({ 
            error: 'Registration failed',
            message: retryError.sqlMessage || retryError.message,
            details: {
              code: retryError.code,
              errno: retryError.errno,
              sqlMessage: retryError.sqlMessage,
              sqlState: retryError.sqlState
            }
          });
        }
      } else {
        connection.release();
        return res.status(500).json({ 
          error: 'Registration failed',
          message: insertError.sqlMessage || insertError.message,
          details: {
            code: insertError.code,
            errno: insertError.errno,
            sqlMessage: insertError.sqlMessage,
            sqlState: insertError.sqlState
          }
        });
      }
    }

    // Release connection after successful insert
    connection.release();
    connection = null;

    // Create JWT token
    const token = jwt.sign(
      { id: userId, email: email.toLowerCase().trim() },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '7d' }
    );

    res.status(201).json({
      user: {
        id: userId,
        email: email.toLowerCase().trim(),
        full_name: full_name ? full_name.trim() : null,
        date_of_birth: formattedDateOfBirth || null
      },
      token
    });
  } catch (error) {
    // Make sure connection is released on error
    if (connection) {
      connection.release();
    }
    
    console.error('❌ Register error:', error);
    console.error('Register error details:', {
      message: error.message,
      code: error.code,
      errno: error.errno,
      sqlMessage: error.sqlMessage,
      sqlState: error.sqlState
    });
    
    // Always return detailed error in development (default for local)
    const isDev = process.env.NODE_ENV !== 'production';
    
    const errorResponse = {
      error: 'Registration failed',
      message: error.message || 'Unknown error'
    };
    
    // Add SQL details if available
    if (error.code || error.sqlMessage) {
      errorResponse.details = {
        code: error.code,
        errno: error.errno,
        sqlMessage: error.sqlMessage,
        sqlState: error.sqlState
      };
      
      // Log full error details
      console.error('Full error object:', JSON.stringify(errorResponse, null, 2));
    }
    
    // Handle connection errors
    if (error.code === 'ECONNREFUSED' || error.code === 'ER_ACCESS_DENIED_ERROR') {
      return res.status(500).json({
        error: 'Database connection failed',
        message: 'Cannot connect to MySQL database. Please check your database configuration.'
      });
    }
    
    // In development, also include the full error message
    if (isDev) {
      errorResponse.stack = error.stack;
    }
    
    res.status(500).json(errorResponse);
  }
});

// Login
router.post('/login', async (req, res) => {
  let connection;
  try {
    const { email, password } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Get connection from pool
    connection = await pool.getConnection();

    // Find user (case-insensitive email lookup)
    const [users] = await connection.execute(
      'SELECT id, email, password_hash, full_name, avatar_url, is_artist, artist_id, is_admin FROM users WHERE LOWER(email) = LOWER(?)',
      [email.trim()]
    );

    if (users.length === 0) {
      connection.release();
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = users[0];

    // Check if user has a password (OAuth users might not have one)
    if (!user.password_hash) {
      connection.release();
      return res.status(401).json({ 
        error: 'This account was created with Google Sign-In. Please use Google Sign-In to log in.' 
      });
    }

    // Verify password
    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      connection.release();
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Create JWT token
    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '7d' }
    );

    connection.release();

    res.json({
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        avatar_url: user.avatar_url,
        is_artist: user.is_artist || false,
        artist_id: user.artist_id || null,
        is_admin: user.is_admin || false
      },
      token
    });
  } catch (error) {
    if (connection) {
      connection.release();
    }
    console.error('❌ Login error:', error);
    
    // Handle specific errors
    if (error.code === 'ER_NO_SUCH_TABLE') {
      return res.status(500).json({ 
        error: 'Database table does not exist',
        message: 'Please run: npm run init-db to initialize the database'
      });
    }
    
    res.status(500).json({ 
      error: 'Login failed',
      message: process.env.NODE_ENV !== 'production' ? error.message : undefined
    });
  }
});

// Google OAuth Login
router.post('/google', async (req, res) => {
  try {
    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({ error: 'Google ID token is required' });
    }

    // Verify the Google ID token
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload) {
      return res.status(401).json({ error: 'Invalid Google token' });
    }

    const { email, name, picture, sub: googleId } = payload;

    if (!email) {
      return res.status(400).json({ error: 'Email not provided by Google' });
    }

    // Check if user exists
    const [existingUsers] = await pool.execute(
      'SELECT id, email, full_name, avatar_url, is_artist, artist_id FROM users WHERE email = ?',
      [email]
    );

    let user;
    let userId;

    if (existingUsers.length > 0) {
      // User exists, update avatar if needed
      user = existingUsers[0];
      userId = user.id;

      // Update avatar if Google provided one and user doesn't have one
      if (picture && !user.avatar_url) {
        await pool.execute(
          'UPDATE users SET avatar_url = ? WHERE id = ?',
          [picture, userId]
        );
        user.avatar_url = picture;
      }

      // Update name if Google provided one and user doesn't have one
      if (name && !user.full_name) {
        await pool.execute(
          'UPDATE users SET full_name = ? WHERE id = ?',
          [name, userId]
        );
        user.full_name = name;
      }
    } else {
      // Create new user
      userId = uuidv4();
      await pool.execute(
        'INSERT INTO users (id, email, full_name, avatar_url, password_hash) VALUES (?, ?, ?, ?, ?)',
        [userId, email, name || null, picture || null, null] // No password for OAuth users
      );

      const [newUsers] = await pool.execute(
        'SELECT id, email, full_name, avatar_url, is_artist, artist_id FROM users WHERE id = ?',
        [userId]
      );
      user = newUsers[0];
    }

    // Create JWT token
    const token = jwt.sign(
      { id: userId, email },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '7d' }
    );

    res.json({
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        avatar_url: user.avatar_url,
        is_artist: user.is_artist,
        artist_id: user.artist_id
      },
      token
    });
  } catch (error) {
    console.error('Google auth error:', error);
    res.status(500).json({ error: 'Google authentication failed' });
  }
});

// Get current user
router.get('/me', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    
    // Try to get all fields, but handle case where new columns might not exist yet
    let users;
    try {
      [users] = await pool.execute(
        'SELECT id, email, full_name, avatar_url, date_of_birth, bio, location, favorite_genre, is_artist, artist_id, is_admin, created_at FROM users WHERE id = ?',
        [decoded.id]
      );
    } catch (selectError) {
      // If columns don't exist, fallback to basic columns
      if (selectError.code === 'ER_BAD_FIELD_ERROR') {
        console.warn('New profile columns not found, using basic columns');
        [users] = await pool.execute(
          'SELECT id, email, full_name, avatar_url, date_of_birth, is_artist, artist_id, is_admin, created_at FROM users WHERE id = ?',
          [decoded.id]
        );
        // Add null values for missing columns
        if (users.length > 0) {
          users[0].bio = null;
          users[0].location = null;
          users[0].favorite_genre = null;
        }
      } else {
        throw selectError;
      }
    }

    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user: users[0] });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(401).json({ error: 'Invalid token' });
  }
});

export default router;

