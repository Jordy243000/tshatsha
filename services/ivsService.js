import {
  IvsClient,
  CreateChannelCommand,
  CreateStreamKeyCommand,
  DeleteChannelCommand,
  DeleteStreamKeyCommand,
  GetStreamCommand,
  ListStreamKeysCommand,
  ListChannelsCommand,
} from '@aws-sdk/client-ivs';

let ivsClient = null;

/** Cache état stream IVS (évite trop d'appels AWS) */
const streamStateCache = new Map();

function getIvsClient() {
  if (!ivsClient && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    ivsClient = new IvsClient({
      region: process.env.AWS_IVS_REGION || 'eu-west-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }
  return ivsClient;
}

export function isIvsConfigured() {
  return !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
}

/**
 * Crée un canal IVS + clé de stream pour un live artiste.
 * @returns {{ channelArn, ingestEndpoint, playbackUrl, streamKey, rtmpsServer }}
 */
export async function createIvsLiveChannel(sessionId, artistName) {
  const client = getIvsClient();
  if (!client) throw new Error('Credentials AWS non configurées');

  const safeName = String(artistName || 'artist')
    .replace(/[^a-zA-Z0-9-_]/g, '-')
    .slice(0, 40);

  const { channel } = await client.send(new CreateChannelCommand({
    name: `tshatsha-${safeName}-${sessionId.slice(0, 8)}`,
    latencyMode: 'LOW',
    type: 'STANDARD',
    authorized: false,
  }));

  if (!channel?.arn || !channel.playbackUrl) {
    throw new Error('Réponse IVS incomplète (canal sans playback URL)');
  }

  // IVS auto-crée 1 clé sans exposer sa valeur → supprimer puis recréer pour obtenir le secret
  let streamKeyValue = null;
  const listed = await client.send(new ListStreamKeysCommand({ channelArn: channel.arn }));
  const existingKeys = listed.streamKeys || [];
  streamKeyValue = existingKeys.find((k) => k.value)?.value || null;

  if (!streamKeyValue) {
    for (const k of existingKeys) {
      if (k.arn) {
        await client.send(new DeleteStreamKeyCommand({ arn: k.arn }));
      }
    }
    if (existingKeys.length) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    const { streamKey } = await client.send(new CreateStreamKeyCommand({ channelArn: channel.arn }));
    streamKeyValue = streamKey?.value || null;
  }

  if (!streamKeyValue) {
    await client.send(new DeleteChannelCommand({ arn: channel.arn })).catch(() => {});
    throw new Error('Impossible de récupérer la clé de stream IVS');
  }

  const ingestEndpoint = channel.ingestEndpoint || '';
  const rtmpsServer = ingestEndpoint
    ? `rtmps://${ingestEndpoint}:443/app/`
    : null;

  return {
    channelArn: channel.arn,
    ingestEndpoint,
    playbackUrl: channel.playbackUrl,
    streamKey: streamKeyValue,
    rtmpsServer,
  };
}

export async function deleteIvsChannel(channelArn) {
  if (!channelArn) return;
  const client = getIvsClient();
  if (!client) return;
  try {
    await client.send(new DeleteChannelCommand({ arn: channelArn }));
    streamStateCache.delete(channelArn);
  } catch (err) {
    console.warn('[ivs] delete channel failed:', err.message);
  }
}

/**
 * État du flux IVS : OFFLINE | LIVE | etc.
 */
export async function getIvsStreamState(channelArn) {
  if (!channelArn) return 'OFFLINE';

  const cached = streamStateCache.get(channelArn);
  if (cached && Date.now() - cached.at < 5000) return cached.state;

  const client = getIvsClient();
  if (!client) return 'OFFLINE';

  try {
    const { stream } = await client.send(new GetStreamCommand({ channelArn }));
    const state = stream?.state || 'OFFLINE';
    streamStateCache.set(channelArn, { state, at: Date.now() });
    return state;
  } catch (err) {
    if (err.name === 'ResourceNotFoundException' || err.name === 'StreamNotAvailable') {
      streamStateCache.set(channelArn, { state: 'OFFLINE', at: Date.now() });
      return 'OFFLINE';
    }
    console.warn('[ivs] get stream state:', err.message);
    return 'OFFLINE';
  }
}

/** Supprime les canaux IVS orphelins (préfixe tshatsha-) — maintenance */
export async function cleanupOrphanIvsChannels(activeArns = []) {
  const client = getIvsClient();
  if (!client) return { deleted: 0 };

  const active = new Set(activeArns.filter(Boolean));
  let deleted = 0;
  let nextToken;

  do {
    const res = await client.send(new ListChannelsCommand({ maxResults: 50, nextToken }));
    for (const ch of res.channels || []) {
      if (!ch?.arn || !ch.name?.startsWith('tshatsha-')) continue;
      if (active.has(ch.arn)) continue;
      await client.send(new DeleteChannelCommand({ arn: ch.arn })).catch(() => {});
      deleted += 1;
    }
    nextToken = res.nextToken;
  } while (nextToken);

  return { deleted };
}
