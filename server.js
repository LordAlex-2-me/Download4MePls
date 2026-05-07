const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

// In-memory job store — survives restarts only if you swap this for a JSON file or SQLite
const jobs = {};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (!bytes) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function safeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._\-]/g, '_').slice(0, 200);
}

function guessFilename(url) {
  try {
    const parsed = new URL(url);
    const base = path.basename(parsed.pathname);
    return base && base !== '/' ? safeFilename(base) : 'download';
  } catch {
    return 'download';
  }
}

// ─── Download worker ──────────────────────────────────────────────────────────

async function runDownload(jobId) {
  const job = jobs[jobId];
  if (!job) return;
  job.status = 'downloading';
  job.startedAt = new Date().toISOString();

  try {
    const config = {
      method: 'GET',
      url: job.url,
      responseType: 'stream',
      timeout: 10 * 60 * 1000, // 10-minute timeout
      maxRedirects: 10,
      headers: { 'User-Agent': 'FetchDrop/1.0' },
    };

    // Apply credentials
    const c = job.credentials;
    if (c) {
      if (c.type === 'basic') {
        config.auth = { username: c.username, password: c.password };
      } else if (c.type === 'bearer') {
        config.headers['Authorization'] = `Bearer ${c.token}`;
      } else if (c.type === 'cookie') {
        config.headers['Cookie'] = c.value;
      } else if (c.type === 'header') {
        config.headers[c.name] = c.value;
      }
    }

    const response = await axios(config);

    // Try to get filename from Content-Disposition
    const cd = response.headers['content-disposition'];
    if (cd) {
      const match = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';\n]+)/i);
      if (match) job.filename = safeFilename(decodeURIComponent(match[1].trim()));
    }

    // Content length
    const cl = response.headers['content-length'];
    if (cl) job.totalBytes = parseInt(cl);

    const filePath = path.join(DOWNLOADS_DIR, jobId);
    const writer = fs.createWriteStream(filePath);

    let bytesWritten = 0;
    response.data.on('data', chunk => {
      bytesWritten += chunk.length;
      job.bytesDownloaded = bytesWritten;
      if (job.totalBytes) {
        job.progress = Math.round((bytesWritten / job.totalBytes) * 100);
      }
    });
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    const stats = fs.statSync(filePath);
    job.size = stats.size;
    job.sizeFormatted = formatBytes(stats.size);
    job.status = 'complete';
    job.progress = 100;
    job.completedAt = new Date().toISOString();
  } catch (err) {
    job.status = 'error';
    job.error = err.response
      ? `HTTP ${err.response.status}: ${err.response.statusText}`
      : err.message;
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// List all jobs
app.get('/api/jobs', (req, res) => {
  const list = Object.values(jobs)
    .map(j => ({ ...j, credentials: undefined })) // never leak credentials
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(list);
});

// Create a download job
app.post('/api/jobs', (req, res) => {
  const { url, credentials, filename } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'A valid URL is required.' });
  }

  try { new URL(url); } catch {
    return res.status(400).json({ error: 'Invalid URL format.' });
  }

  const jobId = uuidv4();
  jobs[jobId] = {
    id: jobId,
    url,
    filename: filename ? safeFilename(filename) : guessFilename(url),
    credentials: credentials || null,
    status: 'pending',
    progress: 0,
    bytesDownloaded: 0,
    totalBytes: null,
    size: null,
    sizeFormatted: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    error: null,
  };

  res.status(202).json({ jobId });
  setImmediate(() => runDownload(jobId));
});

// Poll a single job
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  res.json({ ...job, credentials: undefined });
});

// Retry a failed job
app.post('/api/jobs/:id/retry', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (job.status !== 'error') return res.status(400).json({ error: 'Only failed jobs can be retried.' });

  job.status = 'pending';
  job.progress = 0;
  job.bytesDownloaded = 0;
  job.error = null;

  res.json({ jobId: job.id });
  setImmediate(() => runDownload(job.id));
});

// Serve a completed file
app.get('/api/download/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (job.status !== 'complete') return res.status(400).json({ error: 'File is not ready yet.' });

  const filePath = path.join(DOWNLOADS_DIR, job.id);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing on disk.' });

  res.download(filePath, job.filename);
});

// Delete a job and its file
app.delete('/api/jobs/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job not found.' });

  const filePath = path.join(DOWNLOADS_DIR, job.id);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  delete jobs[req.params.id];

  res.json({ success: true });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FetchDrop running on http://localhost:${PORT}`);
});
