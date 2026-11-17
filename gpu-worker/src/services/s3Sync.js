import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command, HeadObjectCommand } from '@aws-sdk/client-s3';
import { S3_BUCKET, S3_REGION, S3_PREFIX } from '../config.js';

let client = null;

function getClient() {
  if (!client) {
    client = new S3Client({ region: S3_REGION });
  }
  return client;
}

function fullKey(key) {
  const prefix = S3_PREFIX ? S3_PREFIX.replace(/\/+$/, '') + '/' : '';
  return prefix + key;
}

function stripPrefix(key) {
  const prefix = S3_PREFIX ? S3_PREFIX.replace(/\/+$/, '') + '/' : '';
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

export async function downloadPrefix(s3Prefix, localDir) {
  fs.mkdirSync(localDir, { recursive: true });

  let continuationToken;
  let count = 0;
  do {
    const response = await getClient().send(new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: fullKey(s3Prefix),
      ContinuationToken: continuationToken,
    }));

    if (response.Contents) {
      for (const obj of response.Contents) {
        const relativeKey = stripPrefix(obj.Key);
        const relativePath = relativeKey.slice(s3Prefix.length);
        if (!relativePath || relativePath.endsWith('/')) continue;

        const localPath = path.join(localDir, relativePath);
        fs.mkdirSync(path.dirname(localPath), { recursive: true });

        const getRes = await getClient().send(new GetObjectCommand({
          Bucket: S3_BUCKET,
          Key: obj.Key,
        }));

        // Stream to disk: training uploads can be 1-2 GB each.
        await pipeline(getRes.Body, fs.createWriteStream(localPath));
        count += 1;
      }
    }
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return count;
}

export async function uploadDirectory(localDir, s3Prefix) {
  if (!fs.existsSync(localDir)) return 0;

  let count = 0;
  const entries = fs.readdirSync(localDir, { withFileTypes: true });

  for (const entry of entries) {
    const localPath = path.join(localDir, entry.name);
    if (entry.isDirectory()) {
      count += await uploadDirectory(localPath, `${s3Prefix}${entry.name}/`);
    } else {
      const fileBuffer = fs.readFileSync(localPath);
      const key = `${s3Prefix}${entry.name}`;
      await getClient().send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: fullKey(key),
        Body: fileBuffer,
      }));
      count += 1;
    }
  }

  return count;
}

export async function uploadFile(localPath, s3Key) {
  const fileBuffer = fs.readFileSync(localPath);
  await getClient().send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: fullKey(s3Key),
    Body: fileBuffer,
  }));
}

export async function downloadFile(s3Key, localPath) {
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  const response = await getClient().send(new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: fullKey(s3Key),
  }));
  await pipeline(response.Body, fs.createWriteStream(localPath));
}

// Lists the immediate "subdirectory" names under an S3 prefix (one level deep)
// using a delimiter, e.g. listSubPrefixes('training/datasets/') → ['lecturer-a', …].
export async function listSubPrefixes(s3Prefix) {
  const base = fullKey(s3Prefix);
  const names = [];
  let continuationToken;
  do {
    const response = await getClient().send(new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: base,
      Delimiter: '/',
      ContinuationToken: continuationToken,
    }));
    for (const cp of response.CommonPrefixes || []) {
      const name = cp.Prefix.slice(base.length).replace(/\/+$/, '');
      if (name) names.push(name);
    }
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);
  return names;
}

// Returns true if an object exists at the given (prefix-relative) key.
export async function objectExists(key) {
  try {
    await getClient().send(new HeadObjectCommand({
      Bucket: S3_BUCKET,
      Key: fullKey(key),
    }));
    return true;
  } catch {
    return false;
  }
}
