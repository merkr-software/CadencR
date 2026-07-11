use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Deserialize)]
pub(super) struct CodexItem {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub item_type: String,
    #[serde(default)]
    pub tool: Option<String>,
    #[serde(default)]
    pub namespace: Option<String>,
    #[serde(rename = "newThreadId", default)]
    pub new_thread_id: Option<String>,
    #[serde(rename = "receiverThreadIds", default)]
    pub receiver_thread_ids: Vec<String>,
    #[serde(rename = "agentsStates", default)]
    pub agents_states: Option<Map<String, Value>>,
    #[serde(rename = "agentThreadId", default)]
    pub agent_thread_id: Option<String>,
    #[serde(rename = "agentPath", default)]
    pub agent_path: Option<String>,
    #[serde(flatten)]
    pub fields: Map<String, Value>,
}

impl CodexItem {
    pub(super) fn id_or_fallback(&self) -> String {
        self.id.clone().unwrap_or_else(|| "codex_item".to_string())
    }

    pub(super) fn as_value(&self) -> Value {
        let mut fields = self.fields.clone();
        if let Some(id) = &self.id {
            fields.insert("id".to_string(), Value::String(id.clone()));
        }
        fields.insert("type".to_string(), Value::String(self.item_type.clone()));
        if let Some(tool) = &self.tool {
            fields.insert("tool".to_string(), Value::String(tool.clone()));
        }
        if let Some(namespace) = &self.namespace {
            fields.insert("namespace".to_string(), Value::String(namespace.clone()));
        }
        if let Some(new_thread_id) = &self.new_thread_id {
            fields.insert(
                "newThreadId".to_string(),
                Value::String(new_thread_id.clone()),
            );
        }
        if !self.receiver_thread_ids.is_empty() {
            fields.insert(
                "receiverThreadIds".to_string(),
                Value::Array(
                    self.receiver_thread_ids
                        .iter()
                        .map(|thread_id| Value::String(thread_id.clone()))
                        .collect(),
                ),
            );
        }
        if let Some(agents_states) = &self.agents_states {
            fields.insert(
                "agentsStates".to_string(),
                Value::Object(agents_states.clone()),
            );
        }
        if let Some(agent_thread_id) = &self.agent_thread_id {
            fields.insert(
                "agentThreadId".to_string(),
                Value::String(agent_thread_id.clone()),
            );
        }
        if let Some(agent_path) = &self.agent_path {
            fields.insert("agentPath".to_string(), Value::String(agent_path.clone()));
        }
        Value::Object(fields)
    }
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct CommandExecutionParams {
    pub item: CodexItem,
    #[serde(flatten)]
    raw_fields: Map<String, Value>,
}

impl CommandExecutionParams {
    pub(super) fn raw(&self) -> Value {
        envelope_raw(self.raw_fields.clone(), Some(self.item.clone()))
    }

    pub(super) fn into_raw(self) -> Value {
        envelope_raw(self.raw_fields, Some(self.item))
    }
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct ToolJsonDeltaParams {
    #[serde(rename = "itemId")]
    pub item_id: String,
    #[serde(default)]
    pub delta: MaybeValue,
    #[serde(default)]
    pub message: MaybeValue,
    #[serde(flatten)]
    raw_fields: Map<String, Value>,
}

impl ToolJsonDeltaParams {
    pub(super) fn raw(&self) -> Value {
        let mut fields = self.raw_fields.clone();
        fields.insert("itemId".to_string(), Value::String(self.item_id.clone()));
        if let MaybeValue::Present(delta) = &self.delta {
            fields.insert("delta".to_string(), delta.clone());
        }
        if let MaybeValue::Present(message) = &self.message {
            fields.insert("message".to_string(), message.clone());
        }
        Value::Object(fields)
    }

    pub(super) fn delta_value(&self) -> Value {
        self.delta_or_message().unwrap_or(Value::Null)
    }

    pub(super) fn delta_or_message(&self) -> Option<Value> {
        self.delta.value().or_else(|| self.message.value())
    }
}

#[derive(Debug, Clone, Default)]
pub(super) enum MaybeValue {
    #[default]
    Missing,
    Present(Value),
}

impl MaybeValue {
    fn value(&self) -> Option<Value> {
        match self {
            Self::Missing => None,
            Self::Present(value) => Some(value.clone()),
        }
    }
}

impl<'de> Deserialize<'de> for MaybeValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Value::deserialize(deserializer).map(Self::Present)
    }
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct FilePatchUpdatedParams {
    #[serde(rename = "itemId")]
    pub item_id: String,
    #[serde(default)]
    pub changes: Option<Vec<Value>>,
    #[serde(flatten)]
    raw_fields: Map<String, Value>,
}

impl FilePatchUpdatedParams {
    pub(super) fn raw(&self) -> Value {
        let mut fields = self.raw_fields.clone();
        fields.insert("itemId".to_string(), Value::String(self.item_id.clone()));
        if let Some(changes) = &self.changes {
            fields.insert("changes".to_string(), Value::Array(changes.clone()));
        }
        Value::Object(fields)
    }

