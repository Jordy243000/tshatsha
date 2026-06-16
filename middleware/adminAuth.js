import { authenticateToken } from './auth.js';
import pool from '../database/connection.js';

// Middleware pour vérifier si l'utilisateur est admin
export const requireAdmin = async (req, res, next) => {
  try {
    // D'abord vérifier l'authentification
    await new Promise((resolve, reject) => {
      authenticateToken(req, res, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve(true);
        }
      });
    });

    // Vérifier si l'utilisateur est admin
    if (!req.user || !req.user.id) {
      console.error('requireAdmin: Utilisateur non authentifié');
      return res.status(401).json({ error: 'Utilisateur non authentifié' });
    }

    const userId = req.user.id;
    const [users] = await pool.execute(
      'SELECT is_admin FROM users WHERE id = ?',
      [userId]
    );

    if (users.length === 0) {
      console.error(`requireAdmin: Utilisateur ${userId} non trouvé`);
      return res.status(403).json({ error: 'Utilisateur non trouvé' });
    }

    if (!users[0].is_admin) {
      console.error(`requireAdmin: Utilisateur ${userId} n'est pas admin`);
      return res.status(403).json({ error: 'Accès refusé. Administrateur requis.' });
    }

    next();
  } catch (error) {
    console.error('Erreur dans requireAdmin:', error);
    console.error('Détails:', {
      message: error.message,
      stack: error.stack
    });
    if (res.headersSent) {
      return next(error);
    }
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }
};

export default requireAdmin;

