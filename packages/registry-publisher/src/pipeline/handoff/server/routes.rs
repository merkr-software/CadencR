use super::*;
use base64::Engine as _;

pub(super) fn route(
    state: &mut Value,
    method: &str,
    path: &str,
    query: &str,
    body: &[u8],
) -> Response {
    if path.starts_with("/raw/") {
        return if state["discovery"].is_object() && state["rawUnavailable"] != true {
            raw(bytes(&state["discovery"]["bytes"]))
        } else {
            json_response(404, json!({}))
        };
    }
    if path.starts_with("/public/") {
        return public(state, path);
    }
    if path.contains("/git/") {
        return git(state, method, path, body);
    }
    if path.ends_with("/contents/managed-index.json") {
        return discovery(state, method, body);
    }
    releases(state, method, path, query, body)
}
fn public(state: &Value, path: &str) -> Response {
    for source in state["sourceArchives"].as_array().unwrap() {
        if source[0] == path {
            return raw(bytes(&source[1]));
        }
    }
    for asset in state["assets"].as_array().unwrap() {
        let url = url::Url::parse(asset["browser_download_url"].as_str().unwrap()).unwrap();
        if format!(
            "/public{}",
            url.path().replace("cadencr/registry", "acme/registry")
        ) != path
        {
            continue;
        }
        let release = state["releases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == asset["release_id"])
            .unwrap();
        if release["draft"] == false && state["publicUnavailable"] != true {
            return raw(bytes(&asset["bytes"]));
        }
    }
    json_response(404, json!({}))
}
fn git(state: &mut Value, method: &str, path: &str, body: &[u8]) -> Response {
    if path.contains("/git/ref/heads/") {
        return json_response(
            200,
            json!({"ref":"refs/heads/main","object":{"type":"commit","sha":"b".repeat(40)}}),
        );
    }
    if path.contains("/git/commits/") {
        return json_response(
            200,
            json!({"sha":"b".repeat(40),"tree":{"sha":"d".repeat(40)}}),
        );
    }
    if path.contains("/git/trees/") {
        let tree = if state["discovery"].is_object() {
            json!([{"path":"managed-index.json","mode":"100644","type":"blob",
            "sha":state["discovery"]["sha"],"size":bytes(&state["discovery"]["bytes"]).len()}])
        } else {
            json!([])
        };
        return json_response(
            200,
            json!({"sha":"d".repeat(40),"truncated":false,"tree":tree}),
        );
    }
    if method == "POST" && path.ends_with("/git/refs") {
        let input: Value = serde_json::from_slice(body).unwrap();
        let tag = input["ref"]
            .as_str()
            .unwrap()
            .strip_prefix("refs/tags/")
            .unwrap();
        if state["tags"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r[0] == tag)
        {
            return json_response(422, json!({}));
        }
        state["tags"]
            .as_array_mut()
            .unwrap()
            .push(json!([tag, input["sha"]]));
        return json_response(
            201,
            json!({"ref":input["ref"],"object":{"type":"commit","sha":input["sha"]}}),
        );
    }
    if path.contains("/git/ref/tags/") {
        let tag = percent_encoding::percent_decode_str(path.rsplit('/').next().unwrap())
            .decode_utf8()
            .unwrap();
        if let Some(found) = state["tags"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r[0] == tag.as_ref())
        {
            return json_response(
                200,
                json!({"ref":format!("refs/tags/{tag}"),"object":{"type":"commit","sha":found[1]}}),
            );
        }
    }
    json_response(404, json!({}))
}
fn discovery(state: &mut Value, method: &str, body: &[u8]) -> Response {
    if method == "GET" {
        return if state["discovery"].is_object() {
            json_response(200, content(state))
        } else {
            json_response(404, json!({}))
        };
    }
    assert_eq!(method, "PUT");
    let input: Value = serde_json::from_slice(body).unwrap();
    if input["branch"] != "main" || input.get("sha") != state["discovery"].get("sha") {
        return json_response(409, json!({}));
    }
    let data = base64::prelude::BASE64_STANDARD
        .decode(input["content"].as_str().unwrap())
        .unwrap();
    let mut hash = sha1::Sha1::new();
    hash.update(format!("blob {}\0", data.len()));
    hash.update(&data);
    state["discovery"] = json!({"bytes":{"data":data},"sha":crate::hex(&hash.finalize())});
    json_response(
        200,
        json!({"content":content(state),"commit":{"sha":"c".repeat(40)}}),
    )
}
fn content(state: &Value) -> Value {
    let data = bytes(&state["discovery"]["bytes"]);
    json!({"type":"file","path":"managed-index.json","name":"managed-index.json","encoding":"base64",
        "content":base64::prelude::BASE64_STANDARD.encode(&data),"size":data.len(),"sha":state["discovery"]["sha"]})
}
fn releases(state: &mut Value, method: &str, path: &str, query: &str, body: &[u8]) -> Response {
    let root = "/api/repos/acme/registry/releases";
    if path == root {
        if method == "GET" {
            return json_response(
                200,
                if query.contains("page=2") {
                    json!([])
                } else {
                    state["releases"].clone()
                },
            );
        }
        let mut release: Value = serde_json::from_slice(body).unwrap();
        if state["releases"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["tag_name"] == release["tag_name"])
        {
            return json_response(422, json!({}));
        }
        release["id"] = state["nextReleaseId"].clone();
        state["nextReleaseId"] = json!(release["id"].as_u64().unwrap() + 1);
        state["releases"]
            .as_array_mut()
            .unwrap()
            .push(release.clone());
        return json_response(201, release);
    }
    if let Some(id) = path.strip_prefix(&format!("{root}/assets/")) {
        let id: u64 = id.parse().unwrap();
        return state["assets"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["id"] == id)
            .map_or_else(
                || json_response(404, json!({})),
                |asset| raw(bytes(&asset["bytes"])),
            );
    }
    let parts: Vec<_> = path.split('/').collect();
    let id: u64 = parts[6].parse().unwrap();
    if path.ends_with("/assets") && method == "GET" {
        let assets: Vec<_> = state["assets"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|a| a["release_id"] == id)
            .map(|a| {
                let mut a = a.clone();
                a.as_object_mut().unwrap().remove("bytes");
                a
            })
            .collect();
        return json_response(200, json!(assets));
    }
    let release = state["releases"]
        .as_array()
        .unwrap()
        .iter()
        .position(|r| r["id"] == id);
    let Some(index) = release else {
        return json_response(404, json!({}));
    };
    if path.starts_with("/uploads/") {
        let name = url::form_urlencoded::parse(query.as_bytes())
            .find(|(key, _)| key == "name")
            .unwrap()
            .1
            .into_owned();
        let tag = state["releases"][index]["tag_name"].as_str().unwrap();
        let asset = json!({"id":state["nextId"],"release_id":id,"name":name,"size":body.len(),"state":"uploaded",
            "browser_download_url":format!("https://github.com/cadencr/registry/releases/download/{tag}/{name}")});
        state["nextId"] = json!(asset["id"].as_u64().unwrap() + 1);
        let mut stored = asset.clone();
        stored["bytes"] = json!({"data":body});
        state["assets"].as_array_mut().unwrap().push(stored);
        return json_response(201, asset);
    }
    if method == "PATCH" {
        assert_eq!(
            serde_json::from_slice::<Value>(body).unwrap(),
            json!({"draft":false,"make_latest":"false"})
        );
        state["releases"][index]["draft"] = json!(false);
        state["releases"][index]["make_latest"] = json!("false");
    }
    json_response(200, state["releases"][index].clone())
}
