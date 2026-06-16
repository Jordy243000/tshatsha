import pool from './connection.js';
import { v4 as uuidv4 } from 'uuid';

// Données mockées à insérer dans la base de données
const mockTracks = [
  {
    id: uuidv4(),
    title: 'Hit du Moment',
    artist_name: 'Artiste Populaire',
    audio_url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
    image_url: 'https://via.placeholder.com/300x300/8b5cf6/ffffff?text=Hit',
    is_premium: false,
    is_trending: true
  },
  {
    id: uuidv4(),
    title: 'Rythme Africain',
    artist_name: 'Star Africaine',
    audio_url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3',
    image_url: 'https://via.placeholder.com/300x300/1DB954/ffffff?text=Music',
    is_premium: false,
    is_trending: true
  },
  {
    id: uuidv4(),
    title: 'Vibration Urbaine',
    artist_name: 'MC Local',
    audio_url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3',
    image_url: 'https://via.placeholder.com/300x300/ff6b6b/ffffff?text=Beat',
    is_premium: true,
    is_trending: true
  },
  {
    id: uuidv4(),
    title: 'Mélodie Douce',
    artist_name: 'Chanteur Talent',
    audio_url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3',
    image_url: 'https://via.placeholder.com/300x300/4ecdc4/ffffff?text=Song',
    is_premium: false,
    is_trending: true
  },
  {
    id: uuidv4(),
    title: 'Énergie Pure',
    artist_name: 'DJ Dynamique',
    audio_url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3',
    image_url: 'https://via.placeholder.com/300x300/ffe66d/000000?text=Energy',
    is_premium: false,
    is_trending: true
  },
  {
    id: uuidv4(),
    title: 'Soul Authentique',
    artist_name: 'Voix Profonde',
    audio_url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-6.mp3',
    image_url: 'https://via.placeholder.com/300x300/95e1d3/ffffff?text=Soul',
    is_premium: false,
    is_trending: true
  },
  {
    id: uuidv4(),
    title: 'Fusion Moderne',
    artist_name: 'Groupe Innovant',
    audio_url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-7.mp3',
    image_url: 'https://via.placeholder.com/300x300/f38181/ffffff?text=Fusion',
    is_premium: true,
    is_trending: true
  },
  {
    id: uuidv4(),
    title: 'Vibes Tropicales',
    artist_name: 'Artiste Caribéen',
    audio_url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-8.mp3',
    image_url: 'https://via.placeholder.com/300x300/a8e6cf/ffffff?text=Island',
    is_premium: false,
    is_trending: true
  }
];

const mockArtists = [
  {
    id: uuidv4(),
    name: 'Artiste Populaire',
    bio: 'Artiste de renommée internationale',
    image_url: 'https://via.placeholder.com/300x300/8b5cf6/ffffff?text=Artist',
    verified: true,
    monthly_listeners: 125000,
    is_popular: true
  },
  {
    id: uuidv4(),
    name: 'Star Africaine',
    bio: 'Talent émergent du continent',
    image_url: 'https://via.placeholder.com/300x300/1DB954/ffffff?text=Star',
    verified: true,
    monthly_listeners: 98000,
    is_popular: true
  },
  {
    id: uuidv4(),
    name: 'MC Local',
    bio: 'Rappeur de la scène locale',
    image_url: 'https://via.placeholder.com/300x300/ff6b6b/ffffff?text=MC',
    verified: false,
    monthly_listeners: 45000,
    is_popular: true
  },
  {
    id: uuidv4(),
    name: 'Chanteur Talent',
    bio: 'Voix exceptionnelle',
    image_url: 'https://via.placeholder.com/300x300/4ecdc4/ffffff?text=Singer',
    verified: true,
    monthly_listeners: 78000,
    is_popular: true
  },
  {
    id: uuidv4(),
    name: 'DJ Dynamique',
    bio: 'DJ résident des meilleures soirées',
    image_url: 'https://via.placeholder.com/300x300/ffe66d/000000?text=DJ',
    verified: false,
    monthly_listeners: 32000,
    is_popular: true
  },
  {
    id: uuidv4(),
    name: 'Voix Profonde',
    bio: 'Artiste soul reconnu',
    image_url: 'https://via.placeholder.com/300x300/95e1d3/ffffff?text=Voice',
    verified: true,
    monthly_listeners: 156000,
    is_popular: true
  }
];

