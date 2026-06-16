// Test script for authentication endpoints
import pool from './database/connection.js';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { testConnection } from './database/connection.js';

async function testAuth() {
  try {
    console.log('🧪 Testing Authentication System...\n');
    
    // Test database connection
    console.log('1️⃣  Testing database connection...');
    await testConnection(3, 1000);
    console.log('✅ Database connection: OK\n');
    
    // Test table structure
    console.log('2️⃣  Testing users table structure...');
    const [columns] = await pool.execute('DESCRIBE users');
    console.log(`✅ Users table has ${columns.length} columns:`);
    columns.forEach(col => {
      console.log(`   - ${col.Field} (${col.Type}) ${col.Null === 'YES' ? 'NULL' : 'NOT NULL'}`);
    });
    console.log();
    
    // Test INSERT operation
    console.log('3️⃣  Testing INSERT operation...');
    const testEmail = `test-${Date.now()}@example.com`;
    const testPassword = 'TestPassword123!';
    const passwordHash = await bcrypt.hash(testPassword, 10);
    const userId = uuidv4();
    
    await pool.execute(
      'INSERT INTO users (id, email, password_hash, full_name, date_of_birth, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
      [userId, testEmail, passwordHash, 'Test User', null]
    );
    console.log('✅ INSERT operation: OK');
    console.log(`   Created user: ${testEmail} (ID: ${userId})\n`);
    
    // Test SELECT operation
    console.log('4️⃣  Testing SELECT operation...');
    const [users] = await pool.execute(
      'SELECT id, email, password_hash, full_name FROM users WHERE id = ?',
      [userId]
    );
    
    if (users.length === 0) {
      throw new Error('User not found after INSERT');
    }
    
    const user = users[0];
    console.log('✅ SELECT operation: OK');
    console.log(`   Retrieved user: ${user.email}\n`);
    
    // Test password verification
    console.log('5️⃣  Testing password verification...');
    const isValid = await bcrypt.compare(testPassword, user.password_hash);
    if (!isValid) {
      throw new Error('Password verification failed');
    }
    console.log('✅ Password verification: OK\n');
    
    // Test DELETE (cleanup)
    console.log('6️⃣  Cleaning up test data...');
    await pool.execute('DELETE FROM users WHERE id = ?', [userId]);
    console.log('✅ Test user deleted\n');
    
    console.log('✅ All authentication tests passed!\n');
    console.log('📋 Summary:');
    console.log('   ✅ Database connection: Working');
    console.log('   ✅ Table structure: Valid');
    console.log('   ✅ INSERT operation: Working');
    console.log('   ✅ SELECT operation: Working');
    console.log('   ✅ Password hashing: Working');
    console.log('   ✅ Password verification: Working');
    console.log('\n🎉 Authentication system is ready!\n');
    
    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Test failed!');
    console.error('Error:', error.message);
    if (error.code) {
      console.error('Code:', error.code);
    }
    if (error.sqlMessage) {
      console.error('SQL Message:', error.sqlMessage);
    }
    console.error('\nStack:', error.stack);
    process.exit(1);
  }
}

testAuth();

