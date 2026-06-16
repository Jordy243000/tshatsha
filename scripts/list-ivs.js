import dotenv from 'dotenv';
dotenv.config();
import { IvsClient, ListChannelsCommand, ListStreamKeysCommand } from '@aws-sdk/client-ivs';

const client = new IvsClient({
  region: process.env.AWS_IVS_REGION || 'eu-west-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const { channels } = await client.send(new ListChannelsCommand({ maxResults: 50 }));
console.log('Channels:', channels?.length || 0);
for (const ch of channels || []) {
  const keys = await client.send(new ListStreamKeysCommand({ channelArn: ch.arn }));
  console.log('-', ch.name, ch.arn?.slice(-12), 'keys:', keys.streamKeys?.length || 0);
}
