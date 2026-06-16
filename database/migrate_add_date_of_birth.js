import pool from './connection.js';

async function addDateOfBirthColumn() {
  let connection;
  try {
    console.log('🔄 Checking if date_of_birth column exists...');
    
    connection = await pool.getConnection();
    
    // Check if column exists
    const [columns] = await connection.execute(`
      SELECT COLUMN_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = DATABASE() 
      AND TABLE_NAME = 'users' 
      AND COLUMN_NAME = 'date_of_birth'
    `);
    
    if (columns.length > 0) {
      console.log('✅ Column date_of_birth already exists');
      connection.release();
      return;
    }
    
    // Add column if it doesn't exist
    console.log('➕ Adding date_of_birth column to users table...');
    await connection.execute(`
      ALTER TABLE users 
      ADD COLUMN date_of_birth DATE AFTER full_name
    `);
    
    console.log('✅ Column date_of_birth added successfully');
    connection.release();
  } catch (error) {
    if (connection) {
      connection.release();
    }
    console.error('❌ Error adding date_of_birth column:', error.message);
    throw error;
  }
}

// Run migration
addDateOfBirthColumn()
  .then(() => {
    console.log('✅ Migration completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  });

