const form = document.getElementById("fetch-form");
const urlInput = document.getElementById("url");
const fetchBtn = document.getElementById("fetch-btn");
const pasteBtn = document.getElementById("paste-btn");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");

// Progress Card Elements
const progressCard = document.getElementById("download-progress-card");
const progressTitle = document.getElementById("progress-title");
const progressStage = document.getElementById("progress-stage");
const progressFill = document.getElementById("progress-bar-fill");
const progressBadge = document.getElementById("progress-percent-badge");
const progressSpeed = document.getElementById("progress-speed");
const progressEta = document.getElementById("progress-eta");
const successBanner = document.getElementById("download-success-banner");
const errorBanner = document.getElementById("download-error-banner");
const errorText = document.getElementById("download-error-text");
const retryBtn = document.getElementById("retry-btn");

// Video Meta Elements
const thumbEl = document.getElementById("thumb");
const titleEl = document.getElementById("title");
const uploaderEl = document.getElementById("uploader");
const viewsEl = document.getElementById("views");
const durationBadge = document.getElementById("duration-badge");
const quickBestBtn = document.getElementById("quick-best-btn");
const quickM4aBtn = document.getElementById("quick-m4a-btn");
const quickMp3Btn = document.getElementById("quick-mp3-btn");

// Lists
const videoList = document.getElementById("video-list");
const audioList = document.getElementById("audio-list");

let currentVideo = null;
let activeEventSource = null;

// ─── Clipboard Paste ───
if (pasteBtn) {
  pasteBtn.addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) {
        urlInput.value = text.trim();
        urlInput.focus();
      }
    } catch {
      urlInput.focus();
    }
  });
}

// ─── Tab Switching ───
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document
      .querySelectorAll(".tab-btn")
      .forEach((b) => b.classList.remove("active"));
    document
      .querySelectorAll(".tab-content")
      .forEach((c) => c.classList.remove("active"));

    btn.classList.add("active");
    const targetId = btn.getAttribute("data-tab");
    const targetEl = document.getElementById(targetId);
    if (targetEl) targetEl.classList.add("active");
  });
});

// Dismiss Error Banner
if (retryBtn) {
  retryBtn.addEventListener("click", () => {
    errorBanner.classList.add("hidden");
    progressCard.classList.add("hidden");
  });
}

// ─── Fetch Video Info ───
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;

  fetchBtn.disabled = true;
  showStatus("⏳ Analyzing video & fetching formats...", "loading");
  resultEl.classList.add("hidden");

  try {
    const res = await fetch("/api/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    currentVideo = { url, ...data };
    renderVideoResult(data);
    hideStatus();
  } catch (err) {
    showStatus(
      "❌ " + (err.message || "Failed to fetch video information"),
      "error",
    );
  } finally {
    fetchBtn.disabled = false;
  }
});

function showStatus(msg, type = "loading") {
  statusEl.textContent = msg;
  statusEl.className = `status-msg ${type}`;
  statusEl.classList.remove("hidden");
}

function hideStatus() {
  statusEl.classList.add("hidden");
  statusEl.textContent = "";
}

// ─── Render Video Result ───
function renderVideoResult(data) {
  thumbEl.src = data.thumbnail || "";
  titleEl.textContent = data.title || "YouTube Video";
  uploaderEl.textContent = data.uploader || "Creator";
  viewsEl.textContent = data.view_count
    ? `${Number(data.view_count).toLocaleString()} views`
    : "YouTube";
  durationBadge.textContent = formatDuration(data.duration);

  // Setup Quick Action Buttons
  if (quickBestBtn) {
    quickBestBtn.onclick = () => {
      startDownload({
        format_id: "best",
        needs_merge: true,
        is_audio: false,
        qualityLabel: "Best MP4 Video (H.264 + AAC)",
      });
    };
  }

  if (quickM4aBtn) {
    quickM4aBtn.onclick = () => {
      startDownload({
        format_id: "best",
        needs_merge: false,
        is_audio: true,
        audio_format: "m4a",
        qualityLabel: "MP4 Audio (.m4a / AAC)",
      });
    };
  }

  if (quickMp3Btn) {
    quickMp3Btn.onclick = () => {
      startDownload({
        format_id: "best",
        needs_merge: false,
        is_audio: true,
        audio_format: "mp3",
        qualityLabel: "MP3 Audio (320kbps HQ)",
      });
    };
  }

  // Filter video formats
  const videoFormats = (data.formats || []).filter((f) => f.hasVideo);

  renderVideoFormats(videoFormats);
  renderAudioFormats();

  resultEl.classList.remove("hidden");
}

