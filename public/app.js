/**
 * @file app.js
 * @description YouTube Downloader Frontend Application Logic
 */

// ─── DOM Elements ───
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
pasteBtn?.addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text?.trim()) {
      urlInput.value = text.trim();
      urlInput.focus();
    }
  } catch {
    urlInput?.focus();
  }
});

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
    const targetEl = targetId ? document.getElementById(targetId) : null;
    targetEl?.classList.add("active");
  });
});

// Dismiss Error Banner
retryBtn?.addEventListener("click", () => {
  errorBanner?.classList.add("hidden");
  progressCard?.classList.add("hidden");
});

// ─── Fetch Video Info ───
form?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = urlInput?.value.trim();
  if (!url) return;

  if (fetchBtn) fetchBtn.disabled = true;
  showStatus("⏳ Analyzing video & fetching formats...", "loading");
  resultEl?.classList.add("hidden");

  try {
    const res = await fetch("/api/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error ?? `HTTP ${res.status}`);
    }

    currentVideo = { url, ...data };
    renderVideoResult(data);
    hideStatus();
  } catch (err) {
    showStatus(
      `❌ ${err.message || "Failed to fetch video information"}`,
      "error",
    );
  } finally {
    if (fetchBtn) fetchBtn.disabled = false;
  }
});

/**
 * Displays status messages to the user.
 * @param {string} msg
 * @param {string} [type="loading"]
 */
function showStatus(msg, type = "loading") {
  if (!statusEl) return;
  statusEl.textContent = msg;
  statusEl.className = `status-msg ${type}`;
  statusEl.classList.remove("hidden");
}

function hideStatus() {
  if (!statusEl) return;
  statusEl.classList.add("hidden");
  statusEl.textContent = "";
}

// ─── Render Video Result ───
function renderVideoResult(data) {
  if (thumbEl) thumbEl.src = data?.thumbnail ?? "";
  if (titleEl) titleEl.textContent = data?.title ?? "YouTube Video";
  if (uploaderEl) uploaderEl.textContent = data?.uploader ?? "Creator";
  if (viewsEl) {
    viewsEl.textContent = data?.view_count
      ? `${Number(data.view_count).toLocaleString()} views`
      : "YouTube";
  }
  if (durationBadge) durationBadge.textContent = formatDuration(data?.duration);

  // Setup Quick Action Buttons
  if (quickBestBtn) {
    quickBestBtn.onclick = (e) => {
      startDownload(
        {
          format_id: "best",
          needs_merge: true,
          is_audio: false,
          qualityLabel: "Best MP4 Video (H.264 + AAC)",
        },
        e.currentTarget,
      );
    };
  }

  if (quickM4aBtn) {
    quickM4aBtn.onclick = (e) => {
      startDownload(
        {
          format_id: "best",
          needs_merge: false,
          is_audio: true,
          audio_format: "m4a",
          qualityLabel: "MP4 Audio (.m4a / AAC)",
        },
        e.currentTarget,
      );
    };
  }

  if (quickMp3Btn) {
    quickMp3Btn.onclick = (e) => {
      startDownload(
        {
          format_id: "best",
          needs_merge: false,
          is_audio: true,
          audio_format: "mp3",
          qualityLabel: "MP3 Audio (320kbps HQ)",
        },
        e.currentTarget,
      );
    };
  }

  const videoFormats = (data?.formats ?? []).filter((f) => f.hasVideo);

  renderVideoFormats(videoFormats);
  renderAudioFormats();

  resultEl?.classList.remove("hidden");
}

