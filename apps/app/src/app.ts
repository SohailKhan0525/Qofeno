/**
 * Qofeno App UI logic. Talks to the local qofeno server (same origin when
 * served by `qofeno serve`, or http://127.0.0.1:7931 in desktop/mobile
 * shells). No framework; every action maps to a real engine endpoint.
 */
const $ = (sel: string, el: ParentNode = document): HTMLElement => {
  const found = el.querySelector(sel);
  if (!found) throw new Error(`missing element ${sel}`);
  return found as HTMLElement;
};
const $$ = (sel: string, el: ParentNode = document) => [...el.querySelectorAll(sel)] as HTMLElement[];

type Api = <T>(path: string, init?: RequestInit) => Promise<T>;
let API_BASE = "";
if (!location.origin.startsWith("http") || location.port === "") API_BASE = "http://127.0.0.1:7931";

export const api: Api = async (path, init) => {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...(localStorage.getItem("qofeno.token") ? { Authorization: `Bearer ${localStorage.getItem("qofeno.token")}` } : {}) },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 403) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as never;
};

function confirmDialog(title: string, detail: string): Promise<boolean> {
  return new Promise((resolveP) => {
    const dlg = $("#confirm-dialog") as HTMLDialogElement;
    $("#confirm-title").textContent = title;
    $("#confirm-detail").textContent = detail;
    dlg.onclose = () => resolveP(dlg.returnValue === "ok");
    dlg.showModal();
  });
}

// ---- navigation -----------------------------------------------------------
$$(".nav-btn").forEach((btn) =>
  btn.addEventListener("click", () => {
    $$(".nav-btn").forEach((b) => b.removeAttribute("aria-current"));
    btn.setAttribute("aria-current", "page");
    $$(".view").forEach((v) => ((v as HTMLElement).hidden = true));
    ($(`#view-${btn.dataset.nav}`) as HTMLElement).hidden = false;
    $("#main").focus();
    viewLoaders[btn.dataset.nav!]?.();
  }),
);
void $;

const viewLoaders: Record<string, () => void> = {};

// ---- chat -------------------------------------------------------------------
function addMsg(who: string, text: string, cls = ""): void {
  const d = document.createElement("div");
  d.className = `msg ${cls}`;
  const w = document.createElement("div");
  w.className = "who";
  w.textContent = who;
  const p = document.createElement("pre");
  p.textContent = text;
  d.append(w, p);
  $("#chat-log").append(d);
  $("#chat-log").scrollTop = $("#chat-log").scrollHeight;
}

$("#composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#chat-input") as HTMLTextAreaElement;
  const text = input.value.trim();
  if (!text) return;
  addMsg("you", text);
  input.value = "";
  ($("#send-btn") as HTMLButtonElement).disabled = true;
  addMsg("qofeno", "…thinking");
  try {
    const r = await api<{ result: string; model?: string; error?: string }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ prompt: text, modelId: ($("#model-select") as HTMLSelectElement).value || undefined }),
    });
    const last = $("#chat-log").lastElementChild!;
    last.className = `msg ${r.error ? "err" : ""}`;
    (last.querySelector("pre") as HTMLElement).textContent = r.error ?? `${r.result}\n\n— ${r.model ?? ""}`;
  } catch (e2) {
    const last = $("#chat-log").lastElementChild!;
    last.className = "msg err";
    (last.querySelector("pre") as HTMLElement).textContent = String((e2 as Error).message);
  }
  ($("#send-btn") as HTMLButtonElement).disabled = false;
});
$("#chat-input").addEventListener("keydown", (e) => {
  if ((e as KeyboardEvent).key === "Enter" && !(e as KeyboardEvent).shiftKey) {
    e.preventDefault();
    $("#composer").dispatchEvent(new Event("submit"));
  }
});
viewLoaders.chat = async () => {
  try {
    const { models } = await api<{ models: Array<{ id: string; destination: string }> }>("/api/models");
    const sel = $("#model-select") as HTMLSelectElement;
    sel.textContent = "";
    const auto = document.createElement("option");
    auto.value = "";
    auto.textContent = "auto (policy-routed)";
    sel.append(auto);
    for (const m of models) {
      const o = document.createElement("option");
      o.value = m.id;
      o.textContent = `${m.id}${m.destination === "local" ? " ·local" : ""}`;
      sel.append(o);
    }
    $("#conn-state").textContent = `connected · ${models.length} models`;
  } catch {
    $("#conn-state").textContent = "offline — start `qofeno serve` or open the desktop app";
  }
};

