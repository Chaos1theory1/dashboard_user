# Mycelium Tech Digital - Admin Smart Capital - Vercel + Supabase

Cette version est preparee pour utiliser :

- **Vercel** uniquement pour le deploiement de l'interface et de l'API Express.
- **Supabase PostgreSQL** pour toutes les donnees applicatives.
- **Supabase Storage** pour toutes les photos et certificats PDF.

Aucun Vercel Blob n'est utilise.

## Buckets Supabase attendus

Les noms doivent correspondre exactement :

- `isolements` - photos d'isolement
- `lc` - photos de mycelium liquide
- `grain` - photos de mycelium sur grain
- `certificates` - certificats PDF des souches

Le code actuel utilise des URLs publiques, donc ces 4 buckets doivent etre **Public**. Les uploads et suppressions sont effectues uniquement par le backend avec `SUPABASE_SECRET_KEY`; cette cle ne doit jamais etre exposee au navigateur ni commitee sur GitHub.

## Variables Vercel

Ajouter dans **Vercel > Project > Settings > Environment Variables** :

- `DATABASE_URL`
- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `SESSION_SECRET`

Optionnel :

- `PGPOOL_MAX` (conseille : `5`)
- `ADMIN_SESSION_HOURS`
- `VISITOR_USERNAME`
- `VISITOR_ACCESS_CODE`
- `VISITOR_SESSION_HOURS`

### DATABASE_URL

Dans Supabase, ouvrir **Connect** et choisir **Transaction pooler** pour Vercel/serverless. Copier l'URI complete dans `DATABASE_URL`.

Exemple de forme :

`postgresql://postgres.PROJECT_REF:PASSWORD@REGION.pooler.supabase.com:6543/postgres?sslmode=require`

## Avant le premier deploiement

1. Verifier que la base Supabase contient le schema PostgreSQL utilise par le dashboard. Une base Supabase vide ne suffit pas : les tables historiques de l'application doivent etre importees/migrees.
2. Verifier les 4 buckets Storage ci-dessus.
3. Ajouter toutes les variables Vercel.
4. Pousser ce dossier sur GitHub ou l'importer dans Vercel.
5. Dans Vercel, utiliser **Framework Preset: Other**. Ne pas definir de Build Command ni d'Output Directory.
6. Deployer.

## Uploads

Les fichiers recus par les routes Express sont gardes temporairement en memoire, puis envoyes directement vers le bucket Supabase correspondant. Rien n'est conserve dans le filesystem Vercel.

La limite applicative est volontairement fixee a environ **4 Mo** par fichier sur Vercel, car les requetes qui passent par une Vercel Function ont une limite de payload inferieure a la limite de 50 Mo affichee dans les buckets Supabase.

## Developpement local

```bash
npm install
npm start
```

Puis ouvrir :

`http://localhost:3000/login-admin.html`

Si `SUPABASE_URL` et `SUPABASE_SECRET_KEY` sont definis localement, les uploads vont aussi vers Supabase. Sinon, le projet conserve le fallback local `uploads/` pour le developpement uniquement.

## Securite

- Ne jamais commiter `.env`.
- Ne jamais placer `SUPABASE_SECRET_KEY`, `DATABASE_URL`, `ADMIN_PASSWORD` ou `SESSION_SECRET` dans le JavaScript frontend.
- Les buckets sont publics dans cette configuration : toute personne possedant l'URL d'un fichier peut le consulter.
