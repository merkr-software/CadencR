use std::future::Future;
use std::sync::Arc;

use rmcp::{
    handler::server::ServerHandler,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, ErrorData,
        ListToolsResult, PaginatedRequestParams, ServerInfo, Tool,
    },
    service::{RequestContext, RoleServer},
};
use serde_json::json;

use crate::domain::mcp::context::McpContext;
use crate::domain::mcp::tools::{
    browser::{
        external_open_url_allowed, open_url_allowed, BROWSER_OPEN_EXTERNAL_URL, BROWSER_TOOL_NAMES,
    },
    browser_bridge::{BrowserBridgeClient, BrowserBridgeRequest, BrowserBridgeResponse},
    helpers::{error_result, pinned_feature_id, text_result},
};

use super::server_info;

pub struct BrowserServer {
    ctx: Arc<McpContext>,
}

impl BrowserServer {
    pub fn new(ctx: Arc<McpContext>) -> Self {
        Self { ctx }
    }
}

fn make_tool(name: &'static str, description: &'static str, schema: serde_json::Value) -> Tool {
    let obj: serde_json::Map<String, serde_json::Value> =
        serde_json::from_value(schema).expect("schema must be an object");
    Tool::new(name, description, obj)
}

fn tools() -> Vec<Tool> {
    // Workspace/session tools are intentionally not exposed by
    // `cadencr-browser`. `list_conversations` and `read_conversation` will be
    // used later by a dedicated `cadencr-workspace` MCP server.
    BROWSER_TOOL_NAMES.into_iter().map(browser_tool).collect()
}

fn browser_tool(name: &'static str) -> Tool {
    make_tool(name, tool_description(name), tool_schema(name))
}

fn tool_description(name: &str) -> &'static str {
    match name {
        "browser_list_tabs" => "List open Browser workspace tabs with id, title, URL and load state.",
        "browser_open_url" => "Reuse the active Browser tab by default for a localhost or local file:// URL, or navigate an existing tab when tab_id is given. Pass new_tab:true only when you intentionally need another tab. Waits for the load to settle and returns the final URL and title. Only loopback (http/https) and file:// URLs are permitted; automation actions (click/fill/type/evaluate) still require a localhost tab.",
        "browser_open_external_url" => "Reuse the active Browser tab by default for an arbitrary external website (any http/https URL), or navigate an existing tab when tab_id is given. Pass new_tab:true only when you intentionally need another tab. Unlike browser_open_url this prompts for permission (per the agent's permission mode) because it reaches the open internet; once opened, the resulting tab can be fully automated (click/fill/type/evaluate). Use browser_open_url for localhost or file:// targets.",
        "browser_get_console" => "Return recent console entries from the active Browser tab. Filter with `level` (e.g. 'error') and cap with `limit` (default 50, newest last).",
        "browser_get_network" => "Return recent network requests from the active Browser tab. Filter with `failed_only` or `url_contains`, cap with `limit` (default 50). Headers are omitted unless `include_headers` is true.",
        "browser_get_snapshot" => "Preferred way to understand the page. Defaults to a compact accessibility-style outline where every interactive element has a stable [ref] (e1, e2, …) you pass to browser_click/browser_fill/browser_hover/browser_screenshot. Pass format:'html' for raw outerHTML. `selector` scopes to a subtree; output truncates to `max_length` with a `truncated` flag. Refs reset on navigation and on every snapshot — re-snapshot after the page changes.",
        "browser_screenshot" => "Capture a PNG screenshot of the active tab, returned as a viewable image. With `selector` or `ref` (from browser_get_snapshot) it captures just that element's region; or pass an explicit `clip`. The captured region is flashed live in the tab.",
        "browser_click" => "Click an element by `ref` or `selector` (preferred — it scrolls into view, centers and flashes the target), or fall back to viewport `x`/`y`. Requires the active tab to be localhost.",
        "browser_fill" => "Set the value of an input, textarea, select or contenteditable identified by `ref` or `selector`, firing input/change events so frameworks react. Requires the active tab to be localhost.",
        "browser_hover" => "Move the mouse over the element identified by `ref` or `selector` to reveal hover menus, tooltips or dropdowns. Requires the active tab to be localhost.",
        "browser_type" => "Insert text into the currently focused element. Prefer browser_fill for form fields. Requires the active tab to be localhost.",
        "browser_keypress" => "Press a single key such as 'Enter' or 'Tab'. Requires the active tab to be localhost.",
        "browser_wait_for" => "Wait until a `selector` appears or visible `text` is present (timeout_ms default 5000). Returns whether it appeared and how long it took — use it to confirm an action landed instead of polling screenshots.",
        "browser_evaluate" => "Run JavaScript in the active tab and return the value of the last expression. Requires the active tab to be localhost.",
        "browser_select_element_context" => "Ask the user to click an element in the Browser tab, then return its selector candidates, attributes, computed styles, a region screenshot and diagnostics.",
        _ => "Control or inspect the Cadencr Browser workspace tab.",
    }
}