const mockAlbums = [
  {
    id: uuidv4(),
    title: 'Collection 2024',
    artist_name: 'Artiste Populaire',
    cover_image_url: 'https://via.placeholder.com/400x400/8b5cf6/ffffff?text=Album1',
    release_date: '2024-01-15',
    genre: 'Pop',
    description: 'Album phare de l\'année'
  },
  {
    id: uuidv4(),
    title: 'Rythmes Africains',
    artist_name: 'Star Africaine',
    cover_image_url: 'https://via.placeholder.com/400x400/1DB954/ffffff?text=Album2',
    release_date: '2024-02-20',
    genre: 'Afrobeat',
    description: 'Fusion de rythmes traditionnels et modernes'
  },
  {
    id: uuidv4(),
    title: 'Vibes Urbaines',
    artist_name: 'MC Local',
    cover_image_url: 'https://via.placeholder.com/400x400/ff6b6b/ffffff?text=Album3',
    release_date: '2024-03-10',
    genre: 'Hip-Hop',
    description: 'L\'essence du rap local'
  },
  {
    id: uuidv4(),
    title: 'Mélodies Éternelles',
    artist_name: 'Chanteur Talent',
    cover_image_url: 'https://via.placeholder.com/400x400/4ecdc4/ffffff?text=Album4',
    release_date: '2024-01-05',
    genre: 'Ballad',
    description: 'Des ballades intemporelles'
  },
  {
    id: uuidv4(),
    title: 'Énergie Pure',
    artist_name: 'DJ Dynamique',
    cover_image_url: 'https://via.placeholder.com/400x400/ffe66d/000000?text=Album5',
    release_date: '2024-02-28',
    genre: 'Electronic',
    description: 'Mix énergique pour danser'
  },
  {
    id: uuidv4(),
    title: 'Soul Sessions',
    artist_name: 'Voix Profonde',
    cover_image_url: 'https://via.placeholder.com/400x400/95e1d3/ffffff?text=Album6',
    release_date: '2023-12-15',
    genre: 'Soul',
    description: 'Sessions live enregistrées'
  }
];

async function seedDatabase() {
  try {
    console.log('🌱 Début de l\'insertion des données...');

    // Vérifier si des données existent déjà
    const [existingTracks] = await pool.execute('SELECT COUNT(*) as count FROM music');
    if (existingTracks[0].count > 0) {
      console.log('⚠️  Des pistes existent déjà dans la base. Voulez-vous continuer ? (O/N)');
      // Pour l'instant, on continue quand même
    }

    // Insérer les pistes
    console.log('📀 Insertion des pistes...');
    for (const track of mockTracks) {
      try {
        await pool.execute(
          'INSERT INTO music (id, title, artist_name, audio_url, image_url, is_premium, is_trending) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [track.id, track.title, track.artist_name, track.audio_url, track.image_url, track.is_premium, track.is_trending]
        );
        console.log(`  ✓ ${track.title} - ${track.artist_name}`);
      } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
          console.log(`  ⚠ ${track.title} existe déjà`);
        } else {
          console.error(`  ✗ Erreur pour ${track.title}:`, error.message);
        }
      }
    }

    // Insérer les artistes
    console.log('🎤 Insertion des artistes...');
    for (const artist of mockArtists) {
      try {
        await pool.execute(
          'INSERT INTO artists (id, name, bio, image_url, verified, monthly_listeners, is_popular) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [artist.id, artist.name, artist.bio, artist.image_url, artist.verified, artist.monthly_listeners, artist.is_popular]
        );
        console.log(`  ✓ ${artist.name}`);
      } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
          console.log(`  ⚠ ${artist.name} existe déjà`);
        } else {
          console.error(`  ✗ Erreur pour ${artist.name}:`, error.message);
        }
      }
    }

    // Insérer les albums
    console.log('💿 Insertion des albums...');
    for (const album of mockAlbums) {
      try {
        await pool.execute(
          'INSERT INTO albums (id, title, artist_name, cover_image_url, release_date, genre, description) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [album.id, album.title, album.artist_name, album.cover_image_url, album.release_date, album.genre, album.description]
        );
        console.log(`  ✓ ${album.title} - ${album.artist_name}`);
      } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
          console.log(`  ⚠ ${album.title} existe déjà`);
        } else {
          console.error(`  ✗ Erreur pour ${album.title}:`, error.message);
        }
      }
    }

    console.log('✅ Insertion terminée avec succès!');
    console.log(`📊 Résumé:`);
    console.log(`   - ${mockTracks.length} pistes`);
    console.log(`   - ${mockArtists.length} artistes`);
    console.log(`   - ${mockAlbums.length} albums`);

  } catch (error) {
    console.error('❌ Erreur lors de l\'insertion:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

// Exécuter le script
seedDatabase()
  .then(() => {
    console.log('🎉 Script terminé!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('💥 Erreur fatale:', error);
    process.exit(1);
  });