// ─── Render Video Formats (Strict H.264 / AVC Priority for Universal Compatibility) ───
function renderVideoFormats(formats) {
  videoList.innerHTML = "";

  // Group formats by height (1080, 720, 480, 360, etc.)
  const resolutionMap = new Map();

  formats.forEach((f) => {
    const height = f.height || (f.resolution ? parseInt(f.resolution) : 0);
    if (!height) return;

    const isH264 = f.vcodec && (f.vcodec.startsWith("avc") || f.vcodec.startsWith("h264"));
    const existing = resolutionMap.get(height);

    if (!existing) {
      resolutionMap.set(height, f);
    } else {
      const existingIsH264 = existing.vcodec && (existing.vcodec.startsWith("avc") || existing.vcodec.startsWith("h264"));

      // Priority 1: ALWAYS choose H.264 (avc1) so video can be imported into Premiere Pro, DaVinci Resolve, CapCut, etc.
      if (isH264 && !existingIsH264) {
        resolutionMap.set(height, f);
      } else if (isH264 && existingIsH264) {
        // Between two H.264 streams, prefer higher fps or filesize
        if ((f.fps || 0) > (existing.fps || 0) || (f.filesize || 0) > (existing.filesize || 0)) {
          resolutionMap.set(height, f);
        }
      } else if (!existingIsH264 && !isH264) {
        if ((f.filesize || 0) > (existing.filesize || 0)) {
          resolutionMap.set(height, f);
        }
      }
    }
  });

  const sortedHeights = Array.from(resolutionMap.keys()).sort((a, b) => b - a);

  if (sortedHeights.length === 0) {
    videoList.innerHTML =
      '<p style="color: var(--text-dim); padding: 1rem;">No direct video streams found.</p>';
    return;
  }

  sortedHeights.forEach((height) => {
    const f = resolutionMap.get(height);
    const isHd = height >= 720;
    const isH264 = f.vcodec && (f.vcodec.startsWith("avc") || f.vcodec.startsWith("h264"));
    const sizeStr = f.filesize
      ? (f.filesize / (1024 * 1024)).toFixed(1) + " MB"
      : "Standard Size";

    const card = document.createElement("div");
    card.className = "format-card";
    card.innerHTML = `
      <div class="format-details">
        <span class="quality-badge ${isHd ? "hd" : ""}">${height}p ${f.fps && f.fps > 30 ? f.fps + "fps" : ""}</span>
        <span class="format-ext">MP4 Video</span>
        <span class="format-size">${sizeStr} • ${isH264 ? "H.264 + AAC (Editor Ready)" : "MP4 + AAC"}</span>
      </div>
      <button class="download-format-btn" type="button">
        <i class="fa-solid fa-download"></i>
        <span>Download ${height}p</span>
      </button>
    `;

    card.querySelector("button").addEventListener("click", () => {
      startDownload({
        format_id: f.format_id,
        height: height,
        needs_merge: true,
        is_audio: false,
        qualityLabel: `${height}p MP4 Video (H.264 + AAC)`,
      });
    });

    videoList.appendChild(card);
  });
}

// ─── Render Audio Formats (MP4 Audio .m4a, MP3 .mp3, WAV .wav) ───
function renderAudioFormats() {
  audioList.innerHTML = "";

  const audioOptions = [
    {
      title: "MP4 Audio (.m4a)",
      badge: "M4A AAC",
      desc: "Apple & Universal MP4 Audio (Lossless AAC, Editor Ready)",
      format: "m4a",
      icon: "fa-music",
    },
    {
      title: "MP3 Audio (.mp3)",
      badge: "MP3 HQ",
      desc: "320kbps High Quality MP3 (Universal Playback)",
      format: "mp3",
      icon: "fa-headphones",
    },
    {
      title: "WAV Audio (.wav)",
      badge: "WAV PCM",
      desc: "Studio Master Uncompressed Audio (Premiere Pro / DaVinci Resolve)",
      format: "wav",
      icon: "fa-file-audio",
    },
  ];

  audioOptions.forEach((opt) => {
    const card = document.createElement("div");
    card.className = "format-card";
    card.innerHTML = `
      <div class="format-details">
        <span class="quality-badge audio">${opt.badge}</span>
        <span class="format-ext">${opt.title}</span>
        <span class="format-size">${opt.desc}</span>
      </div>
      <button class="download-format-btn" type="button">
        <i class="fa-solid fa-download"></i>
        <span>Download ${opt.format.toUpperCase()}</span>
      </button>
    `;

    card.querySelector("button").addEventListener("click", () => {
      startDownload({
        format_id: "best",
        needs_merge: false,
        is_audio: true,
        audio_format: opt.format,
        qualityLabel: opt.title,
      });
    });

    audioList.appendChild(card);
  });
}