    pub(super) fn changes_value(&self) -> Option<Value> {
        self.changes.clone().map(Value::Array)
    }
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct ItemParams {
    pub item: CodexItem,
    #[serde(flatten)]
    raw_fields: Map<String, Value>,
}

impl ItemParams {
    pub(super) fn thread_id(&self) -> Option<&str> {
        self.raw_fields.get("threadId").and_then(Value::as_str)
    }

    pub(super) fn into_raw(self) -> Value {
        envelope_raw(self.raw_fields, Some(self.item))
    }
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct RawResponseItem {
    #[serde(rename = "type")]
    pub item_type: String,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub call_id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub arguments: Option<Value>,
    #[serde(default)]
    pub input: Option<Value>,
    #[serde(default)]
    pub output: Option<Value>,
    #[serde(default)]
    pub execution: Option<Value>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub action: Option<Value>,
    #[serde(flatten)]
    fields: Map<String, Value>,
}

impl RawResponseItem {
    pub(super) fn as_value(&self) -> Value {
        let mut fields = self.fields.clone();
        fields.insert("type".to_string(), Value::String(self.item_type.clone()));
        insert_optional_string(&mut fields, "id", &self.id);
        insert_optional_string(&mut fields, "call_id", &self.call_id);
        insert_optional_string(&mut fields, "name", &self.name);
        insert_optional_value(&mut fields, "arguments", &self.arguments);
        insert_optional_value(&mut fields, "input", &self.input);
        insert_optional_value(&mut fields, "output", &self.output);
        insert_optional_value(&mut fields, "execution", &self.execution);
        insert_optional_string(&mut fields, "status", &self.status);
        insert_optional_value(&mut fields, "action", &self.action);
        Value::Object(fields)
    }
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct RawResponseItemParams {
    pub item: RawResponseItem,
    #[serde(flatten)]
    raw_fields: Map<String, Value>,
}

impl RawResponseItemParams {
    pub(super) fn raw(&self) -> Value {
        raw_response_envelope(self.raw_fields.clone(), self.item.clone())
    }
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct SerializedPermissionOption {
    pub decision: String,
    #[serde(default)]
    pub option_id: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub collect_feedback: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct SerializedPermissionRequest {
    pub request_id: String,
    #[serde(default)]
    pub tool_use_id: Option<String>,
    #[serde(default = "default_permission_tool_name")]
    pub tool_name: String,
    #[serde(default)]
    pub tool_input: Value,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub preview: Option<String>,
    #[serde(default)]
    pub options: Option<Vec<SerializedPermissionOption>>,
    #[serde(default)]
    pub supports_allow_future: Option<bool>,
}

pub(super) fn parse_command_execution_params(
    raw: Value,
) -> Result<CommandExecutionParams, serde_json::Error> {
    parse(raw)
}

pub(super) fn parse_tool_json_delta_params(
    raw: Value,
) -> Result<ToolJsonDeltaParams, serde_json::Error> {
    parse(raw)
}

pub(super) fn parse_file_patch_updated_params(
    raw: Value,
) -> Result<FilePatchUpdatedParams, serde_json::Error> {
    parse(raw)
}

pub(super) fn parse_item_params(raw: Value) -> Result<ItemParams, serde_json::Error> {
    parse(raw)
}

pub(super) fn parse_raw_response_item_params(
    raw: Value,
) -> Result<RawResponseItemParams, serde_json::Error> {
    parse(raw)
}

pub(super) fn parse_serialized_permission_request(
    raw: Value,
) -> Result<Option<SerializedPermissionRequest>, serde_json::Error> {
    if raw.get("type").and_then(Value::as_str) != Some("codex_permission_request") {
        return Ok(None);
    }
    parse(raw).map(Some)
}

fn parse<T: DeserializeOwned>(raw: Value) -> Result<T, serde_json::Error> {
    serde_json::from_value(raw)
}

fn envelope_raw(mut fields: Map<String, Value>, item: Option<CodexItem>) -> Value {
    if let Some(item) = item {
        fields.insert("item".to_string(), item.as_value());
    }
    Value::Object(fields)
}

fn raw_response_envelope(mut fields: Map<String, Value>, item: RawResponseItem) -> Value {
    fields.insert("item".to_string(), item.as_value());
    Value::Object(fields)
}

fn insert_optional_string(fields: &mut Map<String, Value>, key: &str, value: &Option<String>) {
    if let Some(value) = value {
        fields.insert(key.to_string(), Value::String(value.clone()));
    }
}

fn insert_optional_value(fields: &mut Map<String, Value>, key: &str, value: &Option<Value>) {
    if let Some(value) = value {
        fields.insert(key.to_string(), value.clone());
    }
}

fn default_permission_tool_name() -> String {
    "CodexRequest".to_string()
}
