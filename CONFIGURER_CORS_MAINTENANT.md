# 🚨 URGENT : Configurer CORS sur S3 (5 minutes)

## ⚠️ L'erreur actuelle

```
Access to audio at 'https://tshatshastream-audio.s3.eu-north-1.amazonaws.com/...' 
from origin 'http://localhost:5173' has been blocked by CORS policy
```

**Cela signifie que votre bucket S3 bloque l'accès depuis votre frontend.**

## ✅ Solution en 5 étapes

### Étape 1 : Ouvrir AWS Console
1. Allez sur : https://console.aws.amazon.com/s3/
2. Connectez-vous avec vos identifiants AWS

### Étape 2 : Sélectionner votre bucket
1. Dans la liste des buckets, cliquez sur : **`tshatshastream-audio`**

### Étape 3 : Aller dans Permissions
1. Cliquez sur l'onglet **"Permissions"** (en haut de la page)

### Étape 4 : Configurer CORS
1. Faites défiler jusqu'à la section **"Cross-origin resource sharing (CORS)"**
2. Cliquez sur le bouton **"Edit"**

### Étape 5 : Coller la configuration
1. **Supprimez tout le contenu existant** dans la zone de texte
2. **Collez exactement ceci** :

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
            "http://localhost:5175"
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

3. Cliquez sur **"Save changes"** en bas

## ⏱️ Après avoir sauvegardé

1. **Attendez 10-30 secondes** (la configuration se propage)
2. **Rechargez votre application** (Ctrl+Shift+R pour vider le cache)
3. **Testez** : Essayez de jouer une chanson

## ✅ Vérification

Si CORS est bien configuré, vous devriez voir dans les DevTools (onglet Network) :
- Status : `200 OK` (au lieu de `206 Partial Content` avec erreur)
- Headers de réponse incluant : `Access-Control-Allow-Origin: http://localhost:5173`

## 🔍 Si ça ne fonctionne toujours pas

1. Vérifiez que vous avez bien sauvegardé (le bouton "Save changes" est devenu gris)
2. Vérifiez que le JSON est valide (pas d'erreur de syntaxe)
3. Attendez 1-2 minutes et réessayez
4. Videz complètement le cache du navigateur
5. Vérifiez aussi que la **Bucket Policy** est configurée (voir `S3_BUCKET_POLICY.md`)

## 📝 Note importante

**Vous devez faire cette configuration manuellement dans AWS Console.** 
Je ne peux pas le faire pour vous via le code - c'est une configuration de sécurité qui doit être faite directement sur AWS.

Une fois CORS configuré, les fichiers audio devraient se charger correctement ! 🎵

