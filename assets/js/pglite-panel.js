const CDN_URL = "https://cdn.jsdelivr.net/npm/@electric-sql/pglite/dist/index.js";

const SEED_SQL = "CREATE TABLE users (id integer PRIMARY KEY, name text); INSERT INTO users VALUES (10, 'User Ten'), (25, 'User TwentyFive'), (87, 'User EightySeven');";

const QUICK_SQL = {
  insert: "INSERT INTO users (id, name) VALUES (42, 'Asha');",
  select: "SELECT * FROM users ORDER BY id;",
  explain: "EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM users WHERE id = 42;",
};

function formatResult(sql, result) {
  const trimmed = sql.trim().toUpperCase();

  if (trimmed.startsWith("EXPLAIN")) {
    const lines = (result.rows || []).map(function (row) {
      const values = Object.values(row);
      return values.length > 0 ? String(values[0]) : "";
    });
    return lines.join("\n");
  }

  if (trimmed.startsWith("INSERT")) {
    const count =
      typeof result.affectedRows === "number" ? result.affectedRows : 1;
    return "INSERT 0 " + count;
  }

  const rows = result.rows || [];
  if (rows.length === 0) {
    return "No rows returned.";
  }
  return rows
    .map(function (row) {
      return Object.values(row)
        .map(function (value) {
          return value === null || value === undefined ? "" : String(value);
        })
        .join(" | ");
    })
    .join("\n");
}

function setupPanel(suffix) {
  const panel = document.getElementById("liveSql" + suffix);
  if (!panel) {
    return;
  }

  const status = document.getElementById("liveSqlStatus" + suffix);
  const input = document.getElementById("liveSqlInput" + suffix);
  const runButton = document.getElementById("liveSqlRun" + suffix);
  const startButton = document.getElementById("liveSqlStart" + suffix);
  const output = document.getElementById("liveSqlOut" + suffix);
  const quickButtons = panel.querySelectorAll("[data-sql]");

  if (!status || !input || !runButton || !startButton || !output) {
    return;
  }

  let db = null;
  let starting = false;

  runButton.disabled = true;
  quickButtons.forEach(function (button) {
    button.disabled = true;
  });

  function setOutput(text) {
    output.textContent = text;
  }

  async function runQuery(sql) {
    if (!db) {
      setOutput("Start live Postgres first, then run a query.");
      return;
    }
    if (!sql || !sql.trim()) {
      setOutput("Type or pick a query first.");
      return;
    }
    try {
      const result = await db.query(sql);
      setOutput(formatResult(sql, result));
    } catch (error) {
      const message =
        error && error.message ? error.message : String(error);
      setOutput("Error: " + message);
    }
  }

  async function startDatabase() {
    if (db || starting) {
      return;
    }
    starting = true;
    startButton.disabled = true;
    status.textContent = "Loading live Postgres. This takes a few seconds.";
    try {
      const module = await import(CDN_URL);
      const PGlite = module.PGlite;
      if (!PGlite) {
        throw new Error("The Postgres module did not load.");
      }
      const instance = new PGlite();
      if (instance.waitReady) {
        await instance.waitReady;
      }
      await instance.exec(SEED_SQL);
      db = instance;
      starting = false;
      status.textContent =
        "Live Postgres is ready. The users table holds ids 10, 25, and 87.";
      runButton.disabled = false;
      quickButtons.forEach(function (button) {
        button.disabled = false;
      });
      setOutput(
        "Ready. Pick Insert, Select, or Explain, or type a query and press Run."
      );
    } catch (error) {
      starting = false;
      status.textContent =
        "Live Postgres needs network access to load. The scripted walkthrough above still works.";
      startButton.disabled = true;
      if (error && error.message) {
        setOutput("Error: " + error.message);
      }
    }
  }

  startButton.addEventListener("click", function () {
    startDatabase().catch(function (error) {
      const message =
        error && error.message ? error.message : String(error);
      setOutput("Error: " + message);
    });
  });

  runButton.addEventListener("click", function () {
    runQuery(input.value).catch(function (error) {
      const message =
        error && error.message ? error.message : String(error);
      setOutput("Error: " + message);
    });
  });

  quickButtons.forEach(function (button) {
    button.addEventListener("click", function () {
      try {
        const kind = button.getAttribute("data-sql");
        const sql = QUICK_SQL[kind];
        if (!sql) {
          return;
        }
        input.value = sql;
        runQuery(sql).catch(function (error) {
          const message =
            error && error.message ? error.message : String(error);
          setOutput("Error: " + message);
        });
      } catch (error) {
        const message =
          error && error.message ? error.message : String(error);
        setOutput("Error: " + message);
      }
    });
  });
}

setupPanel("");
setupPanel("Pg");
