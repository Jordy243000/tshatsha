# Test de l'intégration S3

## Comment vérifier que S3 fonctionne correctement

### 1. Vérifier la configuration

Assurez-vous que votre fichier `.env` dans `backend/` contient :

```env
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=votre_access_key_id
AWS_SECRET_ACCESS_KEY=votre_secret_access_key
AWS_S3_BUCKET_NAME=votre-bucket-name
```

### 2. Tester l'upload d'une chanson

1. Démarrez le serveur backend :
```bash
cd backend
npm run dev
```

2. Connectez-vous à l'interface admin
3. Allez dans "Chansons" > "Uploader une chanson"
4. Remplissez le formulaire et uploadez un fichier audio

### 3. Vérifier les logs

Dans les logs du serveur backend, vous devriez voir :

```
📤 Upload du fichier audio vers S3...
📦 Upload vers S3: music/uuid.mp3 (X.XX MB)
✅ Fichier uploadé avec succès: music/uuid.mp3
🔗 URL S3 générée: https://bucket-name.s3.region.amazonaws.com/music/uuid.mp3
✅ Fichier audio uploadé vers S3: https://...
💾 Enregistrement dans MySQL avec les URLs S3:
   - audio_url: https://bucket-name.s3.region.amazonaws.com/music/uuid.mp3
   - image_url: https://... (ou null)
✅ Chanson enregistrée avec succès dans MySQL
```

### 4. Vérifier dans MySQL

Connectez-vous à votre base de données MySQL et exécutez :

```sql
SELECT id, title, audio_url, image_url FROM music ORDER BY created_at DESC LIMIT 1;
```

Vous devriez voir une URL S3 complète dans la colonne `audio_url`, par exemple :
```
https://votre-bucket.s3.us-east-1.amazonaws.com/music/123e4567-e89b-12d3-a456-426614174000.mp3
```

### 5. Tester l'accès au fichier

Copiez l'URL S3 et ouvrez-la dans votre navigateur. Le fichier audio devrait se télécharger ou se lire directement.

### 6. Vérifier dans l'interface admin

Dans la liste des chansons, l'image de couverture (si fournie) devrait s'afficher correctement depuis l'URL S3.

## Dépannage

### Erreur : "AWS_S3_BUCKET_NAME n'est pas configuré"
- Vérifiez que le fichier `.env` existe dans `backend/`
- Vérifiez que la variable `AWS_S3_BUCKET_NAME` est définie

### Erreur : "Les credentials AWS ne sont pas configurés"
- Vérifiez que `AWS_ACCESS_KEY_ID` et `AWS_SECRET_ACCESS_KEY` sont définis dans `.env`
- Vérifiez que les credentials sont corrects

### Erreur : "Access Denied" ou "403 Forbidden"
- Vérifiez les permissions IAM de votre utilisateur AWS
- Vérifiez que le bucket existe et est accessible
- Vérifiez la région AWS

### Le fichier est uploadé mais l'URL ne fonctionne pas
- Vérifiez la politique du bucket (doit permettre l'accès public en lecture)
- Vérifiez que l'ACL 'public-read' est autorisée
- Vérifiez que l'URL est correctement formatée

### Fallback vers stockage local
Si S3 n'est pas configuré, le système utilisera automatiquement le stockage local. Vous verrez dans les logs :
```
⚠️ S3 non configuré, utilisation du stockage local
```

Dans ce cas, les URLs seront du type `/uploads/filename.mp3` au lieu d'URLs S3.