fn tab_id_prop() -> serde_json::Value {
    json!({ "type": "string", "description": "Target tab id; defaults to the active tab." })
}

fn new_tab_prop() -> serde_json::Value {
    json!({
        "type": "boolean",
        "description": "Create another Browser tab instead of reusing the active tab. Prefer the default active tab reuse for linear workflows."
    })
}

fn tool_schema(name: &str) -> serde_json::Value {
    read_tool_schema(name).unwrap_or_else(|| action_tool_schema(name))
}

fn read_tool_schema(name: &str) -> Option<serde_json::Value> {
    let schema = match name {
        "browser_open_url" => json!({
            "type": "object",
            "properties": {
                "url": { "type": "string", "description": "Loopback URL (e.g. http://localhost:3000) or local file URL (e.g. file:///path/to/index.html) to open." },
                "tab_id": tab_id_prop(),
                "new_tab": new_tab_prop(),
            },
            "required": ["url"],
        }),
        "browser_open_external_url" => json!({
            "type": "object",
            "properties": {
                "url": { "type": "string", "description": "External website URL to open (e.g. https://example.com)." },
                "tab_id": tab_id_prop(),
                "new_tab": new_tab_prop(),
            },
            "required": ["url"],
        }),
        "browser_get_snapshot" => json!({
            "type": "object",
            "properties": {
                "tab_id": tab_id_prop(),
                "format": { "type": "string", "enum": ["outline", "html"], "description": "'outline' (default) returns a ref-annotated accessibility tree; 'html' returns raw outerHTML." },
                "selector": { "type": "string", "description": "Optional CSS selector to scope the snapshot to one element and its descendants." },
                "max_length": { "type": "number", "description": "Maximum characters to return (outline default 40000, html default 500000)." },
            },
        }),
        "browser_screenshot" => json!({
            "type": "object",
            "properties": {
                "tab_id": tab_id_prop(),
                "ref": { "type": "string", "description": "Element ref from a browser_get_snapshot outline; captures only that element's region." },
                "selector": { "type": "string", "description": "CSS selector; captures only that element's region." },
                "clip": {
                    "type": "object",
                    "description": "Explicit region in CSS pixels.",
                    "properties": {
                        "x": { "type": "number" },
                        "y": { "type": "number" },
                        "width": { "type": "number" },
                        "height": { "type": "number" },
                    },
                    "required": ["x", "y", "width", "height"],
                },
            },
        }),
        "browser_get_console" => json!({
            "type": "object",
            "properties": {
                "tab_id": tab_id_prop(),
                "level": { "type": "string", "description": "Only return entries at this level, e.g. 'error' or 'warning'." },
                "limit": { "type": "number", "description": "Maximum entries to return, newest last (default 50)." },
            },
        }),
        "browser_get_network" => json!({
            "type": "object",
            "properties": {
                "tab_id": tab_id_prop(),
                "failed_only": { "type": "boolean", "description": "Only return failed or 4xx/5xx requests." },
                "url_contains": { "type": "string", "description": "Only return requests whose URL contains this substring." },
                "include_headers": { "type": "boolean", "description": "Include request/response headers (omitted by default)." },
                "limit": { "type": "number", "description": "Maximum entries to return, newest last (default 50)." },
            },
        }),
        _ => return None,
    };
    Some(schema)
}

