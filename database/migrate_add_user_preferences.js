import pool from './connection.js';

async function addUserPreferencesColumn() {
  let connection;
  try {
    console.log('🔄 Checking if preferences column exists...');
    
    connection = await pool.getConnection();
    
    // Check if column exists
    const [columns] = await connection.execute(`
      SELECT COLUMN_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = DATABASE() 
      AND TABLE_NAME = 'users' 
      AND COLUMN_NAME = 'preferences'
    `);
    
    if (columns.length > 0) {
      console.log('✅ Column preferences already exists');
      connection.release();
      return;
    }
    
    // Add column if it doesn't exist
    console.log('➕ Adding preferences column to users table...');
    // Try to add after favorite_genre, if it doesn't exist, add at the end
    try {
      await connection.execute(`
        ALTER TABLE users 
        ADD COLUMN preferences JSON DEFAULT NULL AFTER favorite_genre
      `);
    } catch (error) {
      if (error.code === 'ER_BAD_FIELD_ERROR') {
        // favorite_genre doesn't exist, add at the end
        console.log('⚠️ favorite_genre column not found, adding preferences at the end');
        await connection.execute(`
          ALTER TABLE users 
          ADD COLUMN preferences JSON DEFAULT NULL
        `);
      } else {
        throw error;
      }
    }
    
    console.log('✅ Column preferences added successfully');
    connection.release();
  } catch (error) {
    if (connection) {
      connection.release();
    }
    console.error('❌ Error adding preferences column:', error.message);
    throw error;
  }
}

// Run migration
addUserPreferencesColumn()
  .then(() => {
    console.log('✅ Migration completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  });

