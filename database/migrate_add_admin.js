import pool from './connection.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function migrateAddAdmin() {
  let connection;
  try {
    connection = await pool.getConnection();
    
    // Check if column already exists
    const [columns] = await connection.execute('DESCRIBE users');
    const columnExists = columns.some((col) => col.Field === 'is_admin');
    
    if (columnExists) {
      console.log('✅ Column is_admin already exists in users table');
      return;
    }
    
    // Read SQL file
    const sqlPath = path.join(__dirname, 'add_admin_column.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    
    // Execute migration
    await connection.execute(sql);
    console.log('✅ Successfully added is_admin column to users table');
    
  } catch (error) {
    if (error.code === 'ER_DUP_FIELDNAME') {
      console.log('✅ Column is_admin already exists');
    } else {
      console.error('❌ Error adding is_admin column:', error);
      throw error;
    }
  } finally {
    if (connection) connection.release();
    await pool.end();
  }
}

migrateAddAdmin().catch(console.error);

