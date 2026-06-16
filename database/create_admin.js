import pool from './connection.js';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

async function createAdmin(email = null, password = null, fullName = null) {
  let connection;
  try {
    console.log('🔐 Création d\'un compte administrateur\n');
    
    // Get user input if not provided as arguments
    let finalEmail = email;
    let finalPassword = password;
    let finalFullName = fullName;
    
    if (!finalEmail) {
      finalEmail = await question('Email: ');
    }
    if (!finalPassword) {
      finalPassword = await question('Mot de passe (min 8 caractères): ');
    }
    if (!finalFullName) {
      finalFullName = await question('Nom complet (optionnel): ') || null;
    }
    
    // Validate input
    if (!finalEmail || !finalPassword) {
      console.error('❌ Email et mot de passe sont requis');
      rl.close();
      process.exit(1);
    }
    
    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(finalEmail)) {
      console.error('❌ Format d\'email invalide');
      rl.close();
      process.exit(1);
    }
    
    // Validate password length
    if (finalPassword.length < 8) {
      console.error('❌ Le mot de passe doit contenir au moins 8 caractères');
      rl.close();
      process.exit(1);
    }
    
    connection = await pool.getConnection();
    
    // Check if user already exists
    const [existingUsers] = await connection.execute(
      'SELECT id, is_admin FROM users WHERE email = ?',
      [finalEmail]
    );
    
    if (existingUsers.length > 0) {
      const user = existingUsers[0];
      const passwordHash = await bcrypt.hash(finalPassword, 10);
      await connection.execute(
        'UPDATE users SET is_admin = true, password_hash = ?, updated_at = NOW() WHERE id = ?',
        [passwordHash, user.id]
      );
      console.log(`\n✅ Utilisateur existant mis à jour (admin + mot de passe) (ID: ${user.id})`);
    } else {
      // Create new admin user
      const userId = uuidv4();
      const passwordHash = await bcrypt.hash(finalPassword, 10);
      
      await connection.execute(
        'INSERT INTO users (id, email, password_hash, full_name, is_admin, created_at, updated_at) VALUES (?, ?, ?, ?, true, NOW(), NOW())',
        [userId, finalEmail, passwordHash, finalFullName]
      );
      
      console.log(`\n✅ Compte administrateur créé avec succès (ID: ${userId})`);
    }
    
    console.log(`\n📧 Email: ${finalEmail}`);
    console.log(`👤 Nom: ${finalFullName || 'Non spécifié'}`);
    console.log(`🔑 Statut: Administrateur\n`);
    
  } catch (error) {
    console.error('❌ Erreur lors de la création du compte admin:', error.message);
    if (error.code === 'ER_DUP_ENTRY') {
      console.error('❌ Un utilisateur avec cet email existe déjà');
    }
  } finally {
    if (connection) connection.release();
    rl.close();
    await pool.end();
  }
}

// Get command line arguments (email, password, fullName)
const args = process.argv.slice(2);
const email = args[0] || null;
const password = args[1] || null;
const fullName = args[2] || null;

createAdmin(email, password, fullName).catch(console.error);