// ─── Render Video Formats (Strict H.264 / AVC Priority) ───
function renderVideoFormats(formats) {
  if (!videoList) return;
  videoList.innerHTML = "";

  const resolutionMap = new Map();

  formats.forEach((f) => {
    let height = f.height;
    if (!height && f.resolution) {
      if (typeof f.resolution === "string" && f.resolution.includes("x")) {
        const parts = f.resolution.split("x");
        height = parseInt(parts[1], 10) || 0;
      } else {
        height = parseInt(f.resolution, 10) || 0;
      }
    }
    if (!height) return;

    const isH264 = f.vcodec?.startsWith("avc") || f.vcodec?.startsWith("h264");
    const existing = resolutionMap.get(height);

    if (!existing) {
      resolutionMap.set(height, f);
    } else {
      const existingIsH264 =
        existing.vcodec?.startsWith("avc") ||
        existing.vcodec?.startsWith("h264");

      if (isH264 && !existingIsH264) {
        resolutionMap.set(height, f);
      } else if (isH264 && existingIsH264) {
        if (
          (f.fps ?? 0) > (existing.fps ?? 0) ||
          (f.filesize ?? 0) > (existing.filesize ?? 0)
        ) {
          resolutionMap.set(height, f);
        }
      } else if (!existingIsH264 && !isH264) {
        if ((f.filesize ?? 0) > (existing.filesize ?? 0)) {
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
    const isH264 = f.vcodec?.startsWith("avc") || f.vcodec?.startsWith("h264");
    const sizeStr = f.filesize
      ? `${(f.filesize / (1024 * 1024)).toFixed(1)} MB`
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

    card.querySelector("button")?.addEventListener("click", (e) => {
      startDownload(
        {
          format_id: f.format_id,
          height: height,
          needs_merge: true,
          is_audio: false,
          qualityLabel: `${height}p MP4 Video (H.264 + AAC)`,
        },
        e.currentTarget,
      );
    });

    videoList.appendChild(card);
  });
}

// ─── Render Audio Formats ───
function renderAudioFormats() {
  if (!audioList) return;
  audioList.innerHTML = "";

  const audioOptions = [
    {
      title: "MP4 Audio (.m4a)",
      badge: "M4A AAC",
      desc: "Apple & Universal MP4 Audio (Lossless AAC, Editor Ready)",
      format: "m4a",
    },
    {
      title: "MP3 Audio (.mp3)",
      badge: "MP3 HQ",
      desc: "320kbps High Quality MP3 (Universal Playback)",
      format: "mp3",
    },
    {
      title: "WAV Audio (.wav)",
      badge: "WAV PCM",
      desc: "Studio Master Uncompressed Audio (Premiere Pro / DaVinci Resolve)",
      format: "wav",
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

    card.querySelector("button")?.addEventListener("click", (e) => {
      startDownload(
        {
          format_id: "best",
          needs_merge: false,
          is_audio: true,
          audio_format: opt.format,
          qualityLabel: opt.title,
        },
        e.currentTarget,
      );
    });

    audioList.appendChild(card);
  });
}

// ─── Live Download Workflow (with SSE Progress) ───
async function startDownload(
  { format_id, height, needs_merge, is_audio, audio_format, qualityLabel },
  clickedBtn = null,
) {
  if (!currentVideo) return;

  if (activeEventSource) {
    activeEventSource.close();
    activeEventSource = null;
  }

  progressCard?.classList.remove("hidden", "completed");
  progressCard?.classList.add("loading"); // Ensure spinner active
  successBanner?.classList.add("hidden");
  errorBanner?.classList.add("hidden");

  if (progressTitle)
    progressTitle.textContent = `Preparing: ${qualityLabel ?? "Media"}`;
  if (progressStage)
    progressStage.textContent = "🚀 Starting download on server...";
  if (progressFill) progressFill.style.width = "0%";
  if (progressBadge) progressBadge.textContent = "0%";
  if (progressSpeed) progressSpeed.textContent = "Speed: Initializing";
  if (progressEta) progressEta.textContent = "ETA: Calculating...";

  progressCard?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  toggleAllButtons(true, clickedBtn);

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
      throw new Error(data?.error ?? `HTTP ${res.status}`);
    }

    const { jobId } = data;
    subscribeToProgress(jobId, clickedBtn);
  } catch (err) {
    showDownloadError(err.message || "Failed to start download");
    toggleAllButtons(false, clickedBtn);
  }
}

function subscribeToProgress(jobId, clickedBtn) {
  const es = new EventSource(`/api/download/progress/${jobId}`);
  activeEventSource = es;

  es.onmessage = (event) => {
    if (!event?.data) return;
    try {
      const data = JSON.parse(event.data);

      if (data.status === "downloading") {
        const percent = Math.min(
          100,
          Math.max(0, Math.round(data.percent ?? 0)),
        );
        if (progressFill) progressFill.style.width = `${percent}%`;
        if (progressBadge) progressBadge.textContent = `${percent}%`;
        if (progressStage)
          progressStage.textContent =
            data.stage ?? "Downloading from YouTube...";
        if (progressSpeed)
          progressSpeed.textContent = data.speed
            ? `Speed: ${data.speed}`
            : "Speed: Active";
        if (progressEta)
          progressEta.textContent = data.eta ? `ETA: ${data.eta}` : "";
      } else if (data.status === "merging") {
        if (progressFill) progressFill.style.width = "95%";
        if (progressBadge) progressBadge.textContent = "95%";
        if (progressStage)
          progressStage.textContent =
            data.stage ?? "Finalizing container (H.264 + AAC + FastStart)...";
        if (progressSpeed) progressSpeed.textContent = "Processing";
        if (progressEta) progressEta.textContent = "Finishing up...";
      } else if (data.status === "completed") {
        // 🔥 Stop spinner & mark completed
        progressCard?.classList.remove("loading");
        progressCard?.classList.add("completed");

        if (progressFill) progressFill.style.width = "100%";
        if (progressBadge) progressBadge.textContent = "100%";
        if (progressStage)
          progressStage.textContent =
            "✅ File ready! Click below if download doesn't start:";
        if (progressSpeed) progressSpeed.textContent = "Done";
        if (progressEta) progressEta.textContent = "0s";

        // 🔥 Render direct clickable download button inside success banner
        if (successBanner) {
          successBanner.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: space-between; width: 100%; flex-wrap: wrap; gap: 10px;">
              <span style="color: inherit;"><i class="fa-solid fa-circle-check"></i> File ready for download!</span>
              <a href="/api/download/file/${jobId}" class="btn-download-direct" style="background: var(--primary, #ff5722); color: #fff; padding: 8px 16px; border-radius: 6px; text-decoration: none; font-weight: bold; display: inline-flex; align-items: center; gap: 6px;">
                <i class="fa-solid fa-download"></i> Save File Now
              </a>
            </div>
          `;
          successBanner.classList.remove("hidden");
        }

        // Trigger background browser download
        triggerBrowserDownload(`/api/download/file/${jobId}`);

        es.close();
        activeEventSource = null;
        toggleAllButtons(false, clickedBtn);
      } else if (data.status === "error") {
        progressCard?.classList.remove("loading");
        showDownloadError(data.error ?? "Server reported download error");
        es.close();
        activeEventSource = null;
        toggleAllButtons(false, clickedBtn);
      }
    } catch (e) {
      console.error("Error parsing SSE event:", e);
    }
  };

  es.onerror = () => {
    console.warn("SSE connection closed or lost");
    progressCard?.classList.remove("loading");
    es.close();
    activeEventSource = null;
    toggleAllButtons(false, clickedBtn);
  };
}

function triggerBrowserDownload(fileUrl) {
  const iframe = document.createElement("iframe");
  iframe.style.display = "none";
  iframe.src = fileUrl;
  document.body.appendChild(iframe);
  setTimeout(() => {
    iframe.remove();
  }, 15000);
}

function showDownloadError(msg) {
  if (errorText) errorText.textContent = `❌ ${msg}`;
  errorBanner?.classList.remove("hidden");
  if (progressStage) progressStage.textContent = "Download halted.";
}

function toggleAllButtons(disabled, activeBtn = null) {
  const allButtons = document.querySelectorAll(
    ".download-format-btn, #quick-best-btn, #quick-m4a-btn, #quick-mp3-btn",
  );
  allButtons.forEach((b) => {
    b.disabled = disabled;
    if (disabled && b === activeBtn) {
      b.classList.add("is-loading");
    } else {
      b.classList.remove("is-loading");
    }
  });
}

/**
 * Formats duration in seconds to HH:MM:SS or MM:SS.
 * @param {number} sec
 * @returns {string}
 */
function formatDuration(sec) {
  if (!sec) return "00:00";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const pad = (n) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
