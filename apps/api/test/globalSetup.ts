import { MongoMemoryReplSet } from 'mongodb-memory-server';

let replSet: MongoMemoryReplSet | undefined;

/** One in-memory MongoDB replica set for the whole run (transactions need a replica set). */
export async function setup() {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  process.env.TEST_MONGO_URI = replSet.getUri('kass_test');
}

export async function teardown() {
  await replSet?.stop();
}
