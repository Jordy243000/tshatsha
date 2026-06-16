import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'tshatshastream',
  multipleStatements: true
};

async function migrate() {
  let connection;
  try {
    console.log('🔌 Connexion à la base de données...');
    connection = await mysql.createConnection(dbConfig);
    console.log('✅ Connecté à la base de données');

    const schemaPath = join(__dirname, 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf8');

    // Extraire uniquement la partie artist_applications
    const tableMatch = schema.match(/CREATE TABLE IF NOT EXISTS artist_applications[\s\S]*?ENGINE=InnoDB[^;]*;/);
    
    if (!tableMatch) {
      console.error('❌ Impossible de trouver la définition de la table artist_applications dans schema.sql');
      process.exit(1);
    }

    const createTableSQL = tableMatch[0];
    
    console.log('📦 Création de la table artist_applications...');
    await connection.query(createTableSQL);
    console.log('✅ Table artist_applications créée avec succès');

    // Vérifier que la table existe
    const [tables] = await connection.query(
      "SHOW TABLES LIKE 'artist_applications'"
    );
    
    if (tables.length > 0) {
      console.log('✅ Vérification: La table artist_applications existe');
    } else {
      console.error('❌ La table artist_applications n\'a pas été créée');
      process.exit(1);
    }

  } catch (error) {
    console.error('❌ Erreur lors de la migration:', error);
    if (error.code === 'ER_TABLE_EXISTS_ERROR') {
      console.log('ℹ️  La table existe déjà, c\'est normal');
    } else {
      process.exit(1);
    }
  } finally {
    if (connection) {
      await connection.end();
      console.log('🔌 Déconnexion de la base de données');
    }
  }
}

migrate();

