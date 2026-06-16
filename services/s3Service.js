import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';

// Configuration S3
// Le client S3 sera créé seulement si les credentials sont disponibles
let s3Client = null;

function getS3Client() {
  if (!s3Client && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    s3Client = new S3Client({
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }
  return s3Client;
}

const BUCKET_NAME = process.env.AWS_S3_BUCKET_NAME;

/**
 * Upload un fichier vers S3
 * @param {Buffer} fileBuffer - Le contenu du fichier
 * @param {string} originalName - Le nom original du fichier
 * @param {string} folder - Le dossier dans S3 (ex: 'music', 'albums', 'images')
 * @returns {Promise<string>} L'URL publique du fichier
 */
export async function uploadToS3(fileBuffer, originalName, folder = 'uploads') {
  if (!BUCKET_NAME) {
    throw new Error('AWS_S3_BUCKET_NAME n\'est pas configuré dans les variables d\'environnement');
  }

  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    throw new Error('Les credentials AWS ne sont pas configurés (AWS_ACCESS_KEY_ID et AWS_SECRET_ACCESS_KEY)');
  }

  const fileExtension = path.extname(originalName);
  const uniqueId = uuidv4();
  const fileName = `${folder}/${uniqueId}${fileExtension}`;
  const region = process.env.AWS_REGION || 'us-east-1';

  console.log(`📦 Upload vers S3: ${fileName} (${(fileBuffer.length / 1024 / 1024).toFixed(2)} MB)`);

  const client = getS3Client();
  if (!client) {
    throw new Error('Le client S3 n\'est pas initialisé. Vérifiez vos credentials AWS.');
  }

  // Créer la commande sans ACL (la bucket policy gérera l'accès public)
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: fileName,
    Body: fileBuffer,
    ContentType: getContentType(fileExtension),
    // ACL: 'public-read' - Retiré car certaines régions AWS ne le supportent plus
    // Utilisez une bucket policy pour rendre les fichiers publics
  });

  try {
    await client.send(command);
    console.log(`✅ Fichier uploadé avec succès: ${fileName}`);
  } catch (error) {
    console.error(`❌ Erreur lors de l'upload vers S3:`, error);
    console.error('Détails de l\'erreur:', {
      name: error.name,
      message: error.message,
      code: error.Code || error.code,
      region: region,
      bucket: BUCKET_NAME
    });
    throw error;
  }

  // Retourner l'URL publique S3
  // Format: https://bucket-name.s3.region.amazonaws.com/folder/filename
  const publicUrl = `https://${BUCKET_NAME}.s3.${region}.amazonaws.com/${fileName}`;
  console.log(`🔗 URL S3 générée: ${publicUrl}`);
  
  return publicUrl;
}

/**
 * Supprime un fichier de S3
 * @param {string} fileUrl - L'URL complète du fichier S3
 */
export async function deleteFromS3(fileUrl) {
  if (!BUCKET_NAME || !fileUrl) {
    return;
  }

  try {
    // Extraire la clé du fichier depuis l'URL
    const urlParts = fileUrl.split('.amazonaws.com/');
    if (urlParts.length < 2) {
      console.warn('URL S3 invalide:', fileUrl);
      return;
    }

    const fileKey = urlParts[1];

    const client = getS3Client();
    if (!client) {
      console.warn('Client S3 non disponible pour la suppression');
      return;
    }

    const command = new DeleteObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileKey,
    });

    await client.send(command);
  } catch (error) {
    console.error('Erreur lors de la suppression du fichier S3:', error);
    // Ne pas faire échouer la requête si la suppression échoue
  }
}

/**
 * Détermine le Content-Type basé sur l'extension du fichier
 */
function getContentType(extension) {
  const contentTypes = {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
  };

  return contentTypes[extension.toLowerCase()] || 'application/octet-stream';
}

/**
 * Récupère un fichier depuis S3 et retourne le stream
 * @param {string} fileUrl - L'URL complète du fichier S3
 * @returns {Promise<{Body: ReadableStream, ContentType: string}>} Le stream et le type de contenu
 */
export async function getFromS3(fileUrl) {
  if (!BUCKET_NAME || !fileUrl) {
    throw new Error('Bucket name or file URL is missing');
  }

  try {
    // Extraire la clé du fichier depuis l'URL
    const urlParts = fileUrl.split('.amazonaws.com/');
    if (urlParts.length < 2) {
      // Essayer un autre format d'URL
      const urlMatch = fileUrl.match(/s3\.([^.]+)\.amazonaws\.com\/(.+)/);
      if (!urlMatch) {
        throw new Error('Invalid S3 URL format');
      }
      const fileKey = urlMatch[2];
      return await getFromS3ByKey(fileKey);
    }

    const fileKey = urlParts[1];
    return await getFromS3ByKey(fileKey);
  } catch (error) {
    console.error('Error getting file from S3:', error);
    throw error;
  }
}

/**
 * Récupère un fichier depuis S3 par sa clé
 * @param {string} fileKey - La clé du fichier dans S3
 * @returns {Promise<{Body: ReadableStream, ContentType: string}>} Le stream et le type de contenu
 */
async function getFromS3ByKey(fileKey) {
  const client = getS3Client();
  if (!client) {
    throw new Error('S3 client is not initialized');
  }

  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: fileKey,
  });

  const response = await client.send(command);
  
  // Déterminer le Content-Type
  const extension = path.extname(fileKey);
  const contentType = getContentType(extension);

  return {
    Body: response.Body,
    ContentType: response.ContentType || contentType,
    ContentLength: response.ContentLength,
    LastModified: response.LastModified,
  };
}

/**
 * Liste les fichiers audio de publicité dans le dossier pub/
 * @returns {Promise<string[]>} Liste des URLs des pubs
 */
export async function listAdFiles() {
  if (!BUCKET_NAME) {
    throw new Error('AWS_S3_BUCKET_NAME n\'est pas configuré');
  }

  const client = getS3Client();
  if (!client) {
    throw new Error('S3 client is not initialized');
  }

  try {
    const command = new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: 'pub/',
    });

    const response = await client.send(command);
    const region = process.env.AWS_REGION || 'us-east-1';
    
    // Filtrer uniquement les fichiers audio et générer les URLs
    const audioExtensions = ['.mp3', '.wav', '.m4a', '.mp4'];
    const adFiles = (response.Contents || [])
      .filter(item => {
        const key = item.Key || '';
        return audioExtensions.some(ext => key.toLowerCase().endsWith(ext));
      })
      .map(item => {
        const key = item.Key || '';
        return `https://${BUCKET_NAME}.s3.${region}.amazonaws.com/${key}`;
      });

    return adFiles;
  } catch (error) {
    console.error('Error listing ad files:', error);
    throw error;
  }
}
