const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ffmpeg = require('ffmpeg-static');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const ytDlpPath = path.join(__dirname, 'yt-dlp.exe');

// In-memory active and completed download jobs
const downloadJobs = new Map();

// Helper to sanitize title for Windows and cross-platform safe filenames
function sanitizeFilename(title, fallback = 'video') {
  if (!title) return fallback;
  // Remove illegal filename characters: \ / : * ? " < > |
  let clean = title.replace(/[\\/:*?"<>|]/g, '_').trim();
  // Collapse whitespace
  clean = clean.replace(/\s+/g, ' ');
  // Truncate to reasonable length (Windows MAX_PATH safety)
  if (clean.length > 80) clean = clean.slice(0, 80).trim();
  return clean || fallback;
}

// ─── Helper: run yt-dlp for JSON / metadata ───
function runYtdlp(args, { json = false } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      const finalArgs = [
        '--ffmpeg-location', ffmpeg,
        '--js-runtimes', 'node',
        ...args,
      ];
      child = spawn(ytDlpPath, finalArgs);
    } catch (e) {
      return reject(new Error('Could not start yt-dlp: ' + e.message));
    }

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new Error('yt-dlp.exe is missing'));
      } else {
        reject(new Error('yt-dlp failed to start: ' + err.message));
      }
    });

    child.on('close', (code) => {
      if (code !== 0) {
        const lastLine = stderr.trim().split('\n').pop() || 'Unknown error';
        return reject(new Error('yt-dlp error: ' + lastLine));
      }
      if (json) {
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('yt-dlp returned invalid JSON'));
        }
      } else {
        resolve(stdout);
      }
    });
  });
}

