import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth.js';
import musicRoutes from './routes/music.js';
import playlistRoutes from './routes/playlists.js';
import subscriptionRoutes from './routes/subscriptions.js';
import concertRoutes from './routes/concerts.js';
import artistRoutes from './routes/artists.js';
import artistApplicationRoutes from './routes/artistApplications.js';
import professionalAccountRoutes, { ensureProfessionalTables } from './routes/professionalAccounts.js';
import producerStudioRoutes, { ensureProducerTables } from './routes/producers.js';
import distributorStudioRoutes, { ensureDistributorTables } from './routes/distributors.js';
import artistStudioRoutes, { ensureArtistStudioTables } from './routes/artistStudio.js';
import { ensureStreamRoyaltyTables, processQuarterlyPayouts } from './services/streamRoyaltyService.js';
import { producerRouter, distributorRouter } from './routes/professionalApplications.js';
import userRoutes from './routes/users.js';
import adminRoutes from './routes/admin.js';
import albumRoutes from './routes/albums.js';
import liveRoutes, { ensureLiveTables, bootstrapLiveDemoSessions } from './routes/live.js';
import releaseRoutes from './routes/releases.js';
import { ensureReleaseWorkflowTables, bootstrapInternalDistributor } from './services/releaseWorkflowService.js';
import pool, { testConnection } from './database/connection.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { getFromS3 } from './services/s3Service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

const defaultOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://localhost:5176',
  'http://localhost:5177',
];

const isLocalDevOrigin = (origin) =>
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

