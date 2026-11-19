# howdbswork MCP server

Lets an AI assistant (Claude, Cursor, any MCP client) answer database design
questions from the design docs, estimates and lessons on https://howdbswork.com.
No dependencies, Node 18 or newer, runs locally over stdio, sends nothing anywhere.

## Tools

- `recommend_store(workload)`: the matching design doc: what goes where and why, what breaks first, a link.
- `get_design(design)`: one design doc in full.
- `estimate(design, inputs)`: the Estimate it numbers for a design, with a link that opens them on the page.
- `find_lesson(topic)`: lessons that explain a database topic.

## Set up

    git clone https://github.com/dinesh082293/howdbswork.git

Claude Code:

    claude mcp add howdbswork -- node /path/to/howdbswork/mcp/server.mjs

Claude Desktop (`claude_desktop_config.json`) or Cursor (`.cursor/mcp.json`):

    { "mcpServers": { "howdbswork": { "command": "node", "args": ["/path/to/howdbswork/mcp/server.mjs"] } } }

## Updating the data

`data.json` and `estimate.js` are built from the site:

    python3 scripts/build-mcp-data.py

That also writes `llms.txt` at the site root.
