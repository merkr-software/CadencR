//! Opt-in qualification of real tsgo traffic through the production proxy workers.
use super::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;
use tokio::process::Command;

struct Client {
    tx: futures::channel::mpsc::UnboundedSender<Result<Message, axum::Error>>,
    rx: mpsc::UnboundedReceiver<Message>,
}
impl Client {
    fn send(&self, value: Value) {
        self.tx
            .unbounded_send(Ok(Message::Text(value.to_string().into())))
            .unwrap();
    }
    async fn response(&mut self, id: u64) -> Value {
        tokio::time::timeout(std::time::Duration::from_secs(20), async {
            loop {
                let Message::Text(text) = self.rx.recv().await.unwrap() else {
                    continue;
                };
                let value: Value = serde_json::from_str(&text).unwrap();
                if value.get("method").is_none() && value["id"] == id {
                    assert!(value.get("error").is_none(), "LSP error: {value}");
                    return value["result"].clone();
                }
                if value.get("method").is_some() && value.get("id").is_some() {
                    let result = if value["method"] == "workspace/configuration" {
                        json!([{}])
                    } else {
                        Value::Null
                    };
                    self.send(json!({"jsonrpc":"2.0","id":value["id"],"result":result}));
                }
            }
        })
        .await
        .expect("tsgo proxy response timed out")
    }
    async fn diagnostics(&mut self, uri: &str, expected: Option<i64>, id: &mut u64) {
        let mut last = Value::Null;
        for _ in 0..40 {
            *id += 1;
            self.send(
                json!({"jsonrpc":"2.0","id":*id,"method":"textDocument/diagnostic",
                "params":{"textDocument":{"uri":uri}}}),
            );
            let result = self.response(*id).await;
            last = result.clone();
            let items = result["items"]
                .as_array()
                .expect("full tsgo diagnostic report");
            if expected.map_or(items.is_empty(), |code| {
                items.iter().any(|d| d["code"] == code)
            }) {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        }
        panic!(
            "filesystem watch did not update tsgo diagnostics to {expected:?}; last report: {last}"
        );
    }
}

fn verified_entry(path: &Path) -> Value {
    let recipe: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../plugins/lsp/native-recipes/tsgo.json"
    )))
    .unwrap();
    let target = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "darwin-aarch64",
        ("macos", "x86_64") => "darwin-x86_64",
        ("linux", "x86_64") => "linux-x86_64",
        _ => panic!("unsupported qualification host"),
    };
    let bytes = std::fs::read(path).unwrap();
    assert_eq!(
        Sha256::digest(&bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>(),
        recipe["targets"][target]["entry_sha256"]
    );
    recipe
}

#[tokio::test]
async fn real_tsgo_import_create_edit_delete_flows_through_proxy_watchers() {
    let Ok(entry) = std::env::var("CADENCR_TEST_TSGO_BIN") else {
        return;
    };
    let entry = Path::new(&entry).canonicalize().unwrap();
    let recipe = verified_entry(&entry);
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    std::fs::write(
        root.join("tsconfig.json"),
        r#"{"compilerOptions":{"strict":true,"noEmit":true},"include":["*.ts"]}"#,
    )
    .unwrap();
    let text = "import { value } from './dep';\nexport const result: string = value;\n";
    let file = root.join("main.ts");
    std::fs::write(&file, text).unwrap();
    let uri = reqwest::Url::from_file_path(&file).unwrap().to_string();
    let args: Vec<_> = recipe["args"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    let mut child = Command::new(&entry)
        .args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", &root)
        .env("TMPDIR", &root)
        .current_dir(&root)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let (tx, stream) = futures::channel::mpsc::unbounded();
    let (out, rx) = mpsc::unbounded_channel();
    let (activity, _) = watch::channel(Instant::now());
    let activity = Arc::new(activity);
    let (watchers, events) = SessionWatchers::new(vec![
        root.clone(),
        entry.parent().unwrap().parent().unwrap().to_path_buf(),
    ])
    .unwrap();
    let (replies, reply_rx) = mpsc::channel(32);
    let stdout = tokio::spawn(stdout_to_ws(
        child.stdout.take().unwrap(),
        out.clone(),
        activity.clone(),
        watchers.clone(),
        replies,
    ));
    let bridge = StdinBridge::builder()
        .stdin(child.stdin.take().unwrap())
        .activity(activity)
        .watchers(watchers)
        .events(events)
        .replies(reply_rx)
        .out(out)
        .build();
    let stdin = tokio::spawn(bridge.run(stream));
    let _tasks = ProxyTasks(vec![stdout.abort_handle(), stdin.abort_handle()]);
    let mut client = Client { tx, rx };
    client.send(
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "processId":null,"rootUri":reqwest::Url::from_directory_path(&root).unwrap().as_str(),
        "capabilities":{"workspace":{"configuration":true},"textDocument":{"diagnostic":{}}}}}),
    );
    client.response(1).await;
    client.send(json!({"jsonrpc":"2.0","method":"initialized","params":{}}));
    client.send(
        json!({"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{
        "uri":uri,"languageId":"typescript","version":1,"text":text}}}),
    );
    let mut id = 100;
    client.diagnostics(&uri, Some(2307), &mut id).await;
    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    std::fs::write(root.join("dep.ts"), "export const value = 'ok';\n").unwrap();
    client.diagnostics(&uri, None, &mut id).await;
    std::fs::write(root.join("dep.ts"), "export const value = 1;\n").unwrap();
    client.diagnostics(&uri, Some(2322), &mut id).await;
    std::fs::remove_file(root.join("dep.ts")).unwrap();
    client.diagnostics(&uri, Some(2307), &mut id).await;
    client.send(json!({"jsonrpc":"2.0","id":999,"method":"shutdown"}));
    client.response(999).await;
    client.send(json!({"jsonrpc":"2.0","method":"exit"}));
    child.kill().await.unwrap();
    child.wait().await.unwrap();
}
