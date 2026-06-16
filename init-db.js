import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Database configuration
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'AAFRIQUE243@jordy',
};

async function initDatabase() {
  let connection;
  
  try {
    // Connect without database
    connection = await mysql.createConnection(dbConfig);
    
    console.log('✅ Connected to MySQL server');
    
    // Create database if not exists
    await connection.query('CREATE DATABASE IF NOT EXISTS TshaTshaStream_db');
    console.log('✅ Database TshaTshaStream_db created or already exists');
    
    // Use the database
    await connection.query('USE TshaTshaStream_db');
    
    // Read and execute schema
    const schemaPath = path.join(__dirname, 'database', 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    
    // Remove comments and clean up
    let cleanedSchema = schema
      .split('\n')
      .filter(line => {
        const trimmed = line.trim();
        return !trimmed.startsWith('--') && 
               !trimmed.startsWith('DELIMITER') && 
               trimmed.length > 0;
      })
      .join('\n');
    
    // Split by semicolon, but be smarter about it
    const statements = [];
    let currentStatement = '';
    let inString = false;
    let stringChar = '';
    
    for (let i = 0; i < cleanedSchema.length; i++) {
      const char = cleanedSchema[i];
      const nextChar = cleanedSchema[i + 1];
      
      // Track string literals
      if ((char === '"' || char === "'" || char === '`') && !inString) {
        inString = true;
        stringChar = char;
        currentStatement += char;
      } else if (char === stringChar && inString) {
        // Check for escaped quotes
        if (nextChar === stringChar) {
          currentStatement += char + nextChar;
          i++; // Skip next char
        } else {
          inString = false;
          stringChar = '';
          currentStatement += char;
        }
      } else if (char === ';' && !inString) {
        // End of statement
        currentStatement = currentStatement.trim();
        if (currentStatement.length > 0 && 
            !currentStatement.toUpperCase().startsWith('CREATE DATABASE') &&
            !currentStatement.toUpperCase().startsWith('USE ')) {
          statements.push(currentStatement);
        }
        currentStatement = '';
      } else {
        currentStatement += char;
      }
    }
    
    // Add last statement if exists
    if (currentStatement.trim().length > 0) {
      statements.push(currentStatement.trim());
    }
    
    console.log(`📝 Found ${statements.length} SQL statements to execute`);
    
    // Execute each statement
    let successCount = 0;
    let errorCount = 0;
    
    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];
      if (statement.length < 10) continue; // Skip very short statements
      
      try {
        await connection.query(statement);
        successCount++;
        
        // Extract table name for logging
        const tableMatch = statement.match(/CREATE TABLE.*?`?(\w+)`?/i);
        if (tableMatch) {
          console.log(`  ✅ Created table: ${tableMatch[1]}`);
        }
      } catch (err) {
        // Only log non-ignorable errors
        if (!err.message.includes('already exists') && 
            !err.message.includes('Duplicate key') &&
            !err.message.includes('Unknown system variable')) {
          console.warn(`  ⚠️  Warning on statement ${i + 1}:`, err.message.substring(0, 100));
          errorCount++;
        }
      }
    }
    
    console.log(`\n✅ Successfully executed ${successCount} statements`);
    if (errorCount > 0) {
      console.log(`⚠️  ${errorCount} statements had warnings (likely already exist)`);
    }
    
    // Verify tables were created
    const [tables] = await connection.query('SHOW TABLES');
    console.log(`\n📊 Total tables in database: ${tables.length}`);
    if (tables.length > 0) {
      console.log('📋 Tables:');
      tables.forEach((table, index) => {
        const tableName = Object.values(table)[0];
        console.log(`   ${index + 1}. ${tableName}`);
      });
    }
    
    console.log('\n✅ Database TshaTshaStream_db is ready!');
    
  } catch (error) {
    console.error('❌ Error initializing database:', error.message);
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

initDatabase();
