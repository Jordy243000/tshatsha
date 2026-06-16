# 🔧 Fix CORS pour S3 - Guide Rapide

## ❌ Erreur actuelle

```
Access to audio at 'https://tshatshastream-audio.s3.eu-north-1.amazonaws.com/...' 
from origin 'http://localhost:5173' has been blocked by CORS policy: 
No 'Access-Control-Allow-Origin' header is present on the requested resource.
```

## ✅ Solution : Configurer CORS sur S3

### Étapes détaillées

1. **Connectez-vous à AWS Console**
   - Allez sur https://console.aws.amazon.com/s3/
   - Sélectionnez votre bucket : **`tshatshastream-audio`**

2. **Onglet "Permissions"**
   - Cliquez sur l'onglet **"Permissions"** en haut

3. **Section "Cross-origin resource sharing (CORS)"**
   - Faites défiler jusqu'à la section **"Cross-origin resource sharing (CORS)"**
   - Cliquez sur **"Edit"**

4. **Collez cette configuration** :

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

5. **Sauvegardez**
   - Cliquez sur **"Save changes"** en bas

6. **Testez**
   - Rechargez votre application frontend
   - Essayez de jouer une chanson
   - L'erreur CORS devrait disparaître

## 🎯 Pour la production

Quand vous déployez en production, ajoutez votre domaine dans `AllowedOrigins` :

```json
"AllowedOrigins": [
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:5175",
    "https://votre-domaine.com",
    "https://www.votre-domaine.com"
]
```

## ⚠️ Important

- La configuration CORS peut prendre quelques secondes à se propager
- Si ça ne fonctionne pas immédiatement, attendez 1-2 minutes et réessayez
- Videz le cache de votre navigateur si nécessaire (Ctrl+Shift+R)

## ✅ Vérification

Après avoir configuré CORS, vous devriez voir dans les headers de la réponse HTTP :
```
Access-Control-Allow-Origin: http://localhost:5173
Access-Control-Allow-Methods: GET, HEAD
```

