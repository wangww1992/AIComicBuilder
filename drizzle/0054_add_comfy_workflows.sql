CREATE TABLE IF NOT EXISTS "comfy_workflows" (
	"id"	TEXT PRIMARY KEY NOT NULL,
	"project_id"	TEXT REFERENCES projects(id) ON DELETE CASCADE,
	"name"	TEXT NOT NULL,
	"capability"	TEXT NOT NULL,
	"workflow_json"	TEXT NOT NULL,
	"output_node_id"	TEXT,
	"created_at"	INTEGER NOT NULL
);