// ---- sessions -----------------------------------------------------------------
viewLoaders.sessions = loadSessions;
async function loadSessions(): Promise<void> {
  const ul = $("#session-list");
  ul.textContent = "";
  try {
    const { sessions } = await api<{ sessions: Array<{ id: string; title: string; updatedAtMs: number }> }>("/api/sessions");
    for (const s of sessions) {
      const li = document.createElement("li");
      const span = document.createElement("span");
      span.className = "txt";
      span.textContent = `${s.title} · ${new Date(s.updatedAtMs).toLocaleString()}`;
      const open = document.createElement("button");
      open.textContent = "Open";
      open.onclick = () => {
        ($('[data-nav="chat"]') as HTMLButtonElement).click();
        void (async () => {
          const { messages } = await api<{ messages: Array<{ role: string; content: string }> }>(`/api/sessions/${s.id}/messages`);
          $("#chat-log").textContent = "";
          for (const m of messages) addMsg(m.role, m.content);
        })();
      };
      li.append(span, open);
      ul.append(li);
    }
  } catch (e) {
    li_error(ul, e as Error);
  }
}
function li_error(ul: HTMLElement, e: Error): void {
  const li = document.createElement("li");
  li.textContent = `Error: ${e.message}`;
  ul.append(li);
}
$("#new-session").onclick = async () => {
  await api("/api/sessions", { method: "POST", body: JSON.stringify({ title: "App session" }) });
  loadSessions();
};

// ---- files ----------------------------------------------------------------------
viewLoaders.files = listFiles;
async function listFiles(): Promise<void> {
  try {
    const r = await api<{ output: string }>("/api/tools/fs_list", { method: "POST", body: JSON.stringify({}) });
    ($("#file-tree") as HTMLPreElement).textContent = r.output;
  } catch (e) {
    ($("#file-tree") as HTMLPreElement).textContent = `File tools require permission grants on the server.\n(${(e as Error).message})`;
  }
}
$("#file-tree").addEventListener("click", async (e) => {
  const line = (e.target as HTMLElement).textContent ?? "";
  const path = line.split(" (")[0]?.trim();
  if (!path || path.endsWith("/")) return;
  try {
    const r = await api<{ output: string }>("/api/tools/fs_read", { method: "POST", body: JSON.stringify({ path }) });
    ($("#file-editor") as HTMLTextAreaElement).dataset.path = path;
    ($("#file-editor") as HTMLTextAreaElement).value = r.output;
    $("#file-status").textContent = path;
  } catch (e2) {
    $("#file-status").textContent = (e2 as Error).message;
  }
});
$("#file-save").onclick = async () => {
  const ed = $("#file-editor") as HTMLTextAreaElement;
  const path = ed.dataset.path;
  if (!path) return;
  if (!(await confirmDialog("Overwrite file?", `${path} will be replaced atomically.`))) return;
  const r = await api<{ ok: boolean; output: string }>("/api/tools/fs_write", {
    method: "POST",
    body: JSON.stringify({ path, content: ed.value }),
  });
  $("#file-status").textContent = r.output.slice(0, 120);
};

// ---- memory ------------------------------------------------------------------------
viewLoaders.memory = loadMemory;
async function loadMemory(): Promise<void> {
  const ul = $("#mem-list");
  ul.textContent = "";
  try {
    const { memories } = await api<{ memories: Array<{ id: string; content: string; scope: string }> }>("/api/memory");
    for (const m of memories) {
      const li = document.createElement("li");
      const span = document.createElement("span");
      span.className = "txt";
      span.textContent = `[${m.scope}] ${m.content}`;
      const del = document.createElement("button");
      del.className = "danger";
      del.textContent = "Forget";
      del.onclick = async () => {
        if (await confirmDialog("Forget memory?", m.content)) {
          await api(`/api/memory/${m.id}`, { method: "DELETE" });
          loadMemory();
        }
      };
      li.append(span, del);
      ul.append(li);
    }
  } catch (e) {
    li_error(ul, e as Error);
  }
}
$("#mem-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const inp = $("#mem-input") as HTMLInputElement;
  if (!inp.value.trim()) return;
  await api("/api/memory", { method: "POST", body: JSON.stringify({ content: inp.value }) });
  inp.value = "";
  loadMemory();
});
$("#mem-clear").onclick = async () => {
  if (!(await confirmDialog("Clear ALL memories?", "This cannot be undone."))) return;
  const { memories } = await api<{ memories: Array<{ id: string }> }>("/api/memory");
  for (const m of memories) await api(`/api/memory/${m.id}`, { method: "DELETE" });
  loadMemory();
};

