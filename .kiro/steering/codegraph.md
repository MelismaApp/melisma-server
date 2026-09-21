# codegraph — Local Knowledge Graph

This project has a local knowledge graph at `codegraph-out/graph.json` served by the `codegraph` MCP server.

## You MUST use graph tools before exploring the codebase

Calling graph tools first reduces token usage significantly and surfaces cross-file relationships that file search cannot find:
- Symbol lookup → 90–99% fewer tokens
- Architecture questions → 60–80% fewer tokens
- Broad investigation → 40–60% fewer tokens

## Available MCP tools

| Tool | Purpose |
|---|---|
| `query_graph` | BFS search — find relevant nodes for any question |
| `get_neighbors` | All connections of a specific symbol |
| `shortest_path` | Dependency path between two symbols |
| `god_nodes` | Most connected core abstractions |
| `affected` | Blast radius — what references a symbol |
| `get_node` | Full detail for one node (file, line, edges) |
| `graph_stats` | Codebase structure overview |

## How to use

1. Call `query_graph` with the question or keyword first
2. Read only the 2–3 files the graph identifies as most relevant
3. Answer from that focused context

## Keeping the graph current

After editing source files:
```bash
codegraph update .   # incremental re-parse, only changed files
```

If `codegraph-out/graph.json` does not exist yet:
```bash
codegraph extract .  # full parse, run once after cloning
```
