// Test script to check if registration works
import pool from './database/connection.js';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';

async function testRegister() {
  try {
    console.log('Testing database connection...');
    const connection = await pool.getConnection();
    console.log('✅ Database connected');
    connection.release();

    // Test INSERT
    console.log('\nTesting INSERT...');
    const testEmail = `test-${Date.now()}@example.com`;
    const testPassword = 'testpassword123';
    const passwordHash = await bcrypt.hash(testPassword, 10);
    const userId = uuidv4();

    console.log('Attempting INSERT with:', {
      userId,
      email: testEmail,
      hasPassword: !!passwordHash,
      full_name: 'Test User',
      date_of_birth: null
    });

    const [result] = await pool.execute(
      'INSERT INTO users (id, email, password_hash, full_name, date_of_birth) VALUES (?, ?, ?, ?, ?)',
      [userId, testEmail, passwordHash, 'Test User', null]
    );

    console.log('✅ INSERT successful!');
    console.log('Result:', result);

    // Clean up test user
    await pool.execute('DELETE FROM users WHERE id = ?', [userId]);
    console.log('✅ Test user cleaned up');

    // Check table structure
    console.log('\nChecking table structure...');
    const [columns] = await pool.execute('DESCRIBE users');
    console.log('Users table columns:');
    columns.forEach(col => {
      console.log(`  - ${col.Field} (${col.Type}) ${col.Null === 'YES' ? 'NULL' : 'NOT NULL'}`);
    });

    await pool.end();
    console.log('\n✅ All tests passed!');
  } catch (error) {
    console.error('❌ Test failed!');
    console.error('Error:', error.message);
    console.error('Code:', error.code);
    console.error('SQL Message:', error.sqlMessage);
    console.error('SQL State:', error.sqlState);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

testRegister();

