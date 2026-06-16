# Configuration AWS S3 pour le stockage des fichiers

Ce guide vous explique comment configurer Amazon S3 pour stocker les fichiers uploadés (musique, images) au lieu du stockage local.

## Prérequis

1. Un compte AWS
2. Un bucket S3 créé
3. Un utilisateur IAM avec les permissions appropriées

## Étapes de configuration

### 1. Créer un bucket S3

1. Connectez-vous à la [Console AWS S3](https://console.aws.amazon.com/s3/)
2. Cliquez sur "Create bucket"
3. Choisissez un nom unique pour votre bucket (ex: `mbondastream-media`)
4. Sélectionnez la région (ex: `us-east-1`)
5. Configurez les paramètres de sécurité selon vos besoins
6. Créez le bucket

### 2. Configurer les permissions du bucket

Pour permettre l'accès public aux fichiers (recommandé pour les médias) :

1. Allez dans les propriétés de votre bucket
2. Dans "Block public access", désactivez le blocage si nécessaire
3. Dans "Bucket policy", ajoutez cette politique (remplacez `YOUR-BUCKET-NAME` par le nom de votre bucket) :

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadGetObject",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::YOUR-BUCKET-NAME/*"
    }
  ]
}
```

### 3. Créer un utilisateur IAM

1. Allez dans [IAM Console](https://console.aws.amazon.com/iam/)
2. Cliquez sur "Users" puis "Add users"
3. Créez un utilisateur avec accès par programmation
4. Attachez la politique `AmazonS3FullAccess` (ou créez une politique personnalisée plus restrictive)
5. **Important** : Sauvegardez l'Access Key ID et le Secret Access Key

### 4. Configurer les variables d'environnement

1. Copiez le fichier `config/aws.example.env` vers `.env` dans le dossier `backend/`
2. Remplissez les valeurs :

```env
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=votre_access_key_id
AWS_SECRET_ACCESS_KEY=votre_secret_access_key
AWS_S3_BUCKET_NAME=votre-bucket-name
```

**⚠️ IMPORTANT** : Ne commitez jamais le fichier `.env` dans Git ! Il contient des informations sensibles.

### 5. Installer les dépendances

```bash
cd backend
npm install
```

Le package `@aws-sdk/client-s3` sera installé automatiquement.

### 6. Tester la configuration

Démarrez le serveur backend :

```bash
npm run dev
```

Essayez d'uploader un fichier via l'interface admin. Si tout est bien configuré, les fichiers seront stockés sur S3 et les URLs retournées seront des URLs S3 publiques.

## Structure des dossiers S3

Les fichiers sont organisés dans les dossiers suivants :
- `music/` : Fichiers audio (MP3, etc.)
- `albums/` : Images de couverture d'albums
- `images/` : Autres images (pochette de chansons, etc.)

## Fallback vers stockage local

Si les variables d'environnement AWS ne sont pas configurées, le système utilisera automatiquement le stockage local comme fallback. Cela permet de développer localement sans avoir besoin de configurer S3.

## Sécurité

- **Ne partagez jamais** vos credentials AWS
- Utilisez des politiques IAM restrictives en production
- Activez le versioning S3 pour la récupération de fichiers
- Configurez des règles de lifecycle pour gérer les coûts
- Utilisez CloudFront pour la distribution CDN (optionnel mais recommandé)

## Coûts

AWS S3 facture selon :
- Stockage utilisé (GB)
- Requêtes (GET, PUT, etc.)
- Transfert de données sortantes

Consultez la [page de tarification S3](https://aws.amazon.com/s3/pricing/) pour plus de détails.

## Support

En cas de problème :
1. Vérifiez que les variables d'environnement sont correctement définies
2. Vérifiez les permissions IAM
3. Vérifiez que le bucket existe et est accessible
4. Consultez les logs du serveur backend pour les erreurs détaillées

