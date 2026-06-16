import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

// Database configuration
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'AAFRIQUE243@jordy',
  database: process.env.DB_NAME || 'TshaTshaStream_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  // Handle connection errors
  multipleStatements: false
};

console.log('🔌 Initializing MySQL connection pool...');
console.log('   Host:', dbConfig.host);
console.log('   Port:', dbConfig.port);
console.log('   User:', dbConfig.user);
console.log('   Database:', dbConfig.database);

// Create pool with robust error handling
const pool = mysql.createPool(dbConfig);

// Function to test and verify connection
async function testConnection(retries = 5, delay = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      const connection = await pool.getConnection();
      console.log('✅ Successfully connected to MySQL database:', dbConfig.database);
      
      // Test query to ensure database exists
      await connection.query('SELECT 1');
      
      // Verify users table exists and has correct structure
      try {
        const [tables] = await connection.query(
          "SHOW TABLES LIKE 'users'"
        );
        
        if (tables.length === 0) {
          console.warn('⚠️  Table "users" does not exist. Please run: npm run init-db');
        } else {
          // Check table structure
          const [columns] = await connection.query('DESCRIBE users');
          console.log('✅ Users table exists with', columns.length, 'columns');
          
          // Verify required columns exist
          const columnNames = columns.map(col => col.Field);
          const requiredColumns = ['id', 'email', 'password_hash'];
          const missingColumns = requiredColumns.filter(col => !columnNames.includes(col));
          
          if (missingColumns.length > 0) {
            console.error('❌ Missing required columns:', missingColumns.join(', '));
            console.error('   Please run: npm run init-db');
          } else {
            console.log('✅ All required columns present in users table');
          }
        }
      } catch (tableError) {
        console.error('❌ Error checking users table:', tableError.message);
      }
      
      connection.release();
      return true;
    } catch (error) {
      console.error(`❌ Connection attempt ${i + 1}/${retries} failed:`, error.message);
      
      if (i < retries - 1) {
        console.log(`   Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        console.error('❌ Failed to connect to MySQL after', retries, 'attempts');
        console.error('   Please check:');
        console.error('   1. MySQL server is running');
        console.error('   2. Database credentials are correct');
        console.error('   3. Database exists (run: npm run init-db)');
        throw error;
      }
    }
  }
  return false;
}

// Handle pool errors
pool.on('connection', (connection) => {
  console.log('🔗 New MySQL connection established as id', connection.threadId);
});

pool.on('error', (err) => {
  console.error('❌ MySQL pool error:', err);
  if (err.code === 'PROTOCOL_CONNECTION_LOST') {
    console.log('   Attempting to reconnect...');
  }
});

// Export pool and test function
export default pool;
export { testConnection };

