# Configuration de l'authentification Google

## Variables d'environnement requises

Créez un fichier `.env` dans le dossier `backend` avec les variables suivantes :

```env
GOOGLE_CLIENT_ID=votre_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=votre_client_secret
```

> **Ne commitez jamais** vos vraies clés Google. Utilisez uniquement le fichier `.env` (déjà ignoré par Git).

## Configuration frontend

Dans le fichier `.env` du dossier `project`, ajoutez :

```env
VITE_GOOGLE_CLIENT_ID=votre_client_id.apps.googleusercontent.com
```

## Configuration Google Cloud Console

1. Assurez-vous que les URI de redirection autorisés sont configurés dans Google Cloud Console
2. Pour le développement local, ajoutez : `http://localhost:5173`
3. Pour la production, ajoutez l'URL de votre domaine

## Fonctionnement

1. Le frontend charge Google Identity Services via le script dans `index.html`
2. Les boutons Google sont rendus automatiquement dans `LoginPage` et `SignUpPage`
3. Quand l'utilisateur clique sur le bouton Google, Google retourne un ID token
4. Le frontend envoie cet ID token au backend via `/api/auth/google`
5. Le backend vérifie le token avec Google, crée ou met à jour l'utilisateur, et retourne un JWT
6. Le frontend stocke le JWT et connecte l'utilisateur

## Test

1. Démarrez le backend : `cd backend && npm run dev`
2. Démarrez le frontend : `cd project && npm run dev`
3. Allez sur la page de connexion ou d'inscription
4. Cliquez sur le bouton "Continuer avec Google"
5. Sélectionnez votre compte Google
6. Vous devriez être connecté automatiquement