fn action_tool_schema(name: &str) -> serde_json::Value {
    match name {
        "browser_click" => json!({
            "type": "object",
            "properties": {
                "tab_id": tab_id_prop(),
                "ref": { "type": "string", "description": "Element ref from a browser_get_snapshot outline (preferred)." },
                "selector": { "type": "string", "description": "CSS selector for the element to click." },
                "x": { "type": "number", "description": "Click x in viewport CSS pixels (fallback when no ref/selector)." },
                "y": { "type": "number", "description": "Click y in viewport CSS pixels (fallback when no ref/selector)." },
            },
        }),
        "browser_fill" => json!({
            "type": "object",
            "properties": {
                "tab_id": tab_id_prop(),
                "ref": { "type": "string", "description": "Element ref from a browser_get_snapshot outline (preferred)." },
                "selector": { "type": "string", "description": "CSS selector for the field to fill." },
                "value": { "type": "string", "description": "Value to set on the field." },
            },
            "required": ["value"],
        }),
        "browser_hover" => json!({
            "type": "object",
            "properties": {
                "tab_id": tab_id_prop(),
                "ref": { "type": "string", "description": "Element ref from a browser_get_snapshot outline (preferred)." },
                "selector": { "type": "string", "description": "CSS selector for the element to hover." },
            },
        }),
        "browser_type" => json!({
            "type": "object",
            "properties": {
                "tab_id": tab_id_prop(),
                "text": { "type": "string", "description": "Text to insert into the focused element." },
            },
            "required": ["text"],
        }),
        "browser_keypress" => json!({
            "type": "object",
            "properties": {
                "tab_id": tab_id_prop(),
                "key": { "type": "string", "description": "Key to press, e.g. 'Enter' or 'Tab'." },
            },
            "required": ["key"],
        }),
        "browser_wait_for" => json!({
            "type": "object",
            "properties": {
                "tab_id": tab_id_prop(),
                "selector": { "type": "string", "description": "Wait until this CSS selector matches an element." },
                "text": { "type": "string", "description": "Wait until this text is visible on the page." },
                "timeout_ms": { "type": "number", "description": "Maximum time to wait in milliseconds (default 5000)." },
            },
        }),
        "browser_evaluate" => json!({
            "type": "object",
            "properties": {
                "tab_id": tab_id_prop(),
                "script": { "type": "string", "description": "JavaScript to evaluate; the value of the last expression is returned." },
            },
            "required": ["script"],
        }),
        _ => json!({
            "type": "object",
            "properties": { "tab_id": tab_id_prop() },
        }),
    }
}

fn bridge_result(response: BrowserBridgeResponse) -> CallToolResult {
    match response.image {
        // Never forward an empty image. An `input_image` with no base64 data is a
        // malformed data URI (`data:image/png;base64,`) that some models reject on
        // every subsequent turn, permanently wedging the conversation. The desktop
        // bridge already guards this, but enforce it at the MCP boundary too.
        Some(image) if !image.data.is_empty() => CallToolResult::success(vec![
            ContentBlock::image(image.data, image.mime_type),
            ContentBlock::text(response.text),
        ]),
        _ => text_result(&response.text),
    }
}

async fn run_browser_tool(name: &str, args: serde_json::Value, feature_id: i64) -> CallToolResult {
    if !BROWSER_TOOL_NAMES.contains(&name) {
        return error_result(&format!("Unknown tool: {name}"));
    }
    if name == "browser_open_url" || name == BROWSER_OPEN_EXTERNAL_URL {
        let Some(url) = args["url"].as_str() else {
            return error_result("Missing required parameter: url");
        };
        // Both openers validate the target up front under different policies:
        // browser_open_url allows loopback + file://, the external opener any web URL.
        let allowed = if name == BROWSER_OPEN_EXTERNAL_URL {
            external_open_url_allowed(url)
        } else {
            open_url_allowed(url)
        };
        if let Err(e) = allowed {
            return error_result(&e);
        }
    }
    let Some(client) = BrowserBridgeClient::from_env() else {
        return error_result("Browser MCP execution requires the desktop Browser bridge.");
    };
    match client
        .call(BrowserBridgeRequest::new(name, args, feature_id))
        .await
    {
        Ok(response) => bridge_result(response),
        Err(e) => error_result(&e),
    }
}

impl ServerHandler for BrowserServer {
    fn get_info(&self) -> ServerInfo {
        server_info("cadencr-browser")
    }

    fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<ListToolsResult, ErrorData>> + Send + '_ {
        std::future::ready(Ok(ListToolsResult::with_all_items(tools())))
    }

    fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> impl Future<Output = Result<CallToolResponse, ErrorData>> + Send + '_ {
        async move {
            let args = request
                .arguments
                .as_ref()
                .map(|m| serde_json::Value::Object(m.clone()))
                .unwrap_or(serde_json::Value::Null);
            if let Err(e) = pinned_feature_id(&args, self.ctx.feature_id) {
                return Ok(error_result(&e).into());
            }
            Ok(
                run_browser_tool(request.name.as_ref(), args, self.ctx.feature_id)
                    .await
                    .into(),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{tool_description, tool_schema, BROWSER_OPEN_EXTERNAL_URL};

    #[test]
    fn open_url_schemas_expose_new_tab_flag() {
        for name in ["browser_open_url", BROWSER_OPEN_EXTERNAL_URL] {
            let schema = tool_schema(name);
            let new_tab = &schema["properties"]["new_tab"];

            assert_eq!(new_tab["type"], "boolean");
            assert!(new_tab["description"]
                .as_str()
                .unwrap()
                .contains("active tab"));
        }
    }

    #[test]
    fn open_url_descriptions_prefer_active_tab_reuse() {
        for name in ["browser_open_url", BROWSER_OPEN_EXTERNAL_URL] {
            let description = tool_description(name);

            assert!(description.contains("Reuse"));
            assert!(description.contains("new_tab"));
        }
    }
}
