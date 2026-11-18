// Guided tutorials on a real PostgreSQL running in the browser (PGlite).
// Each step: read the question, make a guess, run the SQL, then read the answer.
const CDN_URL = "https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.5.15/dist/index.js";

function fmt(results) {
  const list = Array.isArray(results) ? results : [results];
  const last = list.filter((r) => r && r.fields && r.fields.length).pop() || list[list.length - 1];
  if (!last || !last.rows || !last.rows.length) return "OK";
  const cols = last.fields.map((f) => f.name);
  if (cols.length === 1 && cols[0] === "QUERY PLAN") return last.rows.map((r) => r["QUERY PLAN"]).join("\n");
  const lines = [cols.join(" | ")];
  last.rows.forEach((r) => lines.push(cols.map((c) => (r[c] === null || r[c] === undefined ? "" : String(r[c]))).join(" | ")));
  return lines.join("\n");
}

function setup(tut) {
  const start = tut.querySelector(".tutstart");
  const status = tut.querySelector(".tutstatus");
  const steps = Array.from(tut.querySelectorAll(".tutstep"));
  let db = null;
  steps.forEach((s) => (s.querySelector("button").disabled = true));
  start.addEventListener("click", async () => {
    start.disabled = true;
    status.textContent = "Starting PostgreSQL in your browser. The first start downloads about 3 MB.";
    try {
      const mod = await import(CDN_URL);
      db = new mod.PGlite();
      await db.query("SELECT 1");
      status.textContent = "Running. Do the steps in order.";
      steps[0].querySelector("button").disabled = false;
    } catch (e) {
      status.textContent = "Could not start PostgreSQL here: " + e.message + ". The SQL on this page also runs in any psql session.";
      start.disabled = false;
    }
  });
  steps.forEach((s, i) => {
    const btn = s.querySelector("button");
    const out = s.querySelector("pre.res");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      out.textContent = "Running...";
      try {
        // One statement at a time: VACUUM cannot run inside the implicit
        // transaction that a multi-statement exec would open.
        const parts = s.querySelector("pre.sql").textContent.split(/;\s*(?:\n|$)/).map((x) => x.trim()).filter(Boolean);
        let last = null;
        for (const part of parts) last = await db.exec(part);
        out.textContent = fmt(last);
        s.classList.add("done");
        if (steps[i + 1]) steps[i + 1].querySelector("button").disabled = false;
      } catch (e) {
        out.textContent = "ERROR: " + e.message;
        btn.disabled = false;
      }
    });
  });
}

document.querySelectorAll(".tut").forEach(setup);
