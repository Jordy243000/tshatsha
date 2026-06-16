# Configuration S3 : Bucket Policy et CORS

## Problèmes à résoudre

1. **Bucket Policy** : Rendre les fichiers accessibles publiquement
2. **CORS Policy** : Permettre au frontend d'accéder aux fichiers audio depuis le navigateur

## Solution 1 : Configurer la Bucket Policy

### Étapes

1. **Allez dans la Console AWS S3**
   - Connectez-vous à [AWS Console](https://console.aws.amazon.com/s3/)
   - Sélectionnez votre bucket : `tshatshastream-audio`

2. **Ouvrez l'onglet "Permissions"**

3. **Dans "Bucket policy", cliquez sur "Edit"**

4. **Ajoutez cette politique** :

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadGetObject",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::tshatshastream-audio/*"
    }
  ]
}
```

5. **Cliquez sur "Save changes"**

## Solution 2 : Configurer la CORS Policy (IMPORTANT pour le frontend)

### Étapes

1. **Toujours dans l'onglet "Permissions" de votre bucket**

2. **Faites défiler jusqu'à "Cross-origin resource sharing (CORS)"**

3. **Cliquez sur "Edit"**

4. **Ajoutez cette configuration CORS** :

```json
[
    {
        "AllowedHeaders": [
            "*"
        ],
        "AllowedMethods": [
            "GET",
            "HEAD"
        ],
        "AllowedOrigins": [
            "http://localhost:5173",
            "http://localhost:5174",
            "http://localhost:5175",
            "https://votre-domaine.com"
        ],
        "ExposeHeaders": [
            "ETag",
            "Content-Length",
            "Content-Type"
        ],
        "MaxAgeSeconds": 3000
    }
]
```

**Important** : 
- Remplacez `https://votre-domaine.com` par votre domaine de production si vous en avez un
- Ajoutez d'autres origines si nécessaire (ex: votre domaine de staging)

5. **Cliquez sur "Save changes"**

### Explication de la CORS Policy

- **AllowedOrigins** : Les domaines autorisés à accéder aux fichiers (votre frontend)
- **AllowedMethods** : GET et HEAD pour lire les fichiers
- **AllowedHeaders** : Tous les headers sont autorisés
- **ExposeHeaders** : Headers exposés au frontend
- **MaxAgeSeconds** : Durée de cache de la réponse CORS (3000 secondes = 50 minutes)

### Vérification

Après avoir configuré la bucket policy, testez l'accès à un fichier :

1. Uploadez une chanson via l'interface admin
2. Récupérez l'URL S3 depuis les logs ou MySQL
3. Ouvrez l'URL dans votre navigateur - le fichier devrait être accessible

### Alternative : Utiliser CloudFront (Recommandé pour la production)

Pour de meilleures performances et sécurité, vous pouvez utiliser CloudFront comme CDN :

1. Créez une distribution CloudFront pointant vers votre bucket S3
2. Utilisez l'URL CloudFront au lieu de l'URL S3 directe
3. Configurez les permissions CloudFront pour l'accès public

## Note importante

Si vous voyez des erreurs comme :
- `AccessDenied`
- `InvalidAccessKeyId`
- `SignatureDoesNotMatch`

Vérifiez :
1. ✅ Les credentials AWS dans `.env` sont corrects
2. ✅ La région AWS (`eu-north-1`) correspond à votre bucket
3. ✅ Le nom du bucket est correct (`tshatshastream-audio`)
4. ✅ La bucket policy est configurée correctement
5. ✅ Les permissions IAM de votre utilisateur incluent `s3:PutObject` et `s3:DeleteObject`