// Middleware
app.use(cors({
  origin: (origin, callback) => {
    // Requêtes sans Origin (apps mobiles, curl, Postman)
    if (!origin) return callback(null, true);

    const allowed = process.env.FRONTEND_URL?.split(',').map((s) => s.trim()).filter(Boolean) || defaultOrigins;
    if (allowed.includes(origin)) return callback(null, true);

    // Dev : Flutter web utilise un port aléatoire (ex. localhost:58888)
    if (process.env.NODE_ENV !== 'production' && isLocalDevOrigin(origin)) {
      return callback(null, true);
    }

    console.warn(`CORS blocked origin: ${origin}`);
    callback(null, false);
  },
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/music', musicRoutes);
app.use('/api/playlists', playlistRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/concerts', concertRoutes);
app.use('/api/artists', artistRoutes);
app.use('/api/artist-applications', artistApplicationRoutes);
app.use('/api/professional-accounts', professionalAccountRoutes);
app.use('/api/producer-applications', producerRouter);
app.use('/api/producers', producerStudioRoutes);
app.use('/api/distributor-applications', distributorRouter);
app.use('/api/distributors', distributorStudioRoutes);
app.use('/api/artist-studio', artistStudioRoutes);
app.use('/api/users', userRoutes);
app.use('/api/albums', albumRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/live', liveRoutes);
app.use('/api/releases', releaseRoutes);

// Audio proxy route to bypass CORS issues
app.get('/api/audio-proxy', async (req, res) => {
  let fileData;
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'URL parameter is required' });
    }

    // Vérifier que l'URL est une URL S3 valide
    if (!url.includes('amazonaws.com') && !url.includes('s3.')) {
      return res.status(400).json({ error: 'Invalid S3 URL' });
    }

    // Récupérer le fichier depuis S3
    fileData = await getFromS3(url);
    
    // Définir les en-têtes appropriés
    res.setHeader('Content-Type', fileData.ContentType || 'audio/mpeg');
    if (fileData.ContentLength) {
      res.setHeader('Content-Length', fileData.ContentLength.toString());
    }
    res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache 1 an
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Accept-Ranges', 'bytes'); // Support for range requests
    
    // Streamer le fichier directement depuis S3
    if (fileData.Body) {
      // Le Body est un ReadableStream, on peut le pipe directement
      // Gérer les erreurs de stream
      fileData.Body.on('error', (error) => {
        console.error('Stream error:', error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Stream error' });
        } else if (!res.writableEnded) {
          res.end();
        }
      });
      
      // Gérer la fin du stream
      fileData.Body.on('end', () => {
        if (!res.writableEnded) {
          res.end();
        }
      });
      
      // Gérer la fermeture de la connexion client
      req.on('close', () => {
        if (fileData.Body && typeof fileData.Body.destroy === 'function') {
          fileData.Body.destroy();
        }
      });
      
      res.on('close', () => {
        if (fileData.Body && typeof fileData.Body.destroy === 'function') {
          fileData.Body.destroy();
        }
      });
      
      // Pipe le stream vers la réponse avec gestion d'erreur
      const pipe = fileData.Body.pipe(res);
      pipe.on('error', (error) => {
        console.error('Pipe error:', error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Pipe error' });
        } else if (!res.writableEnded) {
          res.end();
        }
      });
    } else {
      res.status(404).json({ error: 'File not found' });
    }
  } catch (error) {
    console.error('Error proxying audio file:', error);
    if (!res.headersSent) {
      res.status(500).json({ 
        error: 'Failed to proxy audio file',
        message: error.message 
      });
    }
    // Nettoyer le stream si nécessaire
    if (fileData?.Body && typeof fileData.Body.destroy === 'function') {
      fileData.Body.destroy();
    }
  }
});

// Health check with database status
app.get('/api/health', async (req, res) => {
  try {
    const connection = await pool.getConnection();
    await connection.query('SELECT 1');
    connection.release();
    
    res.json({ 
      status: 'ok', 
      message: 'TshaTshaStream API is running',
      database: 'connected'
    });
  } catch (error) {
    res.status(503).json({ 
      status: 'error', 
      message: 'API is running but database connection failed',
      database: 'disconnected',
      error: process.env.NODE_ENV !== 'production' ? error.message : undefined
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error'
  });
});

// Start server with database connection check
async function startServer() {
  try {
    // Force test database connection before starting server
    console.log('🔍 Testing database connection...');
    await testConnection(3, 1000); // 3 retries, 1 second delay
    await ensureProfessionalTables();
    await ensureProducerTables();
    await ensureDistributorTables();
    await ensureArtistStudioTables();
    await ensureStreamRoyaltyTables();
    await ensureLiveTables();
    await bootstrapLiveDemoSessions();
    await ensureReleaseWorkflowTables();
    const internalDistId = await bootstrapInternalDistributor();
    if (internalDistId) {
      console.log(`📦 Distributeur interne TshaTsha Stream: ${internalDistId}`);
    }

    // Revue trimestrielle des paiements royalties (seuil $20, forfait après 9 mois)
    try {
      const result = await processQuarterlyPayouts();
      if (result.paid > 0 || result.forfeited > 0) {
        console.log(`💰 Royalties trimestrielles: ${result.paid} payé(s), ${result.forfeited} annulé(s)`);
      }
    } catch (e) {
      console.warn('⚠️ Revue trimestrielle royalties ignorée:', e.message);
    }
    const server = app.listen(PORT, () => {
      console.log(`\n🚀 Server running on http://localhost:${PORT}`);
      console.log(`📡 API available at http://localhost:${PORT}/api`);
      console.log(`💚 Health check: http://localhost:${PORT}/api/health\n`);
    });
    
    // Handle server errors (like port already in use)
    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`\n❌ Port ${PORT} is already in use!`);
        console.error('   Please either:');
        console.error(`   1. Stop the server using port ${PORT}`);
        console.error(`   2. Or change PORT in .env file`);
        console.error('\n   To find and kill the process:');
        console.error(`   Windows: netstat -ano | findstr :${PORT}`);
        console.error(`   Then: taskkill /PID <PID> /F\n`);
      } else {
        console.error('\n❌ Server error:', error.message);
      }
      process.exit(1);
    });
  } catch (error) {
    console.error('\n❌ Cannot start server:', error.message);
    console.error('   Please check your MySQL connection and try again.\n');
    process.exit(1);
  }
}

startServer();

