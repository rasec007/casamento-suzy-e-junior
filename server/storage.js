import { S3Client, HeadBucketCommand, CreateBucketCommand, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

const configured = Boolean(process.env.MINIO_SERVER_URL && process.env.MINIO_ROOT_USER && process.env.MINIO_ROOT_PASSWORD);
const endpoint = configured ? new URL(process.env.MINIO_SERVER_URL) : null;
const bucket = process.env.MINIO_BUCKET || 'suzy-junior-wedding';
const client = configured ? new S3Client({
  endpoint: endpoint.origin,
  region: process.env.MINIO_REGION || 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId: process.env.MINIO_ROOT_USER, secretAccessKey: process.env.MINIO_ROOT_PASSWORD },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED'
}) : null;

export function isStorageConfigured() { return configured; }
export function getBucket() { return bucket; }
export async function ensureBucket() {
  if (!client) throw new Error('MinIO não configurado.');
  try { await client.send(new HeadBucketCommand({ Bucket: bucket })); }
  catch (error) {
    if (error.$metadata?.httpStatusCode !== 404 && error.name !== 'NotFound' && error.Code !== 'NoSuchBucket') throw error;
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}
export async function putImage(key, body, contentType) {
  if (!client) throw new Error('MinIO não configurado.');
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentLength: body.length, ContentType: contentType, CacheControl: 'public, max-age=31536000, immutable' }));
}
export async function getImage(key) {
  if (!client) throw new Error('MinIO não configurado.');
  return client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
}
export async function deleteImage(key) {
  if (!client) return;
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
export async function closeStorage() { await client?.destroy(); }
