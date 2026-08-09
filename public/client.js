// Mirrors MAX_UPLOAD_BYTES in server.tsx. This is only the pre-flight check and the
// "max 25 MB" copy below — POST /i enforces the real limit.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

document.querySelectorAll("pre").forEach((x) => {
  x.innerHTML = x.innerHTML.replace(/(https?:\/\/\S+)/g, (u) => {
    // innerHTML's getter leaves quotes raw in text nodes — escape before attribute interpolation
    const q = u.replace(/"/g, "&quot;");
    const isImg = /\.(jpe?g|png|gif|webp|svg)(\?.*)?$/i.test(u) ||
      /^https?:\/\/(i\.redd\.it|i\.imgur\.com|pbs\.twimg\.com)\//i.test(u);
    const isVid = /\.(mp4|webm)(\?.*)?$/i.test(u);
    return isVid
      ? '<video src="' + q +
        '" class="pre-img" muted loop autoplay playsinline preload="metadata"></video><a href="' + q + '">' + u + "</a>"
      : isImg
      ? '<img src="' + q + '" loading="lazy" class="pre-img"><a href="' + q + '">' + u + "</a>"
      : '<a href="' + q + '">' + u + "</a>";
  });
});

(() => {
  const alpha = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const randId = () => {
    const a = new Uint8Array(8);
    crypto.getRandomValues(a);
    let s = "";
    for (const b of a) s += alpha[b % alpha.length];
    return s;
  };
  const EXT_BY_MIME = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "application/pdf": "pdf",
    "video/mp4": "mp4",
    "video/webm": "webm",
  };
  const extOf = (name, type) => {
    const e = (name.split(".").pop() || "").toLowerCase();
    if (["jpg", "jpeg", "png", "gif", "webp", "pdf", "mp4", "webm"].includes(e)) return e === "jpeg" ? "jpg" : e;
    return EXT_BY_MIME[type] || "";
  };
  const insertAt = (ta, s) => {
    const start = ta.selectionStart ?? ta.value.length, end = ta.selectionEnd ?? start;
    const pre = ta.value.slice(0, start), post = ta.value.slice(end);
    const sep = pre && !pre.endsWith("\n") ? "\n" : "";
    ta.value = pre + sep + s + post;
    const pos = (pre + sep + s).length;
    ta.setSelectionRange(pos, pos);
    ta.focus();
  };
  const pendings = new WeakMap();
  const setPending = (form, d) => {
    const btn = form && form.querySelector("button[type=submit]");
    if (!btn) return;
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    const c = (pendings.get(form) || 0) + d;
    pendings.set(form, c);
    btn.disabled = c > 0;
    btn.textContent = c > 0 ? "uploading…" : btn.dataset.label;
  };
  const upload = async (ta, files) => {
    const form = ta.closest("form");
    for (const file of files) {
      const ext = extOf(file.name, file.type);
      if (!ext) {
        alert("unsupported file: " + file.name);
        continue;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        alert("too big (max 25 MB): " + file.name);
        continue;
      }
      const id = randId() + "." + ext;
      const url = "https://i.ding.bar/" + id;
      insertAt(ta, url);
      setPending(form, 1);
      const fd = new FormData();
      fd.append("id", id);
      fd.append("file", file);
      try {
        const r = await fetch("/i", { method: "POST", credentials: "same-origin", body: fd });
        if (!r.ok) {
          ta.value = ta.value.replace(url, "").replace(/\n{3,}/g, "\n\n");
          alert("upload failed (" + r.status + "): " + file.name);
        }
      } catch (e) {
        ta.value = ta.value.replace(url, "").replace(/\n{3,}/g, "\n\n");
        alert("upload error: " + file.name + " — " + e);
      } finally {
        setPending(form, -1);
      }
    }
  };
  document.querySelectorAll("input[type=file][data-upload]").forEach((inp) => {
    const ta = inp.closest("form")?.querySelector("textarea[name=body]");
    if (!ta) return;
    inp.onchange = async () => {
      await upload(ta, inp.files);
      inp.value = "";
    };
  });
  const allTas = () => document.querySelectorAll("textarea[name=body]");
  if (!allTas().length) return;
  let lastTa = null;
  document.addEventListener("focusin", (e) => {
    if (e.target.tagName === "TEXTAREA" && e.target.name === "body") lastTa = e.target;
  });
  const targetTa = () => lastTa || allTas()[0];
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files");
  let depth = 0;
  document.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    depth++;
    document.body.classList.add("dropping");
  });
  document.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) document.body.classList.remove("dropping");
  });
  document.addEventListener("dragover", (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  document.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    document.body.classList.remove("dropping");
    const ta = targetTa();
    if (ta && e.dataTransfer.files.length) upload(ta, e.dataTransfer.files);
  });

  const dlg = document.getElementById("draw-dialog");
  if (!dlg) return;
  const cv = dlg.querySelector("#draw-canvas");
  const ctx = cv.getContext("2d");
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  let tool = "pen", size = 4, drawing = false, last = null;
  const reset = () => {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, cv.width, cv.height);
  };
  reset();
  const pos = (e) => {
    const r = cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (cv.width / r.width), y: (e.clientY - r.top) * (cv.height / r.height) };
  };
  const paint = (a, b) => {
    ctx.strokeStyle = ctx.fillStyle = tool === "eraser" ? "#fff" : "#000";
    ctx.lineWidth = size;
    ctx.beginPath();
    if (a)
      ctx.moveTo(a.x, a.y), ctx.lineTo(b.x, b.y), ctx.stroke();
    else
      ctx.arc(b.x, b.y, size / 2, 0, Math.PI * 2), ctx.fill();
  };
  cv.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    cv.setPointerCapture(e.pointerId);
    drawing = true;
    last = pos(e);
    paint(null, last);
  });
  cv.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const p = pos(e);
    paint(last, p);
    last = p;
  });
  const end = (e) => {
    if (!drawing) return;
    drawing = false;
    last = null;
    try {
      cv.releasePointerCapture(e.pointerId);
    } catch { /* pointer already released */ }
  };
  ["pointerup", "pointercancel", "pointerleave"].forEach((t) => cv.addEventListener(t, end));
  const setPressed = (group, sel) => {
    dlg.querySelectorAll("[" + group + "]").forEach((b) =>
      b.setAttribute("aria-pressed", b === sel ? "true" : "false")
    );
  };
  dlg.addEventListener("click", (e) => {
    const t = e.target;
    if (t === dlg) return dlg.close();
    if (!(t instanceof HTMLElement)) return;
    if (t.dataset.tool) tool = t.dataset.tool, setPressed("data-tool", t);
    else if (t.dataset.size) size = +t.dataset.size, setPressed("data-size", t);
    else if (t.hasAttribute("data-clear")) reset();
    else if (t.hasAttribute("data-cancel")) dlg.close();
    else if (t.hasAttribute("data-insert")) {
      const ta = targetTa();
      if (!ta) return dlg.close();
      cv.toBlob((b) => {
        if (b) upload(ta, [new File([b], "drawing.png", { type: "image/png" })]);
        dlg.close();
      }, "image/png");
    }
  });
  document.querySelectorAll("[data-draw]").forEach((b) => {
    b.addEventListener("click", () => {
      const ta = b.closest("form")?.querySelector("textarea[name=body]");
      if (ta) lastTa = ta;
      reset();
      dlg.showModal();
    });
  });
})();