// ─── Fetch video info + formats ───
app.post('/api/info', async (req, res) => {
  const { url } = req.body || {};
  if (!url || !/youtu/.test(url)) {
    return res.status(400).json({ error: 'A valid YouTube URL is required' });
  }

  try {
    const data = await runYtdlp(['-J', '--no-warnings', url], { json: true });

    // Group and structure formats cleanly
    const rawFormats = data.formats || [];

    const formats = rawFormats.map((f) => ({
      format_id: f.format_id,
      ext: f.ext,
      resolution: f.resolution || (f.vcodec === 'none' ? 'audio only' : 'unknown'),
      height: f.height || (f.resolution ? parseInt(f.resolution) : 0) || 0,
      width: f.width || 0,
      fps: f.fps || null,
      filesize: f.filesize || f.filesize_approx || null,
      vcodec: f.vcodec || 'none',
      acodec: f.acodec || 'none',
      format_note: f.format_note || '',
      hasVideo: f.vcodec && f.vcodec !== 'none',
      hasAudio: f.acodec && f.acodec !== 'none',
      isH264: f.vcodec && (f.vcodec.startsWith('avc') || f.vcodec.startsWith('h264')),
    }));

    res.json({
      title: data.title || 'YouTube Video',
      thumbnail: data.thumbnail,
      duration: data.duration,
      uploader: data.uploader || 'Unknown Creator',
      channel_url: data.channel_url || data.uploader_url || '',
      view_count: data.view_count || null,
      formats,
    });
  } catch (err) {
    console.error('[info error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start Download Job (with live progress tracking) ───
app.post('/api/download/start', (req, res) => {
  const { url, format_id, height, title, needs_merge, is_audio, audio_format } = req.body || {};

  if (!url) {
    return res.status(400).json({ error: 'YouTube URL is required' });
  }

  const jobId = crypto.randomUUID();
  const safeTitle = sanitizeFilename(title, 'video');
  const jobDir = path.join(TEMP_DIR, jobId);

  if (!fs.existsSync(jobDir)) {
    fs.mkdirSync(jobDir, { recursive: true });
  }

  const outputPattern = path.join(jobDir, 'output.%(ext)s');

  let args = [
    '--ffmpeg-location', ffmpeg,
    '--js-runtimes', 'node',
    '--no-warnings',
    '--newline',
    '--progress',
    '-N', '4',
  ];

  let targetExt = 'mp4';

  if (is_audio) {
    // Audio Extraction Options (MP4 Audio .m4a, MP3 .mp3, WAV .wav)
    const selectedFormat = (audio_format || 'm4a').toLowerCase();

    if (selectedFormat === 'mp3') {
      targetExt = 'mp3';
      args.push(
        '-x',
        '--audio-format', 'mp3',
        '--audio-quality', '0',
        '-f', 'ba/b',
        '-o', outputPattern,
        url
      );
    } else if (selectedFormat === 'wav') {
      targetExt = 'wav';
      args.push(
        '-x',
        '--audio-format', 'wav',
        '-f', 'ba/b',
        '-o', outputPattern,
        url
      );
    } else {
      // Default: MP4 Audio (.m4a / AAC) - 100% compatible with Apple, Premiere, Resolve, CapCut
      targetExt = 'm4a';
      args.push(
        '-x',
        '--audio-format', 'm4a',
        '-f', 'ba[ext=m4a]/ba/b',
        '--postprocessor-args', 'ExtractAudio+ffmpeg:-c:a aac -b:a 256k',
        '-o', outputPattern,
        url
      );
    }
  } else {
    // Video Download Options:
    // ALWAYS force standard H.264 (avc1) video + AAC (mp4a) audio in standard MP4 with +faststart
    targetExt = 'mp4';

    let fmtSelector;
    if (format_id && format_id !== 'best') {
      // If a specific format was chosen, pair with AAC audio (m4a)
      fmtSelector = `${format_id}+ba[acodec^=mp4a]/ba[ext=m4a]/ba`;
    } else if (height) {
      // Prioritize H.264 at or below requested height
      fmtSelector = `bestvideo[height<=${height}][vcodec^=avc]+bestaudio[acodec^=mp4a]/bestvideo[height<=${height}][vcodec^=avc]+bestaudio/bestvideo[height<=${height}]+bestaudio[acodec^=mp4a]/bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best`;
    } else {
      // Default Best Quality: Highest H.264 video + Highest AAC audio
      fmtSelector = 'bestvideo[vcodec^=avc]+bestaudio[acodec^=mp4a]/bestvideo[vcodec^=avc]+bestaudio/bestvideo+bestaudio[acodec^=mp4a]/bestvideo+bestaudio/best';
    }

    args.push(
      '-f', fmtSelector,
      '--merge-output-format', 'mp4',
      // -c:v copy preserves lossless H.264 video with 0 re-encode time
      // -c:a aac ensures audio is always standard AAC (never incompatible Opus in MP4)
      // -movflags +faststart puts moov header at beginning so Premiere Pro & DaVinci Resolve import instantly!
      '--postprocessor-args', 'Merger+ffmpeg:-c:v copy -c:a aac -b:a 192k -movflags +faststart',
      '-o', outputPattern,
      url
    );
  }

  const job = {
    id: jobId,
    title: safeTitle,
    targetExt,
    status: 'starting', // starting | downloading | merging | completed | error
    percent: 0,
    speed: '',
    eta: '',
    stage: 'Initializing download...',
    jobDir,
    filePath: null,
    error: null,
    childProcess: null,
    subscribers: new Set(),
    createdAt: Date.now(),
  };

  downloadJobs.set(jobId, job);

  // Spawn yt-dlp
  try {
    const child = spawn(ytDlpPath, args);
    job.childProcess = child;

    const progressRegex = /\[download\]\s+([\d\.]+)%\s+of\s+~?\s*([^\s]+)(?:\s+at\s+([^\s]+))?(?:\s+ETA\s+([^\s]+))?/i;

    child.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Check for download progress
        const match = trimmed.match(progressRegex);
        if (match) {
          job.status = 'downloading';
          job.percent = parseFloat(match[1]) || job.percent;
          if (match[3]) job.speed = match[3];
          if (match[4]) job.eta = match[4];
          job.stage = `Downloading (${job.percent}%) • ${job.speed || ''} • ETA: ${job.eta || ''}`.trim();
          notifySubscribers(job);
        } else if (trimmed.includes('[Merger]') || trimmed.includes('[ffmpeg]')) {
          job.status = 'merging';
          job.percent = 98;
          job.stage = 'Finalizing MP4 container (H.264 + AAC + FastStart)...';
          notifySubscribers(job);
        } else if (trimmed.includes('[ExtractAudio]')) {
          job.status = 'merging';
          job.percent = 98;
          job.stage = 'Converting audio to high-quality format...';
          notifySubscribers(job);
        }
      }
    });

    child.stderr.on('data', (data) => {
      console.log(`[job ${jobId} stderr]`, data.toString().trim());
    });

    child.on('error', (err) => {
      console.error(`[job ${jobId} process error]`, err);
      job.status = 'error';
      job.error = 'Failed to execute yt-dlp: ' + err.message;
      notifySubscribers(job);
    });

    child.on('close', (code) => {
      job.childProcess = null;
      if (code !== 0) {
        job.status = 'error';
        job.error = `Download failed with exit code ${code}`;
        notifySubscribers(job);
        return;
      }

      // Find the output file inside jobDir
      try {
        const files = fs.readdirSync(jobDir);
        const downloadedFile = files.find((f) => !f.endsWith('.part') && !f.endsWith('.ytdl'));
        if (!downloadedFile) {
          job.status = 'error';
          job.error = 'Downloaded file was not found on the server';
          notifySubscribers(job);
          return;
        }

        job.filePath = path.join(jobDir, downloadedFile);
        job.fileExt = path.extname(downloadedFile).replace('.', '') || targetExt;
        job.status = 'completed';
        job.percent = 100;
        job.stage = 'Ready! Starting browser download...';
        notifySubscribers(job);
      } catch (e) {
        job.status = 'error';
        job.error = 'File verification failed: ' + e.message;
        notifySubscribers(job);
      }
    });

    res.json({
      jobId,
      status: job.status,
      message: 'Download job started successfully',
    });
  } catch (err) {
    job.status = 'error';
    job.error = err.message;
    res.status(500).json({ error: err.message });
  }
});

function notifySubscribers(job) {
  const payload = `data: ${JSON.stringify({
    id: job.id,
    status: job.status,
    percent: job.percent,
    speed: job.speed,
    eta: job.eta,
    stage: job.stage,
    error: job.error,
    fileExt: job.fileExt || job.targetExt,
  })}\n\n`;

  for (const clientRes of job.subscribers) {
    try {
      clientRes.write(payload);
    } catch {
      job.subscribers.delete(clientRes);
    }
  }

  // If completed or error, finish subscriptions after 500ms
  if (job.status === 'completed' || job.status === 'error') {
    setTimeout(() => {
      for (const clientRes of job.subscribers) {
        try {
          clientRes.end();
        } catch {}
      }
      job.subscribers.clear();
    }, 500);
  }
}

// ─── SSE Progress Route ───
app.get('/api/download/progress/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = downloadJobs.get(jobId);

  if (!job) {
    return res.status(404).send('Job not found');
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  job.subscribers.add(res);

  // Send initial state immediately
  res.write(
    `data: ${JSON.stringify({
      id: job.id,
      status: job.status,
      percent: job.percent,
      speed: job.speed,
      eta: job.eta,
      stage: job.stage,
      error: job.error,
      fileExt: job.fileExt || job.targetExt,
    })}\n\n`
  );

  req.on('close', () => {
    job.subscribers.delete(res);
  });
});

// ─── File Download Route ───
app.get('/api/download/file/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = downloadJobs.get(jobId);

  if (!job || job.status !== 'completed' || !job.filePath || !fs.existsSync(job.filePath)) {
    return res.status(404).send('Download file not ready or has expired');
  }

  const finalExt = job.fileExt || job.targetExt || 'mp4';
  const downloadFileName = `${job.title}.${finalExt}`;

  // Content-Disposition with RFC 5987 UTF-8 support
  const encodedName = encodeURIComponent(downloadFileName);
  const asciiFallback = downloadFileName.replace(/[^\x20-\x7E]/g, '_');

  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedName}`
  );

  const mimeMap = {
    mp4: 'video/mp4',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    wav: 'audio/wav',
    opus: 'audio/opus',
  };
  res.setHeader('Content-Type', mimeMap[finalExt] || 'application/octet-stream');

  const fileStream = fs.createReadStream(job.filePath);
  fileStream.pipe(res);

  fileStream.on('end', () => {
    // Schedule directory deletion after 10 minutes to prevent disk bloating
    setTimeout(() => {
      try {
        if (fs.existsSync(job.jobDir)) {
          fs.rmSync(job.jobDir, { recursive: true, force: true });
        }
        downloadJobs.delete(jobId);
      } catch {}
    }, 10 * 60 * 1000);
  });

  fileStream.on('error', (err) => {
    console.error('File stream error:', err);
    if (!res.headersSent) res.status(500).send('Error streaming file');
  });
});

// ─── Legacy Direct Download Route (fixed & enhanced) ───
app.get('/api/download', (req, res) => {
  const { url, format_id, height, title, is_audio, audio_format } = req.query;
  if (!url) {
    return res.status(400).send('Missing url');
  }

  const safeTitle = sanitizeFilename(title, 'video');
  const tempId = Date.now() + '-' + Math.floor(Math.random() * 1000);
  const jobDir = path.join(TEMP_DIR, tempId);
  fs.mkdirSync(jobDir, { recursive: true });

  const outputPattern = path.join(jobDir, 'output.%(ext)s');
  let targetExt = 'mp4';

  let args = [
    '--ffmpeg-location', ffmpeg,
    '--js-runtimes', 'node',
    '--no-warnings',
    '-N', '4',
  ];

  if (is_audio === 'true') {
    const selectedFormat = (audio_format || 'm4a').toLowerCase();
    targetExt = selectedFormat;
    args.push('-x', '--audio-format', selectedFormat, '-f', 'ba/b', '-o', outputPattern, url);
  } else {
    targetExt = 'mp4';
    let fmtSelector = 'bestvideo[vcodec^=avc]+bestaudio[acodec^=mp4a]/bestvideo[vcodec^=avc]+bestaudio/bestvideo+bestaudio[acodec^=mp4a]/bestvideo+bestaudio/best';
    if (format_id && format_id !== 'best') {
      fmtSelector = `${format_id}+ba[acodec^=mp4a]/ba[ext=m4a]/ba`;
    } else if (height) {
      fmtSelector = `bestvideo[height<=${height}][vcodec^=avc]+bestaudio[acodec^=mp4a]/bestvideo[height<=${height}][vcodec^=avc]+bestaudio/bestvideo[height<=${height}]+bestaudio[acodec^=mp4a]/bestvideo[height<=${height}]+bestaudio/best`;
    }
    args.push(
      '-f', fmtSelector,
      '--merge-output-format', 'mp4',
      '--postprocessor-args', 'Merger+ffmpeg:-c:v copy -c:a aac -b:a 192k -movflags +faststart',
      '-o', outputPattern,
      url
    );
  }

  const child = spawn(ytDlpPath, args);

  // Kill child if client aborts
  req.on('close', () => {
    try {
      child.kill('SIGKILL');
      if (fs.existsSync(jobDir)) fs.rmSync(jobDir, { recursive: true, force: true });
    } catch {}
  });

  child.on('error', (err) => {
    console.error('[direct download spawn]', err.message);
    if (!res.headersSent) {
      res.status(500).send('yt-dlp failed to start: ' + err.message);
    }
  });

  child.on('close', (code) => {
    if (code !== 0) {
      if (!res.headersSent) return res.status(500).send('Download failed with exit code ' + code);
      return;
    }

    try {
      const files = fs.readdirSync(jobDir);
      const downloadedFile = files.find((f) => !f.endsWith('.part') && !f.endsWith('.ytdl'));
      if (!downloadedFile) {
        if (!res.headersSent) return res.status(500).send('File not found after download');
        return;
      }

      const filePath = path.join(jobDir, downloadedFile);
      const ext = path.extname(downloadedFile).replace('.', '') || targetExt;
      const downloadFileName = `${safeTitle}.${ext}`;

      res.download(filePath, downloadFileName, (err) => {
        try {
          if (fs.existsSync(jobDir)) fs.rmSync(jobDir, { recursive: true, force: true });
        } catch {}
        if (err) console.error('Send error:', err);
      });
    } catch (e) {
      if (!res.headersSent) res.status(500).send('Error reading file: ' + e.message);
    }
  });
});

// Periodic cleanup of orphaned folders older than 1 hour in TEMP_DIR
setInterval(() => {
  try {
    const now = Date.now();
    const items = fs.readdirSync(TEMP_DIR);
    for (const item of items) {
      const itemPath = path.join(TEMP_DIR, item);
      const stat = fs.statSync(itemPath);
      if (now - stat.mtimeMs > 60 * 60 * 1000) {
        fs.rmSync(itemPath, { recursive: true, force: true });
      }
    }
  } catch {}
}, 15 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`▶ YT Grabber running at http://localhost:${PORT}`);
});