// ─── Live Download Workflow (with SSE Progress) ───
async function startDownload({
  format_id,
  height,
  needs_merge,
  is_audio,
  audio_format,
  qualityLabel,
}) {
  if (!currentVideo) return;

  if (activeEventSource) {
    activeEventSource.close();
    activeEventSource = null;
  }

  // Show progress card and scroll into view
  progressCard.classList.remove("hidden");
  successBanner.classList.add("hidden");
  errorBanner.classList.add("hidden");

  progressTitle.textContent = `Preparing: ${qualityLabel || "Media"}`;
  progressStage.textContent = "🚀 Starting download on server...";
  progressFill.style.width = "0%";
  progressBadge.textContent = "0%";
  progressSpeed.textContent = "Speed: Initializing";
  progressEta.textContent = "ETA: Calculating...";

  progressCard.scrollIntoView({ behavior: "smooth", block: "nearest" });

  // Disable all download buttons during processing
  toggleAllButtons(true);

  try {
    const res = await fetch("/api/download/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: currentVideo.url,
        format_id,
        height,
        title: currentVideo.title,
        needs_merge,
        is_audio,
        audio_format,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    const { jobId } = data;
    subscribeToProgress(jobId);
  } catch (err) {
    showDownloadError(err.message || "Failed to start download");
    toggleAllButtons(false);
  }
}

function subscribeToProgress(jobId) {
  const es = new EventSource(`/api/download/progress/${jobId}`);
  activeEventSource = es;

  es.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.status === "downloading") {
        const percent = Math.min(
          100,
          Math.max(0, Math.round(data.percent || 0)),
        );
        progressFill.style.width = percent + "%";
        progressBadge.textContent = percent + "%";
        progressStage.textContent = data.stage || "Downloading from YouTube...";
        progressSpeed.textContent = data.speed
          ? `Speed: ${data.speed}`
          : "Speed: Active";
        progressEta.textContent = data.eta ? `ETA: ${data.eta}` : "";
      } else if (data.status === "merging") {
        progressFill.style.width = "95%";
        progressBadge.textContent = "95%";
        progressStage.textContent =
          data.stage || "Finalizing MP4 container (H.264 + AAC + FastStart)...";
        progressSpeed.textContent = "Processing";
        progressEta.textContent = "Finishing up...";
      } else if (data.status === "completed") {
        progressFill.style.width = "100%";
        progressBadge.textContent = "100%";
        progressStage.textContent =
          "✅ File ready! Starting browser download...";
        progressSpeed.textContent = "Done";
        progressEta.textContent = "0s";

        successBanner.classList.remove("hidden");

        // Trigger direct file download
        triggerBrowserDownload(`/api/download/file/${jobId}`);

        es.close();
        activeEventSource = null;
        toggleAllButtons(false);
      } else if (data.status === "error") {
        showDownloadError(data.error || "Server reported download error");
        es.close();
        activeEventSource = null;
        toggleAllButtons(false);
      }
    } catch (e) {
      console.error("Error parsing SSE event:", e);
    }
  };

  es.onerror = () => {
    console.warn("SSE connection closed or lost");
    es.close();
    activeEventSource = null;
    toggleAllButtons(false);
  };
}

function triggerBrowserDownload(fileUrl) {
  const a = document.createElement("a");
  a.href = fileUrl;
  a.setAttribute("download", "");
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function showDownloadError(msg) {
  errorText.textContent = "❌ " + msg;
  errorBanner.classList.remove("hidden");
  progressStage.textContent = "Download halted.";
}

function toggleAllButtons(disabled) {
  document.querySelectorAll(".download-format-btn, .quick-btn").forEach((b) => {
    b.disabled = disabled;
  });
}

function formatDuration(sec) {
  if (!sec) return "00:00";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const pad = (n) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
