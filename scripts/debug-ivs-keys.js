import dotenv from 'dotenv';
dotenv.config();
import { IvsClient, CreateChannelCommand, ListStreamKeysCommand, CreateStreamKeyCommand, DeleteStreamKeyCommand, DeleteChannelCommand, ListChannelsCommand } from '@aws-sdk/client-ivs';
import { v4 as uuidv4 } from 'uuid';

const client = new IvsClient({
  region: process.env.AWS_IVS_REGION || 'eu-west-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// cleanup all first
const { channels } = await client.send(new ListChannelsCommand({ maxResults: 50 }));
for (const ch of channels || []) {
  await client.send(new DeleteChannelCommand({ arn: ch.arn }));
  console.log('deleted channel', ch.name);
}

const { channel } = await client.send(new CreateChannelCommand({
  name: `tshatsha-debug-${uuidv4().slice(0, 8)}`,
  latencyMode: 'LOW',
  type: 'STANDARD',
  authorized: false,
}));
console.log('channel', channel.arn);

let listed = await client.send(new ListStreamKeysCommand({ channelArn: channel.arn }));
console.log('keys before delete:', listed.streamKeys?.length);

for (const k of listed.streamKeys || []) {
  try {
    await client.send(new DeleteStreamKeyCommand({ arn: k.arn }));
    console.log('deleted key', k.arn);
  } catch (e) {
    console.error('delete key fail', e.message);
  }
}

await new Promise((r) => setTimeout(r, 2000));

listed = await client.send(new ListStreamKeysCommand({ channelArn: channel.arn }));
console.log('keys after delete:', listed.streamKeys?.length);

try {
  const { streamKey } = await client.send(new CreateStreamKeyCommand({ channelArn: channel.arn }));
  console.log('created key', streamKey?.value?.slice(0, 12) + '…');
} catch (e) {
  console.error('create key fail', e.name, e.message);
}

await client.send(new DeleteChannelCommand({ arn: channel.arn }));