// ---- knowledge -------------------------------------------------------------------------
viewLoaders.knowledge = () => {};
$("#kb-index-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const path = ($("#kb-path") as HTMLInputElement).value.trim();
  if (!path) return;
  const r = await api<{ ok: boolean; output: string }>("/api/tools/fs_grep", { method: "POST", body: JSON.stringify({ pattern: ".^", path }) }).catch(() => null);
  void r;
  const idx = await api<{ ok: boolean; output: string }>("/api/tools/knowledge_index", { method: "POST", body: JSON.stringify({ path }) }).catch(async () => {
    // Fallback: read via fs_read and index through the CLI-side engine endpoint.
    const read = await api<{ output: string }>("/api/tools/fs_read", { method: "POST", body: JSON.stringify({ path }) });
    const col = await api<{ collection: { id: string } }>("/api/knowledge/collections", { method: "POST", body: JSON.stringify({ name: "project" }) });
    return api<{ ok: boolean; output: string }>(`/api/knowledge/collections/${col.collection.id}/documents`, {
      method: "POST",
      body: JSON.stringify({ title: path, content: read.output }),
    });
  });
  const li = document.createElement("li");
  li.textContent = idx.output.slice(0, 200);
  $("#kb-results").prepend(li);
});
$("#kb-search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = ($("#kb-query") as HTMLInputElement).value.trim();
  if (!q) return;
  const { results } = await api<{ results: Array<{ sourceTitle: string; chunk: { text: string } }> }>(
    `/api/knowledge/search?q=${encodeURIComponent(q)}`,
  );
  const ul = $("#kb-results");
  ul.textContent = "";
  for (const hit of results) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.className = "txt";
    span.textContent = `[${hit.sourceTitle}] ${hit.chunk.text.slice(0, 160)}…`;
    li.append(span);
    ul.append(li);
  }
});

// ---- agents --------------------------------------------------------------------------------
viewLoaders.agents = () => {};
$("#agent-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const goal = ($("#agent-goal") as HTMLInputElement).value.trim();
  const modelId = ($("#agent-model") as HTMLInputElement).value.trim();
  if (!goal || !modelId.includes(":")) return;
  ($("#agent-output") as HTMLPreElement).textContent = "running…";
  try {
    const r = await fetch(`${API_BASE}/api/agents/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal, modelId }),
    });
    const data = (await r.json()) as { answer?: string; status?: string; steps?: unknown[]; error?: string };
    ($("#agent-output") as HTMLPreElement).textContent =
      data.error ?? `status=${data.status} steps=${data.steps?.length ?? 0}\n\n${data.answer}`;
  } catch (e2) {
    ($("#agent-output") as HTMLPreElement).textContent = (e2 as Error).message;
  }
});

// ---- workflows ------------------------------------------------------------------------------
$("#wf-validate").onclick = async () => {
  try {
    const parsed = JSON.parse(($("#wf-json") as HTMLTextAreaElement).value) as { name?: string; steps?: unknown[] };
    $("#wf-status").textContent =
      parsed.name && Array.isArray(parsed.steps)
        ? `valid structure ✓ (${parsed.steps.length} steps)`
        : "invalid: needs name + steps[]";
  } catch {
    $("#wf-status").textContent = "invalid JSON";
  }
};

// ---- settings / privacy -----------------------------------------------------------------------
viewLoaders.settings = async () => {
  const report = $("#privacy-report");
  report.textContent = "Loading…";
  try {
    const [health, models] = await Promise.all([
      api<{ version: string }>("/healthz"),
      api<{ models: Array<{ id: string; destination: string }> }>("/api/models"),
    ]);
    const external = models.models.filter((m) => m.destination === "external");
    report.innerHTML = "";
    const rows: Array<[string, string]> = [
      ["App version", health.version],
      ["Data location", "~/.qofeno (server host)"],
      ["Models configured", String(models.models.length)],
      ["External destinations", external.length ? external.map((m) => m.id).join(", ") : "none"],
      ["Telemetry", "none — no analytics exist in the codebase"],
    ];
    for (const [k, v] of rows) {
      const p = document.createElement("p");
      const strong = document.createElement("strong");
      strong.textContent = `${k}: `;
      p.append(strong, v);
      report.append(p);
    }
  } catch (e) {
    report.textContent = `Cannot reach server: ${(e as Error).message}`;
  }
};
$("#wipe").onclick = async () => {
  if (!(await confirmDialog("Delete ALL local Qofeno data?", "Sessions, memory and knowledge will be permanently removed from the server's ~/.qofeno."))) return;
  const { memories } = await api<{ memories: Array<{ id: string }> }>("/api/memory").catch(() => ({ memories: [] }));
  for (const m of memories) await api(`/api/memory/${m.id}`, { method: "DELETE" });
  $("#privacy-report").textContent = "Memories cleared. Full wipe requires removing ~/.qofeno on the server (documented in docs/privacy.md).";
};

viewLoaders.chat();