const fr = document.getElementById("search-form");
if (fr) {
  fr.onsubmit = (e) => {
    e.preventDefault();
    const v = fr.querySelector('input[name="search"]').value, p = new URLSearchParams();
    v.split(/\s+/).filter(Boolean).forEach((t) => {
      const k = { "#": "tag", "*": "org", "@": "usr", "~": "www" }[t[0]];
      if (k) p.append(k, t.slice(1).toLowerCase());
      else p.set("q", (p.get("q") ? p.get("q") + " " : "") + t);
    });
    window.location.href = "/c?" + p;
  };
}

(() => {
  const ta = document.querySelector(".upload-form textarea[name=body]");
  if (!ta) return;
  const KEY = "ding:compose-body";
  const saved = sessionStorage.getItem(KEY);
  if (saved && !ta.value) ta.value = saved;
  sessionStorage.removeItem(KEY);
  let submitted = false;
  ta.form?.addEventListener("submit", () => submitted = true);
  window.addEventListener("pagehide", () => {
    if (!submitted && ta.value) sessionStorage.setItem(KEY, ta.value);
  });
})();

// Logged-in only: <body data-unread> is absent for anonymous viewers.
(() => {
  if (document.body.dataset.unread === undefined || !("Notification" in window)) return;
  if (Notification.permission === "default") {
    const b = document.createElement("button");
    b.textContent = "🔔 enable notifications";
    b.className = "notify-enable";
    b.onclick = async () => {
      await Notification.requestPermission();
      b.remove();
    };
    document.body.appendChild(b);
  }
  let last = +document.body.dataset.unread;
  const poll = async () => {
    const r = await fetch("/n/unread", { credentials: "same-origin" });
    if (!r.ok) return;
    const d = await r.json();
    if (d.count > last && Notification.permission === "granted") {
      (d.latest || []).slice(0, d.count - last).forEach((x) => {
        const nn = new Notification("ding", { body: x.title });
        nn.onclick = () => (window.open(x.url, "_blank"), nn.close());
      });
    }
    last = d.count;
  };
  // Offline or mid-deploy, this tick fails and the next one recovers. Say so, rather than
  // leave an unhandled rejection in the console every minute.
  setInterval(() => poll().catch((e) => console.warn("unread poll failed:", e)), 60000);
})();
